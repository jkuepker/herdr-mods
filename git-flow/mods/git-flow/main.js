// git-flow: the repo of the focused terminal drawn as git-flow's graph, from whatever branches are there: production,
// hotfixes, releases, develop, features, and every other branch (an agent's, a worktree's), each commit in the lane of
// the branch it was made on. Nothing has to be set up first. Actions (off by default) set git flow up, start and
// finish features, releases and hotfixes, and check a branch out. The git work is in flow.js (plain git, git-flow's
// own config keys, so the `git flow` tool sees the same setup). Docked in a layout, × hides the block; anywhere else it
// opens as its own window (mod.open, e.g. cmd-shift-g) and × closes that.
import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, run, layout, shared, setShared, props, closeOverlay } from "herdr";
import * as flow from "./flow.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// This panel's block in the shown layout, for layout.hide.
function blockId(node = layout()) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === "git-flow") return node.id;
  for (const child of node.children ?? []) { const id = blockId(child); if (id) return id; }
  return null;
}
// Reads write nothing under .git (no index refresh or lock), so the folder watch does not wake itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const TITLE = { feature: "Features", release: "Releases", hotfix: "Hotfixes", other: "Other branches" };
// Production, develop, releases and hotfixes keep one color each, as in git-flow's diagram; every feature and other
// branch gets its own from the palette: the one its name hashes to, or the next one no other branch has yet.
const FIXED = { master: "#3d9df3", develop: "#a66cff", release: "#f5a623", hotfix: "#ff5470" };
const PALETTE = ["#1ec9a8", "#7bd34a", "#00b4e0", "#ff7ac6", "#ffd23f", "#6c8cff", "#e05cff", "#c9a26b"]; // far from FIXED and each other
const hash = (name) => { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
// Hands out palette colors for a read: branches that still exist first, top of the graph down, then finished lanes.
function paint(state) {
  const names = [], seen = new Set();
  const add = (name, kind) => { if (name && !FIXED[kind] && !seen.has(name)) { seen.add(name); names.push(name); } };
  for (const lane of state.graph.lanes.filter((l) => l.live).sort((a, b) => a.top - b.top)) add(lane.name, lane.kind);
  for (const kind of ["feature", "other"]) for (const b of state.branches[kind]) add(b.full, kind);
  for (const lane of state.graph.lanes.filter((l) => !l.live).sort((a, b) => a.top - b.top)) add(lane.name || `lane ${lane.id}`, lane.kind);
  const map = new Map(), used = new Set();
  for (const name of names) {
    let i = hash(name) % PALETTE.length;
    for (let n = 0; n < PALETTE.length && used.has(PALETTE[i]); n++) i = (i + 1) % PALETTE.length;
    map.set(name, PALETTE[i]); used.add(PALETTE[i]);
    if (used.size === PALETTE.length) used.clear();
  }
  return map;
}
const faint = (color) => `${color}59`; // a finished branch's lane, or one behind the picked branch
const FINISH = {
  feature: (c) => `merges into ${c.develop} and deletes the branch`,
  release: (c) => `merges into ${c.master}, tags it, merges back into ${c.develop}`,
  hotfix: (c) => `merges into ${c.master}, tags it, merges back into ${c.develop}`,
};
const COL = 14, ROW = 22, MID = ROW / 2, DOT = 10, LIST = 12; // graph column and row size, commit dot; branches listed per kind

export default class GitFlow extends View {
  init(_props, cx) {
    this.state = null; this.root = null; this.error = null; this.note = null;
    this.selected = null; // the branch picked in the list or graph: its lane stands out, actions act on it
    this.starting = null; // the kind whose name box is open
    this.confirm = null; // the branch whose Finish asks first
    this.more = {}; // kinds whose whole branch list is open
    this.nameInput = InputState.new({ placeholder: "name" });
    this.nameInput.on("submit", (_e, cx) => this.start(cx));
    this.masterInput = InputState.new({ placeholder: "main" });
    this.developInput = InputState.new({ placeholder: "develop" });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  colorOf(name, kind) {
    return FIXED[kind] ?? this.colors?.get(name) ?? PALETTE[hash(name) % PALETTE.length];
  }

  get actions() { return shared("git-flow.actions") === true; }

  git(args, write = false) {
    return exec("git", write ? args : [...READ, ...args], { cwd: this.root, on: this.on });
  }

  // Reads again when anything under the repo's git folder changes: a commit, a checkout, a branch made elsewhere.
  watch(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.state = null; this.error = null; this.note = null;
      this.selected = null; this.starting = null; this.confirm = null; this.watched = null; this.seeded = false; this.more = {};
    }
    if (!cwd) { this.error = "No folder here. Focus a terminal in a git repository."; cx.notify(); return; }
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.state = null; this.error = `${cwd.split("/").pop() || cwd} is not in a git repository. Focus a terminal in one.`; return; }
        const [root, gitDir] = top.stdout.trim().split("\n");
        this.root = root; this.on = on;
        const state = await flow.read((args) => this.git(args));
        if (key() !== context) return;
        this.state = state; this.error = null;
        if (state.graph) this.colors = paint(state);
        if (this.selected && !state.heads.includes(this.selected)) this.selected = null;
        if (state.config && !state.config.saved && !this.seeded) { // the names git flow init would offer
          this.masterInput.set_value(state.config.master); this.developInput.set_value(state.config.develop ?? state.suggest.develop); this.seeded = true;
        }
        this.watch(gitDir.startsWith("/") ? gitDir : `${root}/${gitDir}`, cx);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  // Runs one git-flow step, shows what it did or why not, and reads the repo again.
  act(cx, step) {
    if (this.busy || !this.root || this.context !== key()) return;
    const context = this.context, git = (args) => this.git(args, true);
    this.busy = true; this.note = null; this.confirm = null;
    cx.spawn(async (cx) => {
      try {
        const said = await step(git, this.state);
        if (key() === context) this.note = { ok: true, text: said };
      } catch (e) { if (key() === context) this.note = { ok: false, text: String(e.message ?? e) }; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  select(branch, cx) {
    this.selected = this.selected === branch ? null : branch; this.confirm = null;
    cx.notify();
  }

  openStart(kind, cx) {
    this.starting = this.starting === kind ? null : kind; this.confirm = null; this.note = null;
    this.nameInput.set_value("");
    if (this.starting) this.nameInput.focus();
    cx.notify();
  }

  start(cx) {
    const kind = this.starting, name = this.nameInput.value();
    if (!kind || !name.trim()) return;
    this.act(cx, async (git, state) => {
      const said = await flow.start(git, state, kind, name);
      this.starting = null; this.nameInput.set_value("");
      return said;
    });
  }

  // ---- view ----------------------------------------------------------------------------------------------------

  button(t, id, label, onClick, { primary = false, color } = {}) {
    const off = this.busy;
    return div().id(id).px(7).h(22).flex().flex_none().items_center().rounded(6).text_size(11)
      .when(primary, (e) => e.bg(off ? t.raised : t.solid).text_color(off ? t.dim : t.solid_foreground))
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(color ?? t.muted))
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!off) onClick(cx); })
      .child(label);
  }

  field(t, id, input) {
    return div().id(id).flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
      .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(input).h_full().text_size(12).text_color(t.foreground));
  }

  heading(t, text, right) {
    return h_flex().h(24).px(8).gap(6).items_center()
      .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(text))
      .when(Boolean(right), (e) => e.child(right));
  }

  // One branch: a dot in its lane's color, its name, how far it is ahead; a click picks it. Picked, with actions on,
  // it offers a checkout and (for a feature, release or hotfix) Finish.
  branchRow(t, kind, full, label, detail) {
    const s = this.state, c = s.config, here = s.head === full, picked = this.selected === full, asking = this.confirm === full;
    const finishable = this.actions && picked && flow.KINDS.includes(kind);
    const tools = this.actions && picked ? h_flex().gap(4).flex_none()
      .when(!here, (e) => e.child(this.button(t, `co-${full}`, "Check out", (cx) => this.act(cx, (git) => flow.checkout(git, full)))))
      .when(finishable && !asking, (e) => e.child(this.button(t, `finish-${full}`, "Finish", (cx) => { this.confirm = full; this.starting = null; this.note = null; cx.notify(); }))) : null;
    return v_flex()
      .child(h_flex().id(`row-${full}`).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer()
        .when(picked, (e) => e.bg(t.selected))
        .when(!picked, (e) => e.hover((st) => st.bg(t.hover)))
        .on_click((_e, cx) => this.select(full, cx))
        .child(div().size(9).flex_none().rounded_full().bg(this.colorOf(full, kind)).when(here, (e) => e.border_2().border_color(t.foreground)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).when(here, (e) => e.font_semibold()).child(label))
        .when(!tools, (e) => e.child(div().text_size(10.5).text_color(t.dim).flex_none().child(detail)))
        .when(Boolean(tools), (e) => e.child(tools)))
      .when(asking, (e) => e.child(h_flex().px(8).pb(6).gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(`Finish ${full}? It ${FINISH[kind](c)}.`))
        .child(this.button(t, `yes-${full}`, "Yes", (cx) => this.act(cx, (git, st) => flow.finish(git, st, kind, full.slice(c[kind].length))), { primary: true }))
        .child(this.button(t, `no-${full}`, "No", (cx) => { this.confirm = null; cx.notify(); }))));
  }

  branches(t) {
    const s = this.state, c = s.config;
    const ahead = (b) => b.ahead ? `${b.ahead} ahead` : "no commits";
    const list = v_flex().gap(1);
    if (c.master) list.child(this.branchRow(t, "master", c.master, c.master, s.missing.includes(c.master) ? "missing" : s.tag ? `tag ${s.tag}` : "no tags"));
    if (c.develop) list.child(this.branchRow(t, "develop", c.develop, c.develop, s.missing.includes(c.develop) ? "missing" : s.unreleased ? `${s.unreleased} unreleased` : "released"));
    for (const kind of ["hotfix", "release", "feature", "other"]) {
      const all = s.branches[kind];
      if (!all.length) continue;
      const shown = this.more[kind] ? all : all.slice(0, LIST);
      list.child(this.heading(t, `${TITLE[kind].toUpperCase()}  ${all.length}`))
        .children(shown.map((b) => this.branchRow(t, kind, b.full, b.name, ahead(b))));
      if (all.length > shown.length) list.child(div().id(`more-${kind}`).px(8).h(22).flex().items_center().text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.more[kind] = true; cx.notify(); }).child(`${all.length - shown.length} more`));
    }
    return list;
  }

  // The graph, one row per commit, drawn as git-flow's diagram: each lane a line in its branch's color, bending in a
  // smooth S where the branch forks off or merges in, a ringed dot per commit, then the branch and tag names at the
  // commit and its subject. The lines are painted over the rows in one layer, one path per lane.
  graph(t) {
    const g = this.state.graph, s = this.state, sel = this.selected;
    if (!g.rows.length) return div();
    const width = g.columns * COL + 6, height = g.rows.length * ROW;
    const x = (lane) => lane.col * COL + COL / 2 + 3, y = (r) => r * ROW + MID;
    const color = (lane) => this.colorOf(lane.name || `lane ${lane.id}`, lane.kind);
    const faded = (lane) => sel ? lane.name !== sel : !lane.live;
    const ink = (lane) => faded(lane) ? faint(color(lane)) : color(lane);
    const bend = (p, x1, y1, x2, y2) => { const m = (y1 + y2) / 2; return p.move_to(x1, y1).cubic_bezier_to(x2, y2, x1, m, x2, m); };
    const paths = g.lanes.map(() => null);
    const path = (lane) => paths[lane.id] ??= PathBuilder.stroke(2);
    for (const lane of g.lanes) {
      const from = lane.top < lane.first ? lane.top + 1 : lane.first;
      const to = lane.open ? null : lane.bottom > lane.last ? lane.bottom - 1 : lane.last;
      const end = to === null ? height : y(to);
      if (end > y(from)) path(lane).move_to(x(lane), y(from)).line_to(x(lane), end);
    }
    for (const link of g.links) {
      const a = g.lanes[link.from], b = g.lanes[link.to];
      if (a.col === b.col) continue;
      if (link.kind === "merge") bend(path(b), x(a), y(link.row), x(b), y(link.row + 1));
      else bend(path(b), x(b), y(link.row - 1), x(a), y(link.row));
    }
    const layer = div().absolute().top(0).left(0).w(width).h(height)
      .children(g.lanes.filter((l) => paths[l.id]).map((l) => window.paint_path(paths[l.id].build(), ink(l))))
      .children(g.rows.map((row, r) => {
        const lane = g.lanes[row.lane], here = row.refs.includes(s.head);
        return div().absolute().left(x(lane) - DOT / 2).top(y(r) - DOT / 2).size(DOT).rounded_full().bg(ink(lane))
          .border_2().border_color(here ? t.foreground : t.background);
      }));
    const rows = g.rows.map((row) => {
      const lane = g.lanes[row.lane];
      const chips = [
        ...row.refs.map((b) => { const c = this.colorOf(b, this.kindOf(b)); return div().flex_none().px(5).rounded(4).bg(faint(c)).text_size(10).text_color(t.foreground)
          .when(b === s.head, (e) => e.font_semibold()).child(b); }),
        ...row.tags.map((tag) => div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`◆ ${tag}`)),
      ];
      return h_flex().id(`c-${row.hash}`).h(ROW).pl(width + 4).pr(8).gap(5).items_center().cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { if (lane.live) this.select(lane.name, cx); })
        .children(chips)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(faded(lane) ? t.dim : t.muted).child(row.subject));
    });
    return v_flex().child(this.heading(t, "HISTORY")).child(v_flex().relative().children(rows).child(layer));
  }

  kindOf(branch) {
    const c = this.state.config;
    return branch === c.master ? "master" : branch === c.develop ? "develop" : flow.KINDS.find((k) => branch.startsWith(c[k])) ?? "other";
  }

  // With actions on: git flow's own setup when the repo has none, and Start for a feature, release or hotfix.
  tools(t) {
    const s = this.state, c = s.config, box = v_flex().px(8).py(6).gap(6).border_b(1).border_color(t.border);
    if (!c.saved || !c.develop) box.child(v_flex().gap(6)
      .child(div().text_size(11).text_color(t.muted).child("Set up git flow: production gets releases, develop gathers work (made from production if missing)."))
      .child(h_flex().gap(8).items_center().child(div().w(70).flex_none().text_size(11).text_color(t.dim).child("Production")).child(this.field(t, "init-master", this.masterInput)))
      .child(h_flex().gap(8).items_center().child(div().w(70).flex_none().text_size(11).text_color(t.dim).child("Develop")).child(this.field(t, "init-develop", this.developInput)))
      .child(h_flex().child(this.button(t, "init", this.busy ? "Setting up…" : "Set up git flow", (cx) => {
        const master = this.masterInput.value(), develop = this.developInput.value();
        this.act(cx, (git) => flow.init(git, { master, develop }));
      }, { primary: true }))));
    if (c.develop) box.child(h_flex().gap(6).items_center()
      .child(div().text_size(11).text_color(t.dim).child("Start"))
      .children(flow.KINDS.map((kind) => this.button(t, `start-${kind}`, this.starting === kind ? "Cancel" : `+ ${kind}`, (cx) => this.openStart(kind, cx), { color: FIXED[kind] ?? this.colorOf(kind, kind) }))));
    if (this.starting) box.child(h_flex().gap(6).items_center()
      .child(div().text_size(11.5).text_color(t.dim).flex_none().child(c[this.starting]))
      .child(this.field(t, "name", this.nameInput))
      .child(this.button(t, "go", "Start", (cx) => this.start(cx), { primary: true })));
    return box;
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), s = this.state, actions = this.actions;
    const where = this.root ? this.root.split("/").pop() : null;
    const status = s ? [s.head ? `on ${s.head}` : "detached", s.merging ? "merge in progress" : s.dirty ? `${s.dirty} changed` : null,
      s.config && !s.config.saved ? "git flow not set up" : null].filter(Boolean).join(" · ") : "";
    let body;
    if (this.error) body = div().p(12).text_size(12).text_color(t.dim).child(this.error);
    else if (!s) body = div().p(12).text_size(12).text_color(t.dim).child("Reading the repo…");
    else if (s.empty) body = div().p(12).text_size(12).text_color(t.muted).child("This repo has no commits yet: the graph shows once it has one.");
    else body = v_flex().pb(8).when(actions, (e) => e.child(this.tools(t))).child(v_flex().p(4).child(this.branches(t))).child(this.graph(t));
    return v_flex().id("git-flow").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(12).py(8).gap(2).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().child("Git Flow"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(where ?? ""))
          .child(this.button(t, "actions", "Actions", (cx) => { setShared("git-flow.actions", !actions); this.starting = null; this.confirm = null; cx.notify(); }, { primary: actions }))
          .child(this.button(t, "refresh", "↻", (cx) => this.refresh(cx)))
          .child(this.button(t, "hide", "×", () => props()?.overlay ? closeOverlay(props().overlay) : run("layout.hide", { id: blockId() ?? "git-flow" }))))
        .when(Boolean(status), (e) => e.child(div().text_size(11).text_color(s?.merging ? t.blocked : t.dim).truncate().child(status))))
      .child(div().id("git-flow-body").flex_1().min_h(0).overflow_y_scrollbar().child(body))
      .when(Boolean(this.note), (e) => e.child(div().id("git-flow-note").flex_none().px(12).py(8).border_t(1).border_color(t.border)
        .text_size(11).text_color(this.note.ok ? t.ansi2 : t.ansi1).cursor_pointer()
        .on_click((_e, cx) => { this.note = null; cx.notify(); }).child(this.note.text)));
  }
}
