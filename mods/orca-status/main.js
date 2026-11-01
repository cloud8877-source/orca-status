// A live, read-only view of Orca and of every connected machine.
// Orca: its own CLI (`orca status`, `orca worktree ps`, `orca orchestration ...`).
// Machines: one `sh` sample per machine (Linux and macOS) for CPU, memory, disk,
// load, uptime and top processes, drawn as bars and a one-minute CPU history.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, machines, spaces, agents, window, shared, setShared, nextCommand } from "herdr";

const REFRESH_MS = 15000;
const MONITOR_MS = 5000;
const HISTORY = 30;
const RUN_LIMIT = 8;
const DONE_SHOWN = 4;
const RANK = { blocked: 4, waiting: 3, working: 2, done: 1 };
const TASK_RANK = { blocked: 0, failed: 1, dispatched: 2, ready: 3, pending: 4, completed: 5 };
const SPINNER = "mods/orca-status/spinner.svg";
const CHEVRON = "mods/orca-status";
const DEFAULT_VIEW = "orca";

// One machine's vitals as key=value lines. POSIX sh; Linux and macOS.
const STATS = `
os=$(uname -s)
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
now=$(date +%s)
if [ "$os" = Darwin ]; then
  set -- $(sysctl -n vm.loadavg 2>/dev/null)
  load=$2
  boot=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,}]' '{gsub(/ /,"",$2); print $2}')
else
  load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
  up=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
  boot=$((now - up))
fi
[ -n "$boot" ] || boot=$now
uptime=$((now - boot))
if [ -r /proc/stat ]; then
  set -- $(awk 'NR==1{printf "%d %d", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat)
  t1=$1; i1=$2
  sleep 0.4
  set -- $(awk 'NR==1{printf "%d %d", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat)
  cpu=$(awk -v a="$t1" -v b="$i1" -v c="$1" -v d="$2" 'BEGIN{dt=c-a; if(dt<=0) dt=1; v=(1-(d-b)/dt)*100; if(v<0) v=0; if(v>100) v=100; printf "%.1f", v}')
else
  cpu=$(iostat -w 1 -c 2 2>/dev/null | awk 'NR>2 && NF>=6 {printf "%.1f", $4+$5; exit}')
fi
if [ "$os" = Darwin ]; then
  set -- $(vm_stat 2>/dev/null | awk '
    /page size of/ {ps=$8+0}
    /Pages free/ {f=$3+0}
    /Pages inactive/ {i=$3+0}
    /Pages speculative/ {s=$3+0}
    END {printf "%d %d %d", ps, f, i+s}')
  psize=$1; freep=$2; inact=$3
  total=$(( $(sysctl -n hw.memsize 2>/dev/null) / 1048576 ))
  used=$(( total - (freep + inact) * psize / 1048576 ))
else
  set -- $(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "%d %d", t/1024, a/1024}' /proc/meminfo)
  total=$1; avail=$2
  used=$((total - avail))
fi
mem=$(awk -v u="$used" -v t="$total" 'BEGIN{printf "%d", (t>0 ? u*100/t : 0)}')
set -- $(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); printf "%d %d", $5, $2/1024}')
disk=$1; disktotal=$2
if [ "$os" = Darwin ]; then
  procs=$(ps -Ao pcpu=,pmem=,comm= -r 2>/dev/null | head -4)
else
  procs=$(ps -eo pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -4)
fi
echo "os=$os"
echo "cores=$cores"
echo "load=$load"
echo "uptime=$uptime"
echo "cpu=$cpu"
echo "mem=$mem"
echo "memused=$used"
echo "memtotal=$total"
echo "disk=$disk"
echo "disktotal=$disktotal"
echo "$procs" | awk 'NF {c=$1; m=$2; $1=""; $2=""; sub(/^ +/, ""); printf "proc\\t%s\\t%s\\t%s\\n", c, m, $0}'
`;

const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const stateColor = (state, t) => t[state] ?? (state === "waiting" ? (t.unknown ?? t.accent ?? t.muted) : t.dim);

function ago(ms, now) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function uptimeText(sec) {
  if (!sec || sec < 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function gig(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)}G` : `${Math.round(mb)}M`;
}

function procName(path) {
  const base = String(path).split("/").filter(Boolean).pop() ?? String(path);
  return base.length > 26 ? base.slice(0, 25) + "…" : base;
}

function parseStats(out) {
  const s = { procs: [] };
  for (const raw of String(out).split("\n")) {
    if (!raw) continue;
    if (raw.startsWith("proc\t")) {
      const parts = raw.split("\t");
      s.procs.push({ cpu: Number(parts[1]) || 0, mem: Number(parts[2]) || 0, name: parts.slice(3).join("\t") });
      continue;
    }
    const i = raw.indexOf("=");
    if (i > 0) s[raw.slice(0, i)] = raw.slice(i + 1).trim();
  }
  for (const key of ["cores", "load", "uptime", "cpu", "mem", "memused", "memtotal", "disk", "disktotal"]) {
    const n = Number(s[key]);
    s[key] = Number.isFinite(n) ? n : null;
  }
  return s;
}

function agentType(type) {
  const names = { claude: "Claude", pi: "Pi", codex: "Codex", gemini: "Gemini", opencode: "OpenCode", cursor: "Cursor", amp: "Amp", agy: "Agy" };
  return names[type] ?? (type ? type[0].toUpperCase() + type.slice(1) : "Agent");
}

function workspaceStatusLabel(status) {
  return ({ todo: "todo", "in-progress": "in progress", completed: "completed", done: "done" })[status] ?? status ?? "";
}

export default class OrcaStatus extends View {
  init(_props, cx) {
    this.snapshot = null;
    this.error = null;
    this.loadedAt = 0;
    this.loading = false;
    this.expandedAgents = new Set();
    this.expandedRuns = new Set();
    this.folded = new Set();
    this.showAllDone = false;
    this.showAllWorkspaces = false;

    this.view = shared("orca-status.view") === "machines" ? "machines" : DEFAULT_VIEW;
    this.byName = {};
    this.history = {};
    this.monAt = 0;
    this.monLoading = false;

    if (this.view === "machines") this.loadMachines(cx);
    else this.load(cx);
    cx.timer.every(REFRESH_MS, (cx) => { if (this.view === "orca") this.load(cx); });
    cx.timer.every(MONITOR_MS, (cx) => { if (this.view === "machines") this.loadMachines(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.setView(this.view === "machines" ? "orca" : "machines", cx);
      }
    });
  }

  setView(view, cx) {
    if (this.view === view) return;
    this.view = view;
    setShared("orca-status.view", view);
    cx.notify();
    const stale = view === "machines" ? Date.now() - this.monAt > MONITOR_MS : Date.now() - this.loadedAt > REFRESH_MS;
    if (stale) {
      if (view === "machines") this.loadMachines(cx);
      else this.load(cx);
    }
  }

  async orca(args) {
    const r = await exec("orca", args);
    if (r.code !== 0) {
      const line = clean(r.stderr || r.stdout) || `orca exited ${r.code}`;
      throw new Error(line.split("\n")[0]);
    }
    let data;
    try { data = JSON.parse(r.stdout); }
    catch { throw new Error("Orca returned output that isn't JSON"); }
    if (!data?.ok) throw new Error(clean(data?.error?.message) || "Orca returned an error");
    return data.result;
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [status, ps, runList] = await Promise.all([
          this.orca(["status", "--json"]).catch((e) => ({ error: String(e?.message ?? e) })),
          this.orca(["worktree", "ps", "--limit", "100", "--agent-wait", "--json"]),
          this.orca(["orchestration", "run-list", "--limit", String(RUN_LIMIT), "--json"]),
        ]);

        const runs = (runList.runs ?? []).slice(0, RUN_LIMIT);
        const details = await Promise.all(runs.map(async (run) => {
          try {
            const listed = await this.orca(["orchestration", "task-list", "--run", run.id, "--brief", "--json"]);
            const tasks = listed.tasks ?? [];
            let gates = [];
            // A settled Run has nothing left to decide; skip the extra call.
            if (tasks.some((t) => t.status !== "completed" && t.status !== "failed")) {
              try {
                const g = await this.orca(["orchestration", "gate-list", "--run", run.id, "--json"]);
                gates = g.gates ?? [];
              } catch { /* gates are extra: a listing failure shouldn't hide the Run */ }
            }
            return { run, tasks, gates, error: null };
          } catch (e) {
            return { run, tasks: [], gates: [], error: String(e?.message ?? e) };
          }
        }));

        const worktrees = (ps.worktrees ?? []).filter((w) => !w.isArchived).map((w) => ({
          id: w.worktreeId,
          name: clean(w.displayName) || clean(w.repo) || clean(w.path.split("/").pop()),
          branch: (w.branch ?? "").replace(/^refs\/heads\//, ""),
          status: w.workspaceStatus,
          active: Boolean(w.isActive),
          unread: Boolean(w.unread),
          live: w.liveTerminalCount ?? 0,
          lastActivityAt: w.lastActivityAt ?? 0,
          agents: (w.agents ?? []).map((a) => ({
            key: `${w.worktreeId}:${a.paneKey}`,
            state: a.state ?? "done",
            type: a.agentType ?? "agent",
            prompt: clean(a.prompt),
            task: clean(a.taskTitle || a.displayName),
            message: a.lastAssistantMessage ?? "",
            startedAt: a.stateStartedAt ?? 0,
            updatedAt: a.updatedAt ?? 0,
            tool: a.toolName ?? "",
            toolInput: clean(a.toolInput),
            worktree: clean(w.displayName) || clean(w.repo) || "",
            path: w.path ?? "",
          })),
        }));

        const runRows = details.map(({ run, tasks, gates, error }) => {
          const counts = { pending: 0, ready: 0, dispatched: 0, completed: 0, failed: 0, blocked: 0 };
          for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status] += 1;
          const total = tasks.length;
          const finished = counts.completed + counts.failed;
          const bad = counts.failed + counts.blocked;
          const pendingGates = gates.filter((g) => g.status === "pending").length;
          const state = bad ? "blocked" : total && finished === total ? "complete" : total ? "active" : "empty";
          return {
            id: run.id,
            objective: clean(run.objective) || "Untitled run",
            createdAt: Date.parse(run.created_at) || 0,
            updatedAt: Date.parse(run.updated_at) || 0,
            tasks,
            total,
            finished,
            bad,
            pendingGates,
            state,
            error,
          };
        }).sort((a, b) => b.createdAt - a.createdAt);

        const agentList = worktrees.flatMap((w) => w.agents);
        this.snapshot = {
          status,
          worktrees,
          agents: agentList,
          runs: runRows,
        };
        this.error = null;
      } catch (e) {
        this.error = clean(e?.message ?? String(e)) || "Orca didn't answer";
      } finally {
        this.loading = false;
        this.loadedAt = Date.now();
        cx.notify();
      }
    });
  }

  loadMachines(cx) {
    if (this.monLoading) return;
    this.monLoading = true;
    cx.spawn(async (cx) => {
      try {
        const targets = machines();
        const rows = await Promise.all(targets.map(async (m) => {
          const key = m.name ?? "";
          // An unavailable core can't run anything for us; don't wait for the timeout.
          if (m.layout === "unavailable") return { key, stats: null, error: null, offline: true, at: Date.now() };
          try {
            const r = await exec("sh", ["-c", STATS], { on: m.name });
            if (r.code !== 0) {
              const line = (r.stderr || r.stdout).split("\n").find((l) => clean(l)) ?? "";
              throw new Error(clean(line) || `stats exited ${r.code}`);
            }
            return { key, stats: parseStats(r.stdout), error: null, offline: false, at: Date.now() };
          } catch (e) {
            return { key, stats: null, error: clean(e?.message ?? String(e)) || "unreachable", offline: false, at: Date.now() };
          }
        }));
        const byName = {};
        for (const row of rows) {
          byName[row.key] = row;
          if (row.stats && row.stats.cpu !== null) {
            const hist = this.history[row.key] ?? (this.history[row.key] = []);
            hist.push(row.stats.cpu);
            while (hist.length > HISTORY) hist.shift();
          }
        }
        this.byName = byName;
        this.monAt = Date.now();
      } catch (e) {
        console.log(`orca-status: machine sample failed: ${e}`);
      } finally {
        this.monLoading = false;
        cx.notify();
      }
    });
  }

  toggle(set, key, cx) {
    if (set.has(key)) set.delete(key);
    else set.add(key);
    cx.notify();
  }

  localName() {
    const platform = window()?.platform;
    return platform === "macos" ? "This Mac" : platform === "windows" ? "This PC" : "This machine";
  }

  stateDot(state, t, size = 7) {
    const color = t[state] ?? t.dim;
    if (state === "working") return svg(SPINNER).size(size + 5).flex_none().text_color(t.working).spin(900);
    if (state === "blocked") return div().size(size + 4).flex_none().rounded(3).bg(t.blocked + "26").text_size(9).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (state === "waiting") return div().size(size).flex_none().rounded(4).border(1.5).border_color(t.accent ?? t.muted);
    return div().size(size).flex_none().rounded(4).bg(color);
  }

  machineDot(state, t) {
    if (state === "live") return div().size(7).flex_none().rounded(4).bg(t.done);
    if (state === "error") return div().size(7).flex_none().rounded(4).bg(t.blocked);
    if (state === "offline") return div().size(7).flex_none().rounded(4).bg(t.dim);
    return svg(SPINNER).size(11).flex_none().text_color(t.working).spin(900);
  }

  chip(label, color, bg = false) {
    return div()
      .px(6).h(17).rounded(4).flex().items_center().text_size(10).font_medium()
      .when(bg, (el) => el.bg(color + "22"))
      .text_color(color)
      .child(label);
  }

  sectionHeader(id, label, right, t) {
    const open = !this.folded.has(id);
    return h_flex()
      .id(`orca-sec-${id}`)
      .px(10).pt(10).pb(4).gap(6).items_center().cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.toggle(this.folded, id, cx))
      .child(svg(`${CHEVRON}/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(10.5).font_medium().text_color(t.dim).child(label.toUpperCase()))
      .when(Boolean(right), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(right)))
      .child(div().flex_1());
  }

  /* ---------- the header: view switch, health, refresh ---------- */

  viewPill(id, label, t) {
    const active = this.view === id;
    return div()
      .id(`orca-view-${id}`)
      .h(22).px(9).rounded(6).flex().items_center().cursor_pointer().text_size(11)
      .when(active, (el) => el.bg(t.raised).text_color(t.foreground).font_medium())
      .when(!active, (el) => el.text_color(t.dim))
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .tooltip(id === "machines" ? "CPU, memory and disk of every machine" : "Orca agents, runs and workspaces")
      .on_click((_e, cx) => this.setView(id, cx))
      .child(label);
  }

  health(t) {
    if (this.view === "machines") {
      const list = machines();
      let live = 0;
      for (const m of list) {
        const e = this.byName[m.name ?? ""];
        if (e?.stats && !e.error) live += 1;
      }
      const color = live === 0 ? t.blocked : live === list.length ? t.done : t.working;
      return h_flex().gap(5).items_center()
        .child(div().size(6).flex_none().rounded(3).bg(color))
        .child(div().text_size(10.5).text_color(color).child(`${live}/${list.length} online`));
    }
    const status = this.snapshot?.status && !this.snapshot.status.error ? this.snapshot.status : null;
    const runtime = status?.runtime?.state ?? (status ? "offline" : null);
    const ready = status?.app?.running && runtime === "ready";
    const color = this.error ? t.blocked : ready ? t.done : t.working;
    const word = this.error ? "unreachable" : !status ? "status unknown" : ready ? "ready" : runtime ?? "starting";
    return h_flex().gap(5).items_center()
      .child(div().size(6).flex_none().rounded(3).bg(color))
      .child(div().text_size(10.5).text_color(color).child(word));
  }

  header(t) {
    const busy = this.view === "machines" ? this.monLoading : this.loading;
    return h_flex()
      .h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .child(this.viewPill("orca", "Orca", t))
      .child(this.viewPill("machines", "Machines", t))
      .child(div().flex_1())
      .child(this.health(t))
      .child(
        div()
          .id("orca-refresh")
          .size(24).flex().items_center().justify_center().rounded(6)
          .text_size(14).text_color(busy ? t.working : t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => (this.view === "machines" ? this.loadMachines(cx) : this.load(cx)))
          .tooltip("Refresh now")
          .child(busy ? svg(SPINNER).size(12).flex_none().text_color(t.working).spin(900) : "↻"),
      );
  }

  /* ---------- machines ---------- */

  metric(label, value, text, color, t) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    const tone = v >= 90 ? t.blocked : color;
    return h_flex().gap(7).items_center()
      .child(div().w(30).flex_none().text_size(9).font_medium().text_color(t.dim).child(label))
      .child(
        div().flex_1().min_w(0).h(5).rounded(3).bg(t.raised).overflow_hidden()
          .child(div().h_full().w(`${v}%`).rounded(3).bg(tone)),
      )
      .child(div().w(96).flex_none().text_right().truncate().text_size(9.5).text_color(t.muted).child(text));
  }

  spark(hist, t) {
    // Always 30 slots, newest on the right, so the strip reads as a timeline
    // from the first sample instead of growing a bar at a time.
    const have = hist ?? [];
    const bars = new Array(Math.max(0, HISTORY - have.length)).fill(null).concat(have);
    return h_flex().flex_1().min_w(0).h(15).gap(1).items_end().children(
      bars.map((v, i) =>
        v === null
          ? div().flex_1().min_w(0).h(1).rounded(1).bg(t.raised)
          : div()
            .flex_1().min_w(0)
            .h(Math.max(1, Math.round((Math.min(100, Math.max(0, v)) / 100) * 15)))
            .rounded(1)
            .bg(v >= 90 ? t.blocked : t.working + (i === bars.length - 1 ? "" : "88"))),
    );
  }

  procRow(p, t) {
    return h_flex().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(procName(p.name)))
      .child(div().w(36).flex_none().text_right().text_size(9.5).text_color(p.cpu >= 25 ? t.working : t.dim).child(`${p.cpu.toFixed(1)}%`));
  }

  machineCard(m, t, now, info) {
    const key = m.name ?? "";
    const entry = this.byName[key];
    const stats = entry?.stats ?? null;
    const state = m.layout === "unavailable" || entry?.offline ? "offline" : entry?.error ? "error" : stats ? "live" : "loading";
    const name = key || this.localName();
    const right = state === "live" ? uptimeText(stats?.uptime) : state === "offline" ? "offline" : state === "error" ? "failed" : "…";

    const head = h_flex().gap(7).items_center()
      .child(this.machineDot(state, t))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12.5)
        .text_color(state === "live" ? t.foreground : t.muted).child(name))
      .child(div().text_size(9.5).text_color(state === "error" ? t.blocked : t.dim).child(right));

    const body = state === "live"
      ? v_flex().gap(5)
        .child(this.metric("CPU", stats.cpu, `${Math.round(stats.cpu)}%`, t.working, t))
        .child(this.metric("MEM", stats.mem, `${stats.mem}% · ${gig(stats.memused)}/${gig(stats.memtotal)}`, t.accent, t))
        .child(this.metric("DISK", stats.disk, `${stats.disk}% · ${gig((stats.disktotal * stats.disk) / 100)}/${gig(stats.disktotal)}`, t.done, t))
        .child(
          h_flex().gap(8).items_center()
            .child(this.spark(this.history[key], t))
            .child(div().w(96).flex_none().text_right().text_size(9).text_color(t.dim)
              .child(`load ${stats.load ?? "—"} · ${stats.cores ?? "?"}c`)),
        )
        .child(
          h_flex().gap(6).items_center().pt(1)
            .child(div().flex_1().text_size(8.5).font_medium().text_color(t.dim).child("TOP PROCESSES"))
            .child(div().w(36).flex_none().text_right().text_size(8.5).font_medium().text_color(t.dim).child("CPU")),
        )
        .children((stats.procs ?? []).slice(0, 3).map((p) => this.procRow(p, t)))
      : v_flex().gap(3)
        .when(state === "error", (el) => el.child(div().truncate().text_size(10).text_color(t.blocked).tooltip(entry?.error ?? "").child(entry?.error ?? "unreachable")))
        .when(state === "offline", (el) => el.child(div().text_size(10).text_color(t.dim).child("Herdr can't reach this machine's core.")))
        .when(state === "loading", (el) => el.child(div().text_size(10).text_color(t.dim).child("Reading CPU, memory and disk…")));

    return v_flex()
      .id(`orca-machine-${key || "local"}`)
      .mx(6).mb(6).px(9).py(8).gap(6).rounded(8)
      .bg(t.surface).border_1().border_color(t.border)
      .when(state === "error", (el) => el.border_color(t.blocked + "55"))
      .child(head)
      .child(body)
      .when(state === "live", (el) => el.child(
        h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(9.5).text_color(t.dim)
            .child(`${info.spaces ?? 0} space${info.spaces === 1 ? "" : "s"} · ${info.agents ?? 0} agent${info.agents === 1 ? "" : "s"}`))
          .when((info.working ?? 0) > 0, (x) => x.child(div().text_size(9.5).text_color(t.working).child(`${info.working} working`)))
          .when((info.blocked ?? 0) > 0, (x) => x.child(div().text_size(9.5).font_medium().text_color(t.blocked).child(`${info.blocked} needs you`))),
      ));
  }

  machinesView(t, now) {
    const list = machines().slice().sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : a.name.localeCompare(b.name)));
    const spaceMachine = {};
    for (const s of spaces()) spaceMachine[s.id] = s.machine ?? "";
    const info = {};
    const infoOf = (key) => info[key] ?? (info[key] = { spaces: 0, agents: 0, working: 0, blocked: 0, done: 0 });
    for (const s of spaces()) infoOf(s.machine ?? "").spaces += 1;
    for (const a of agents()) {
      const i = infoOf(spaceMachine[a.space] ?? "");
      i.agents += 1;
      if (i[a.status] !== undefined) i[a.status] += 1;
    }

    const totals = Object.values(info).reduce((acc, i) => ({
      spaces: acc.spaces + i.spaces,
      agents: acc.agents + i.agents,
      working: acc.working + (i.working ?? 0),
      blocked: acc.blocked + (i.blocked ?? 0),
    }), { spaces: 0, agents: 0, working: 0, blocked: 0 });

    const summary = h_flex().flex_none().px(14).py(7).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(10.5).text_color(t.dim).child(`${totals.spaces} space${totals.spaces === 1 ? "" : "s"}`))
      .child(div().text_size(10.5).text_color(t.dim).child("·"))
      .child(div().text_size(10.5).text_color(t.dim).child(`${totals.agents} agent${totals.agents === 1 ? "" : "s"}`))
      .when(totals.working > 0, (el) => el
        .child(div().text_size(10.5).text_color(t.dim).child("·"))
        .child(div().text_size(10.5).text_color(t.working).child(`${totals.working} working`)))
      .when(totals.blocked > 0, (el) => el
        .child(div().text_size(10.5).text_color(t.dim).child("·"))
        .child(div().text_size(10.5).font_medium().text_color(t.blocked).child(`${totals.blocked} needs you`)))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(this.monAt ? ago(this.monAt, now) : ""));

    return v_flex().flex_1().min_h(0)
      .child(summary)
      .child(
        div().id("orca-machines").flex_1().min_h(0).overflow_y_scrollbar().pt(6)
          .children(list.map((m) => this.machineCard(m, t, now, info[m.name ?? ""] ?? {})))
          .child(div().h(2)),
      );
  }

  /* ---------- Orca ---------- */

  agentRow(a, t, now) {
    const open = this.expandedAgents.has(a.key);
    const age = ago(a.state === "done" ? a.updatedAt : a.startedAt, now);
    const title = a.task || a.prompt || "Agent";
    const details = [];
    if (open) {
      if (a.prompt && a.prompt !== title) details.push(["PROMPT", a.prompt]);
      if (a.message) details.push(["LAST MESSAGE", a.message.length > 900 ? a.message.slice(0, 900) + "…" : a.message]);
      if (a.tool && a.toolInput) details.push(["TOOL", `${agentType(a.type)} · ${a.tool} ${a.toolInput}`]);
      if (a.path) details.push(["PATH", a.path]);
    }
    return v_flex()
      .id(`orca-agent-${a.key}`)
      .mx(6).px(8).py(6).gap(3).rounded(8).cursor_pointer()
      .when(a.state === "blocked", (el) => el.bg(t.blocked + "12"))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(this.expandedAgents, a.key, cx))
      .tooltip(open ? "Hide details" : "Show details")
      .child(
        h_flex().gap(8).items_center()
          .child(this.stateDot(a.state, t))
          .child(
            v_flex().flex_1().min_w(0).gap(1)
              .child(div().truncate().text_color(a.state === "done" ? t.muted : t.foreground).child(title))
              .child(
                h_flex().gap(5).items_center()
                  .child(this.chip(agentType(a.type), t.dim))
                  .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(a.worktree))
                  .when(a.state === "blocked", (el) => el.child(div().text_size(10.5).font_medium().text_color(t.blocked).child("needs you"))),
              ),
          )
          .child(div().text_size(10.5).text_color(t.dim).child(age)),
      )
      .when(open && details.length > 0, (el) => el.child(
        v_flex().pl(23).pr(2).pb(3).gap(7).children(details.map(([label, text]) =>
          v_flex().gap(2)
            .child(div().text_size(9).font_medium().text_color(t.dim).child(label))
            .child(div().text_size(11.5).text_color(label === "LAST MESSAGE" ? t.muted : t.foreground).child(text)),
        )),
      ));
  }

  runRow(run, t, now) {
    const open = this.expandedRuns.has(run.id);
    const color = run.state === "blocked" ? t.blocked : run.state === "complete" ? t.done : run.state === "active" ? t.working : t.dim;
    const pct = run.total ? Math.round((run.finished / run.total) * 100) : 0;
    const label = run.state === "blocked" ? `${run.bad} issue${run.bad === 1 ? "" : "s"}` : run.state === "complete" ? "complete" : run.state === "active" ? "running" : "no tasks";
    const tasks = [...run.tasks].sort((a, b) => (TASK_RANK[a.status] ?? 9) - (TASK_RANK[b.status] ?? 9) || String(a.id).localeCompare(String(b.id)));
    return v_flex()
      .id(`orca-run-${run.id}`)
      .mx(6).px(8).py(7).gap(5).rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(this.expandedRuns, run.id, cx))
      .tooltip(open ? "Hide tasks" : "Show tasks")
      .child(
        h_flex().gap(7).items_center()
          .child(svg(`${CHEVRON}/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(run.objective))
          .child(this.chip(label, color, run.state !== "complete")),
      )
      .child(
        h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).h(3).rounded(2).bg(t.raised).overflow_hidden().child(
            div().h_full().w(`${pct}%`).rounded(2).bg(color),
          ))
          .child(div().text_size(10.5).text_color(t.muted).child(run.total ? `${run.finished}/${run.total}` : "—"))
          .child(div().text_size(10.5).text_color(t.dim).child(ago(run.updatedAt || run.createdAt, now))),
      )
      .when(run.pendingGates > 0, (el) => el.child(
        div().pl(17).text_size(10.5).font_medium().text_color(t.accent).child(`${run.pendingGates} decision${run.pendingGates === 1 ? "" : "s"} waiting`),
      ))
      .when(run.error, (el) => el.child(div().pl(17).text_size(10.5).text_color(t.blocked).child(run.error)))
      .when(open, (el) => el.child(
        v_flex().pl(17).pt(2).gap(2)
          .child(div().pb(2).text_size(11).text_color(t.muted).child(run.objective))
          .when(run.tasks.length === 0 && !run.error, (x) => x.child(div().text_size(10.5).text_color(t.dim).child("No tasks in this run")))
          .children(tasks.map((task) => {
            const c = task.status === "completed" ? t.done
              : task.status === "failed" || task.status === "blocked" ? t.blocked
              : task.status === "ready" || task.status === "dispatched" ? t.working
              : t.dim;
            return h_flex().gap(6).items_center()
              .child(div().size(5).flex_none().rounded(3).bg(c))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(task.status === "completed" ? t.muted : t.foreground).child(clean(task.display_name || task.task_title) || "Untitled task"))
              .child(div().text_size(9.5).text_color(c).child(task.status));
          })),
      ));
  }

  workspaceRow(w, t, now) {
    const status = workspaceStatusLabel(w.status);
    const color = w.status === "completed" || w.status === "done" ? t.done : w.status === "in-progress" ? t.working : t.dim;
    return h_flex()
      .id(`orca-wt-${w.id}`)
      .mx(6).px(8).py(5).gap(7).rounded(7).items_center()
      .child(div().size(5).flex_none().rounded(3).bg(color))
      .child(
        v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(5).items_center()
            .child(div().truncate().text_color(w.active ? t.foreground : t.muted).child(w.name))
            .when(w.unread, (el) => el.child(div().size(5).flex_none().rounded(3).bg(t.accent))))
          .child(div().truncate().text_size(10).text_color(t.dim).child([w.branch, status].filter(Boolean).join(" · "))),
      )
      .child(div().text_size(10).text_color(w.live ? t.muted : t.dim).child(w.live ? `${w.live} live` : "idle"))
      .child(div().text_size(10).text_color(t.dim).child(ago(w.lastActivityAt, now)));
  }

  orcaView(t, now) {
    const s = this.snapshot;
    const health = s?.status && !s.status.error ? s.status : null;
    const runtime = health?.runtime?.state ?? (health ? "offline" : null);
    const graph = health?.graph?.state ?? null;
    const version = health?.runtime?.appVersion ?? "";

    if (!s) {
      return v_flex().flex_1().min_h(0)
        .child(
          v_flex().flex_1().items_center().justify_center().gap(10)
            .when(Boolean(this.error), (el) => el
              .child(div().text_size(12).text_color(t.blocked).child(this.error))
              .child(div().id("orca-retry").px(10).py(4).rounded(6).bg(t.raised).text_size(11).text_color(t.foreground).cursor_pointer().on_click((_e, cx) => this.load(cx)).child("Retry")))
            .when(!this.error, (el) => el
              .child(svg(SPINNER).size(20).flex_none().text_color(t.working).spin(900))
              .child(div().text_size(11.5).text_color(t.dim).child("Reading Orca…"))),
        );
    }

    const list = s.agents;
    const counts = { working: 0, waiting: 0, blocked: 0, done: 0 };
    for (const a of list) if (counts[a.state] !== undefined) counts[a.state] += 1;
    const active = list.filter((a) => a.state !== "done").sort((a, b) => (RANK[b.state] ?? 0) - (RANK[a.state] ?? 0) || b.startedAt - a.startedAt);
    const done = list.filter((a) => a.state === "done").sort((a, b) => b.updatedAt - a.updatedAt);
    const shownDone = this.showAllDone ? done : done.slice(0, DONE_SHOWN);
    const liveWorktrees = s.worktrees.filter((w) => w.live > 0 || w.active || w.unread)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.lastActivityAt - a.lastActivityAt);
    const shownWorktrees = this.showAllWorkspaces ? liveWorktrees : liveWorktrees.slice(0, 6);
    const runs = s.runs;

    const counter = (state, label) => h_flex().gap(4).items_center()
      .child(counts[state] ? this.stateDot(state, t, 6) : div().size(6).flex_none().rounded(3).bg(t.dim))
      .child(div().text_size(11).text_color(counts[state] ? stateColor(state, t) : t.dim).child(`${counts[state]} ${label}`));

    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.error), (el) => el.child(
        h_flex().flex_none().px(12).py(7).gap(8).items_center().bg(t.blocked + "18").border_b(1).border_color(t.border)
          .child(div().text_size(11).text_color(t.blocked).child("!"))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.blocked).child(this.error))
          .child(div().id("orca-retry-banner").px(6).py(2).rounded(4).text_size(10).text_color(t.foreground).cursor_pointer().on_click((_e, cx) => this.load(cx)).child("Retry")),
      ))
      .child(
        h_flex().flex_none().px(14).py(7).gap(6).items_center().border_b(1).border_color(t.border)
          .child(div().text_size(10.5).text_color(t.dim).child(version ? `v${version}` : "Orca"))
          .child(div().text_size(10.5).text_color(t.dim).child("·"))
          .child(div().text_size(10.5).text_color(t.dim).child(runtime === "ready" ? "runtime ready" : `runtime ${runtime ?? "unknown"}`))
          .when(Boolean(graph), (el) => el
            .child(div().text_size(10.5).text_color(t.dim).child("·"))
            .child(div().text_size(10.5).text_color(graph === "ready" ? t.dim : t.blocked).child(`graph ${graph}`)))
          .child(div().flex_1())
          .child(div().text_size(10.5).text_color(t.dim).child(this.loadedAt ? ago(this.loadedAt, now) : "")),
      )
      .child(
        h_flex().flex_none().flex_wrap().px(14).py(9).gap(12).items_center().border_b(1).border_color(t.border)
          .child(counter("working", "working"))
          .child(counter("waiting", "waiting"))
          .child(counter("blocked", "blocked"))
          .child(div().flex_1())
          .child(counter("done", "done")),
      )
      .child(
        div().id("orca-scroll").flex_1().min_h(0).overflow_y_scrollbar()
          // Agents
          .child(this.sectionHeader("agents", "Agents", active.length ? `${active.length} active` : `${done.length} done`, t))
          .when(!this.folded.has("agents"), (el) => el
            .when(list.length === 0, (x) => x.child(div().px(16).py(6).text_size(11).text_color(t.dim).child("No Orca agents are reporting.")))
            .children(active.map((a) => this.agentRow(a, t, now)))
            .when(done.length > 0, (x) => x.child(
              h_flex().px(14).pt(6).gap(6).items_center()
                .child(div().text_size(9.5).font_medium().text_color(t.dim).child("RECENTLY DONE"))
                .child(div().flex_1())
                .when(done.length > DONE_SHOWN, (y) => y.child(
                  div().id("orca-show-done").text_size(10).text_color(t.dim).cursor_pointer()
                    .hover((z) => z.text_color(t.foreground))
                    .on_click((_e, cx) => { this.showAllDone = !this.showAllDone; cx.notify(); })
                    .child(this.showAllDone ? "Show fewer" : `Show all ${done.length}`),
                )),
            ))
            .children(shownDone.map((a) => this.agentRow(a, t, now))))
          // Runs
          .child(this.sectionHeader("runs", "Runs", runs.some((r) => r.state === "active" || r.state === "blocked") ? `${runs.filter((r) => r.state === "active" || r.state === "blocked").length} active` : `${runs.length} recent`, t))
          .when(!this.folded.has("runs"), (el) => el
            .when(runs.length === 0, (x) => x.child(div().px(16).py(6).text_size(11).text_color(t.dim).child("No orchestration runs yet.")))
            .children(runs.map((r) => this.runRow(r, t, now))))
          // Workspaces
          .child(this.sectionHeader("workspaces", "Workspaces", `${liveWorktrees.length} live`, t))
          .when(!this.folded.has("workspaces"), (el) => el
            .when(liveWorktrees.length === 0, (x) => x.child(div().px(16).py(6).text_size(11).text_color(t.dim).child("No live Orca workspaces.")))
            .children(shownWorktrees.map((w) => this.workspaceRow(w, t, now)))
            .when(liveWorktrees.length > 6, (x) => x.child(
              h_flex().px(14).py(4)
                .child(div().id("orca-show-wt").text_size(10).text_color(t.dim).cursor_pointer()
                  .hover((z) => z.text_color(t.foreground))
                  .on_click((_e, cx) => { this.showAllWorkspaces = !this.showAllWorkspaces; cx.notify(); })
                  .child(this.showAllWorkspaces ? "Show fewer" : `Show all ${liveWorktrees.length}`)),
            )))
          .child(div().h(6)),
      );
  }

  render() {
    const t = theme();
    const now = Date.now();
    return v_flex()
      .id("orca-status")
      .size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .when(this.view === "machines", (el) => el.child(this.machinesView(t, now)))
      .when(this.view === "orca", (el) => el.child(this.orcaView(t, now)));
  }
}
