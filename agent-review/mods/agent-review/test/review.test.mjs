import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
// Checks review.js against real git in throwaway repos: node test/review.test.mjs [an empty folder to work in]
import * as review from "../review.js";

const T = process.argv[2] ?? mkdtempSync(`${tmpdir()}/agent-review-test-`);
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const runner = (cwd) => (cmd, args) => new Promise((res) => execFile(cmd, args, { cwd, env, maxBuffer: 1e8 }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
const d = mkdtempSync(`${T}/repo-`), run = runner(d), git = (...a) => run("git", a);
const put = (p, s) => writeFileSync(`${d}/${p}`, s);

await git("init", "-q", "-b", "main");
assert.equal((await review.firstBaseline(run)).tree, review.EMPTY_TREE, "no commit yet: an empty tree");
put("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"); put(".gitignore", "*.log\n");
await git("add", "."); await git("commit", "-qm", "init");
assert.equal(await review.toplevel(run), (await git("rev-parse", "--show-toplevel")).stdout.trim());

const first = await review.firstBaseline(run);
assert.match(first.label, /^HEAD [0-9a-f]{7}/);

// an edit near the top and one near the bottom (two hunks), a new file, an ignored file, a staged edit
put("a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
put("new.txt", "fresh\n"); put("debug.log", "ignored\n");
mkdirSync(`${d}/sub`); put("sub/b.txt", "b\n"); await git("add", "sub/b.txt");
const scratch = `${T}/idx-${Date.now()}`;
const now = await review.snapshot(run, scratch);
assert.ok(!existsSync(scratch), "the throwaway index is removed");
const staged = (await git("diff", "--cached", "--name-only")).stdout.trim();
assert.equal(staged, "sub/b.txt", "the repo's index is left as it was");
const s1 = await review.diff(run, first.tree, now);
assert.deepEqual(s1.files.map((f) => [f.path, f.status, f.added, f.removed]).sort(),
  [["a.txt", "M", 2, 2], ["new.txt", "A", 1, 0], ["sub/b.txt", "A", 1, 0]], "untracked new.txt in, debug.log ignored");
const a = s1.files.find((f) => f.path === "a.txt");
assert.equal(a.hunks.length, 2);
assert.deepEqual(a.hunks[0].lines.filter((l) => l.kind === "+").map((l) => [l.text, l.next]), [["ONE", 1]]);
assert.deepEqual(a.hunks[1].lines.filter((l) => l.kind === "-").map((l) => [l.text, l.old]), [["ten", 10]]);

// a snapshot taken without a scratch path keeps its index inside the git folder and removes it
assert.equal(await review.snapshot(run), now, "same tree either way");
assert.ok(!(await git("rev-parse", "--git-path", "index")).stdout.includes("agent-review"));

// since the last look: only what changed after it
put("a.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nTEN\n");
const later = await review.snapshot(run, scratch);
const s2 = await review.diff(run, now, later);
assert.deepEqual(s2.files.map((f) => [f.path, f.added, f.removed]), [["a.txt", 1, 1]]);
assert.ok(await review.exists(run, now)); assert.ok(!(await review.exists(run, "0".repeat(40))));

// revert the first hunk of the first look: line 1 goes back, the rest stays
await review.revert(run, review.hunkPatch(a, a.hunks[0]));
assert.equal(readFileSync(`${d}/a.txt`, "utf8"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nTEN\n");
// reverting it again finds the file no longer as the snapshot had it, and changes nothing
await assert.rejects(review.revert(run, review.hunkPatch(a, a.hunks[0])), /Not reverted/);
// revert a whole new file: it goes
const n = s1.files.find((f) => f.path === "new.txt");
await review.revert(run, review.hunkPatch(n, n.hunks[0]));
assert.ok(!existsSync(`${d}/new.txt`));
assert.equal((await git("diff", "--cached", "--name-only")).stdout.trim(), "sub/b.txt", "the staged sub/b.txt is still staged");

// a deleted file and a file without a final newline, then their reverts
put("c.txt", "c1\nc2"); await git("add", "."); await git("commit", "-qm", "c");
const base = await review.snapshot(run, scratch);
rmSync(`${d}/c.txt`); put("a.txt", "x\n");
const s3 = await review.diff(run, base, await review.snapshot(run, scratch));
const c = s3.files.find((f) => f.path === "c.txt");
assert.equal(c.status, "D"); assert.ok(c.hunks[0].lines.some((l) => l.kind === "\\"));
await review.revert(run, review.hunkPatch(c, c.hunks[0]));
assert.equal(readFileSync(`${d}/c.txt`, "utf8"), "c1\nc2");

// a binary file and a mode-only change can't be reverted by hunk
writeFileSync(`${d}/bin.dat`, Buffer.from([0, 1, 2, 0, 255]));
await git("add", "bin.dat"); await git("commit", "-qm", "bin");
const b0 = await review.snapshot(run, scratch);
writeFileSync(`${d}/bin.dat`, Buffer.from([0, 9, 9, 0, 255])); await run("chmod", ["+x", `${d}/c.txt`]);
const s4 = await review.diff(run, b0, await review.snapshot(run, scratch));
assert.ok(s4.files.find((f) => f.path === "bin.dat").binary);
assert.ok(s4.files.find((f) => f.path === "c.txt").modeOnly);

if (!process.argv[2]) rmSync(T, { recursive: true, force: true });
console.log("all agent-review checks passed");
