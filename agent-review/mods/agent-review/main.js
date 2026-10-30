// agent-review: pick an agent and see what changed in its repo since you last looked at it. A comment on a line or
// a hunk is pasted into that agent's terminal (Enter only on Send), and a hunk can be reverted after a confirmation
// (this computer only, agent not mid-turn).
// "Since you last looked" is a snapshot of the working tree saved as a git tree when you click Mark seen; the first
// look starts at HEAD. Agents are the space's terminals that report a status, and panes running a known agent
// program that doesn't (Codex). Commands: agent-review.close, .reload, .seen. The git work is in review.js. Opens as its own window (mod.open, e.g. cmd-shift-y).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, agents, terminals, exec, hc, theme, settings, run, shared, setShared, appHome, props, closeOverlay, nextCommand, knownAgents } from "herdr";
import * as review from "./review.js";

const SEEN = "agent-review.seen"; // shared: "<machine>|<repo>|<terminal>" -> { tree, at }
const ALL = "agent-review.all"; // shared: list agents of every space, not just the shown one
const ROW = 20, MAX_ROWS = 20000;
const STATUS = { working: "ansi4", blocked: "ansi1", done: "ansi2", idle: "dim" };

// Agents: terminals that report a status (agents()), and panes running a known agent program that doesn't (Codex).
let agentKeys = new Set(); // knownAgents()' program keys, read once
function everyAgent() {
  const out = agents().map((a) => ({ ...a })), known = new Set(out.map((a) => a.address)), tabs = {};
  for (const s of spaces()) for (const t of s.tabs ?? []) tabs[t.id] = { space: s.id, space_name: s.name, tab_name: t.name };
  for (const p of panes()) {
    if (p.terminal && (p.program?.agent || agentKeys.has(p.program?.key)) && !known.has(p.terminal)) out.push({ address: p.terminal, pane: p.pane, tab: p.tab, ...tabs[p.tab], status: p.status, program: p.program, app: p.app, title: p.title });
  }
  return out;
}
const machineOf = (a) => a.address.includes("/") ? a.address.split("/")[0] : spaces().find((s) => s.id === a.space)?.machine ?? null;
const cwdOf = (a) => panes().find((p) => p.pane === a.pane)?.cwd ?? terminals().find((t) => t.address === a.address)?.cwd ?? null;
const branchOf = (a) => panes().find((p) => p.pane === a.pane)?.branch ?? null;
const nameOf = (a) => `${a.program?.name || a.app || "Agent"} · ${a.tab_name ? `tab ${a.tab_name} · ` : ""}${a.address}`;
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

export default class AgentReview extends View {
  init(_props, cx) {
    this.roots = {}; // "<machine>|<cwd>" -> repo top folder, or "" when not in one
    const f = focused(), shown = this.list(), mine = (x) => x && shown.some((g) => g.address === x);
    this.picked = mine(f?.terminal) ? f.terminal : mine(f?.agent) ? f.agent : shown[0]?.address ?? null;
    this.view = null; // what the picked agent's diff is: { address, machine, root, base, label, now, files, rows, cut }
    this.error = null; this.note = null; this.busy = false;
    this.target = null; // what a comment is about: { file, hunk, line? }
    this.confirm = null; // the hunk a revert asks about: { file, hunk }
    this.pasted = null; // the text last pasted, and where, so Send then only presses Enter
    this.input = InputState.new({ placeholder: "Comment for the agent" });
    this.input.on("submit", (_e, cx) => this.paste(cx));
    this.load(cx);
    cx.spawn(async (cx) => {
      try { agentKeys = new Set((await knownAgents()).map((k) => k.key)); } catch {}
      cx.notify();
    });
    // Commands for keys.json or `herdr-app do agent-review.<command>`: close, reload, seen.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "close" && props()?.overlay) closeOverlay(props().overlay);
        else if (c === "reload") this.load(cx);
        else if (c === "seen") this.markSeen(cx);
        cx.notify();
      }
    });
  }

  list() {
    const all = shared(ALL) === true, here = spaces().find((s) => s.active)?.id;
    return everyAgent().filter((a) => all || a.space === here);
  }

  rootOf(a) { return this.roots[`${machineOf(a)}|${cwdOf(a)}`]; }

  // Finds each agent's repo, once per folder, so the list can say which agents share one.
  resolveRoots(cx) {
    for (const a of everyAgent()) {
      const cwd = cwdOf(a), k = `${machineOf(a)}|${cwd}`;
      if (!cwd || k in this.roots) continue;
      this.roots[k] = undefined;
      cx.spawn(async (cx) => {
        try { this.roots[k] = (await review.toplevel((c, args) => exec(c, args, { cwd, on: machineOf(a) }))) ?? ""; }
        catch { this.roots[k] = ""; }
        cx.notify();
      });
    }
  }

  // Snapshots the picked agent's repo and diffs it against the last look. Runs on open, on picking an agent, on ↻,
  // after Mark seen or a revert, and when the agent stops working: never on a timer, since each snapshot writes into
  // the repo's git folder and wakes whatever watches it.
  load(cx) {
    const a = everyAgent().find((x) => x.address === this.picked);
    if (!a) { this.view = null; this.error = this.picked ? "That agent has gone." : null; cx.notify(); return; }
    if (this.busy) { this.again = true; return; }
    const address = a.address, machine = machineOf(a), cwd = cwdOf(a);
    if (!cwd) { this.view = null; this.error = "This agent has no folder."; cx.notify(); return; }
    this.busy = true; this.again = false; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const root = await review.toplevel((c, args) => exec(c, args, { cwd, on: machine }));
        this.roots[`${machine}|${cwd}`] = root ?? "";
        if (!root) throw new review.ReviewError(`${cwd.split("/").pop()} is not in a git repository.`);
        const git = (c, args) => exec(c, args, { cwd: root, on: machine });
        let index = "";
        if (!machine) { const dir = `${appHome()}/data/agent-review`; await exec("mkdir", ["-p", dir]); index = `${dir}/snapshot-${Date.now()}.index`; }
        const now = await review.snapshot(git, index);
        const seen = (shared(SEEN) ?? {})[`${machine ?? ""}|${root}|${address}`];
        let base, label;
        if (seen && await review.exists(git, seen.tree)) { base = seen.tree; label = `since you looked ${ago(seen.at)}`; }
        else {
          const first = await review.firstBaseline(git);
          base = first.tree;
          label = seen ? `your last look is gone from the repo (git gc): since ${first.label}` : `first look: since ${first.label}`;
        }
        const { files, cut } = await review.diff(git, base, now);
        if (this.picked !== address) return;
        this.view = { address, machine, root, base, label, now, files, cut, rows: this.rows(files) };
        this.confirm = null;
      } catch (e) { if (this.picked === address) { this.view = null; this.error = String(e.message ?? e); } }
      finally {
        this.busy = false; cx.notify();
        if (this.again) this.load(cx);
      }
    });
    cx.notify();
  }

  rows(files) {
    const rows = [];
    for (const file of files) {
      rows.push({ type: "file", file });
      if (file.binary) rows.push({ type: "info", file, text: "Binary file changed: no text diff, can't revert here" });
      else if (file.modeOnly) rows.push({ type: "info", file, text: "Only its mode changed: can't revert here" });
      for (const hunk of file.hunks) {
        rows.push({ type: "hunk", file, hunk });
        for (const line of hunk.lines) rows.push({ type: "line", file, hunk, line });
      }
      if (rows.length > MAX_ROWS) break;
    }
    return rows.slice(0, MAX_ROWS);
  }

  pick(address, cx) {
    if (this.picked === address) return;
    this.picked = address; this.view = null; this.target = null; this.confirm = null; this.note = null; this.pasted = null;
    this.load(cx);
  }

  markSeen(cx) {
    const v = this.view;
    if (!v || this.busy) return;
    setShared(SEEN, { ...(shared(SEEN) ?? {}), [`${v.machine ?? ""}|${v.root}|${v.address}`]: { tree: v.now, at: Date.now() } });
    this.target = null; this.note = null;
    this.load(cx);
  }

  // ---- comments ------------------------------------------------------------------------------------------------

  aim(target, cx) {
    this.target = target; this.confirm = null; this.note = null;
    this.input.focus();
    cx.notify();
  }

  message() {
    const { file, hunk, line } = this.target, said = this.input.value().trim();
    if (!said) return null;
    if (line) {
      const where = line.kind === "-" ? `${file.path} (removed line ${line.old})` : `${file.path}:${line.next}`;
      const code = line.text.trim().slice(0, 160);
      return `${where}: ${said}${code ? ` (line: \`${code}\`)` : ""}`;
    }
    const kept = hunk.lines.filter((l) => l.kind === " " || l.kind === "+").length;
    return `${file.path}:${hunk.next}-${hunk.next + Math.max(kept, 1) - 1}: ${said}`;
  }

  // Why a hunk can't be reverted now, or null. Only on this computer, and only while the agent isn't mid-turn
  // (idle, done, or a program that reports no status, which the question then says).
  revertBlocked(a) {
    if (this.view?.machine) return "Revert works on this computer only. Ask the agent to undo it instead.";
    if (a && (a.status === "working" || a.status === "blocked")) return `${nameOf(a)} is ${a.status}. Revert once it's idle or done, or ask it to undo the hunk.`;
    return null;
  }

  // Pastes the comment into the agent's terminal and leaves Enter to the person (or Send). Herdr pastes into the
  // focused terminal, so it focuses the agent's pane first and pastes only if focus really got there; otherwise the
  // comment is left on the clipboard. The person's clipboard comes back once the paste is done.
  paste(cx) {
    const a = everyAgent().find((x) => x.address === this.view?.address), text = this.target && this.message();
    if (!a || !text) return;
    run("agent.focus", { terminal: a.address });
    run("pane.focus", { terminal: a.address });
    cx.timer.after(300, (cx) => {
      if (focused()?.terminal !== a.address) {
        cx.write_to_clipboard(text);
        this.note = { ok: false, text: `Couldn't focus ${nameOf(a)}: the comment is on the clipboard, paste it there yourself.` };
        cx.notify(); return;
      }
      const before = cx.read_from_clipboard();
      cx.write_to_clipboard(text);
      run("terminal.paste");
      this.pasted = { address: a.address, text };
      this.note = { ok: true, text: `Pasted into ${nameOf(a)}. Press Enter there, or Send here.` };
      cx.notify();
      cx.timer.after(1500, (cx) => { if (before !== undefined && cx.read_from_clipboard() === text) cx.write_to_clipboard(before); });
    });
  }

  // Sends the comment and presses Enter. After a Paste of the same text it only presses Enter, so it isn't typed twice.
  send(cx) {
    const a = everyAgent().find((x) => x.address === this.view?.address), text = this.target && this.message();
    if (!a || !text || this.sending) return;
    const enterOnly = this.pasted?.address === a.address && this.pasted.text === text;
    this.sending = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(enterOnly ? ["keys", a.address, "enter"] : ["send", a.address, text]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc failed");
        this.note = { ok: true, text: `Sent to ${nameOf(a)}.` };
        this.pasted = null; this.target = null; this.input.set_value("");
      } catch (e) { this.note = { ok: false, text: `Not sent: ${e.message ?? e}` }; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  }

  revert(cx) {
    const v = this.view, c = this.confirm;
    if (!v || !c || this.busy) return;
    this.confirm = null; this.note = null;
    const blocked = this.revertBlocked(everyAgent().find((x) => x.address === v.address));
    if (blocked) { this.note = { ok: false, text: blocked }; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        await review.revert((cmd, args) => exec(cmd, args, { cwd: v.root, on: v.machine }), review.hunkPatch(c.file, c.hunk));
        this.note = { ok: true, text: `Reverted a hunk in ${c.file.path}.` };
      } catch (e) { this.note = { ok: false, text: String(e.message ?? e) }; }
      this.target = null;
      this.load(cx);
    });
    cx.notify();
  }

  // ---- view ----------------------------------------------------------------------------------------------------

  button(t, id, label, onClick, { primary = false, off = false, color } = {}) {
    return div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).text_size(11.5)
      .when(primary, (e) => e.bg(off ? t.raised : t.solid).text_color(off ? t.dim : t.solid_foreground))
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(off ? t.dim : color ?? t.muted))
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!off) onClick(cx); })
      .child(label);
  }

  agentRow(t, a) {
    const picked = a.address === this.picked, cwd = cwdOf(a), branch = branchOf(a);
    const all = shared(ALL) === true;
    return h_flex().id(`agent-${a.address}`).px(8).py(6).gap(8).items_center().rounded(7).cursor_pointer()
      .when(picked, (e) => e.bg(t.selected)).when(!picked, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pick(a.address, cx))
      .child(div().size(8).flex_none().rounded_full().bg(t[STATUS[a.status]] ?? t.dim))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(nameOf(a)))
        .child(div().truncate().text_size(11).text_color(t.dim)
          .child([all ? a.space_name : null, cwd ? cwd.split("/").pop() : "no folder", branch].filter(Boolean).join(" · "))));
  }

  // One row of the diff. Rows are drawn by a virtual list, which allows no handlers inside them: clicks come through
  // the list's on_item_click (clickRow).
  diffRow(t, row) {
    const mono = settings().font_family ?? "JetBrains Mono";
    if (row.type === "file") {
      const parts = row.file.path.split("/"), name = parts.pop();
      return h_flex().w_full().h(ROW).px(10).gap(8).items_center().bg(t.raised)
        .child(div().w(12).flex_none().text_size(11).text_color(row.file.status === "A" ? t.ansi2 : row.file.status === "D" ? t.ansi1 : t.blocked).child(row.file.status))
        .child(h_flex().flex_1().min_w(0).text_size(12).child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().font_semibold().child(name)))
        .when(row.file.added > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${row.file.added}`)))
        .when(row.file.removed > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${row.file.removed}`)));
    }
    if (row.type === "info") return div().w_full().h(ROW).px(30).flex().items_center().text_size(11).text_color(t.dim).child(row.text);
    if (row.type === "hunk") {
      const aimed = (this.target?.hunk === row.hunk && !this.target.line) || this.confirm?.hunk === row.hunk;
      return h_flex().w_full().h(ROW).px(10).gap(8).items_center().cursor_pointer().when(aimed, (e) => e.bg(t.selected))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(11).text_color(t.dim).child(row.hunk.header))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("click: comment or revert"));
    }
    const { kind, text, old, next } = row.line, aimed = this.target?.line === row.line;
    return h_flex().w_full().h(ROW).gap(8).items_center().font_family(mono).text_size(11.5).cursor_pointer()
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .when(aimed, (e) => e.bg(t.selected))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(old === undefined ? "" : String(old)))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(next === undefined ? "" : String(next)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === " " || kind === "\\" ? "" : kind))
      .child(div().flex_1().min_w(0).truncate().text_color(kind === "\\" ? t.dim : t.foreground).child(text || " "));
  }

  clickRow(i, cx) {
    const row = this.view?.rows[i];
    if (!row) return;
    if (row.type === "hunk") this.aim({ file: row.file, hunk: row.hunk }, cx);
    else if (row.type === "line" && row.line.kind !== "\\") this.aim({ file: row.file, hunk: row.hunk, line: row.line }, cx);
  }

  // The bottom bar: the revert question, or the comment box, or what the last action did.
  footer(t) {
    const v = this.view, a = everyAgent().find((x) => x.address === v?.address);
    if (this.confirm) {
      const { file, hunk } = this.confirm, add = hunk.lines.filter((l) => l.kind === "+").length, del = hunk.lines.filter((l) => l.kind === "-").length;
      return h_flex().flex_none().px(12).py(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(12).child(`Revert this hunk in ${file.path} (+${add} −${del})? The file in the working tree changes; ${a ? nameOf(a) : "the agent"} isn't told.${a && !a.status ? " It reports no status, so it may be mid-turn." : ""}`))
        .child(this.button(t, "revert-yes", "Revert", (cx) => this.revert(cx), { primary: true }))
        .child(this.button(t, "revert-no", "Cancel", (cx) => { this.confirm = null; cx.notify(); }));
    }
    if (this.target) {
      const { file, hunk, line } = this.target;
      const about = line ? (line.kind === "-" ? `${file.path}, removed line ${line.old}` : `${file.path}:${line.next}`) : `${file.path}, hunk at line ${hunk.next}`;
      const ready = !this.sending;
      // The note goes above the input row: the bar grows upward, so the buttons stay where they were clicked.
      return v_flex().flex_none().px(12).py(10).gap(6).border_t(1).border_color(t.border)
        .when(Boolean(this.note), (e) => e.child(div().text_size(11).text_color(this.note.ok ? t.ansi2 : t.ansi1).child(this.note.text)))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(`Comment on ${about}, for ${a ? nameOf(a) : "the agent"}`))
          .child(div().id("aim-off").px(4).cursor_pointer().on_click((_e, cx) => { this.target = null; cx.notify(); }).child("×")))
        .child(h_flex().gap(6).items_center()
          .child(div().id("comment").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.input ?? t.background)
            .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(this.button(t, "paste", "Paste", (cx) => this.paste(cx), { off: !ready }))
          .child(this.button(t, "send", this.sending ? "Sending…" : "Send", (cx) => this.send(cx), { primary: true, off: !ready }))
          .child(this.button(t, "revert", "Revert hunk…", (cx) => {
            const blocked = this.revertBlocked(a);
            if (blocked) this.note = { ok: false, text: blocked };
            else { this.confirm = { file, hunk }; this.target = null; this.note = null; }
            cx.notify();
          }, { color: this.revertBlocked(a) ? t.dim : t.ansi1 })));
    }
    if (this.note) return div().id("note").flex_none().px(12).py(8).border_t(1).border_color(t.border).text_size(11.5)
      .text_color(this.note.ok ? t.ansi2 : t.ansi1).cursor_pointer().on_click((_e, cx) => { this.note = null; cx.notify(); }).child(this.note.text);
    return div();
  }

  render(cx) {
    const t = theme(), list = this.list(), v = this.view;
    this.resolveRoots(cx);
    const a = everyAgent().find((x) => x.address === this.picked);
    if (!this.busy && !list.some((x) => x.address === this.picked) && list.length) { this.picked = null; this.pick(list[0].address, cx); }
    // A picked agent that just stopped working has new changes to show.
    if (a && this.lastStatus === "working" && a.status !== "working") this.load(cx);
    this.lastStatus = a?.status;
    const all = shared(ALL) === true, close = props()?.overlay;
    const root = a && this.rootOf(a);
    const sharing = a && root ? everyAgent().filter((x) => x.address !== a.address && this.rootOf(x) === root && machineOf(x) === machineOf(a)) : [];
    const add = v ? v.files.reduce((n, f) => n + f.added, 0) : 0, del = v ? v.files.reduce((n, f) => n + f.removed, 0) : 0;

    const side = v_flex().w(250).h_full().flex_none().min_h(0).border_r(1).border_color(t.border)
      .child(h_flex().h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(all ? "ALL AGENTS" : "AGENTS IN THIS SPACE"))
        .child(this.button(t, "scope", all ? "This space" : "All", () => setShared(ALL, !all))))
      .child(v_flex().id("agents").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .children(list.map((x) => this.agentRow(t, x)))
        .when(!list.length, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(all ? "No agents running." : "No agents in this space."))));

    const head = v_flex().flex_none().px(14).py(8).gap(3).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(a ? nameOf(a) : "Agent review"))
        .when(Boolean(v), (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
        .child(this.button(t, "seen", "Mark seen", (cx) => this.markSeen(cx), { off: !v || this.busy }))
        .child(this.button(t, "reload", this.busy ? "…" : "↻", (cx) => this.load(cx)))
        .when(Boolean(close), (e) => e.child(this.button(t, "close", "×", () => closeOverlay(close)))))
      .when(Boolean(v), (e) => e.child(div().text_size(11).text_color(t.dim).truncate()
        .child(`${v.root.split("/").pop()} · ${v.label} · ${v.files.length} ${v.files.length === 1 ? "file" : "files"}`)));

    let body;
    if (this.error) body = div().p(16).text_size(12).text_color(t.dim).child(this.error);
    else if (!a) body = div().p(16).text_size(12).text_color(t.dim).child("Pick an agent.");
    else if (!v) body = div().p(16).text_size(12).text_color(t.dim).child("Reading its changes…");
    else if (!v.files.length) body = div().p(16).text_size(12).text_color(t.dim).child("Nothing changed since then.");
    else body = div().size_full().min_h(0).relative()
      .child(v_virtual_list("agent-review-diff", v.rows.length, ROW, (i) => String(i), (range) => v.rows.slice(range.start, range.end).map((row) => this.diffRow(t, row)))
        .size_full().on_item_click((key, cx) => this.clickRow(Number(key), cx)))
      .child(Scrollbar.vertical("agent-review-diff").viewport_from_layout().absolute().inset_0());

    return h_flex().id("agent-review").size_full().min_h(0).items_start().bg(t.background).text_color(t.foreground).text_size(13)
      .child(side)
      .child(v_flex().flex_1().h_full().min_w(0).min_h(0)
        .child(head)
        .when(sharing.length > 0, (e) => e.child(div().flex_none().px(14).py(6).bg(t.raised).border_b(1).border_color(t.border).text_size(11.5).text_color(t.blocked)
          .child(`Also working in this repo: ${sharing.map(nameOf).join(", ")}. Lines can't be told apart by agent, so this is everyone's changes.`)))
        .when(Boolean(v?.cut), (e) => e.child(div().flex_none().px(14).py(4).text_size(11).text_color(t.dim).child("The diff is too large: showing its first 4 MB.")))
        .child(v_flex().flex_1().min_h(0).child(body))
        .child(this.footer(t)));
  }
}
