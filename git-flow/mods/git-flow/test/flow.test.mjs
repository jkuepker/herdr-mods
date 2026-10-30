import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
// Checks flow.js against real git in throwaway repos: node test/flow.test.mjs [an empty folder to work in]
import * as flow from "../flow.js";

const T = process.argv[2] ?? mkdtempSync(`${tmpdir()}/git-flow-test-`);
const mk = (dir) => (args) => new Promise((res) => execFile("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
const repo = async (name) => { const d = mkdtempSync(`${T}/${name}-`); const g = mk(d); await g(["init", "-q", "-b", "main"]); writeFileSync(`${d}/a.txt`, "a\n"); await g(["add", "."]); await g(["commit", "-qm", "init"]); return [d, g]; };
const rejects = async (p, re) => { try { await p; } catch (e) { assert.ok(e instanceof flow.FlowError, e); assert.match(e.message, re); return; } assert.fail(`no error, wanted ${re}`); };
const commit = async (d, g, file, text) => { writeFileSync(`${d}/${file}`, text); await g(["add", file]); await g(["commit", "-qm", `edit ${file}`]); };
const log = async (g, b) => (await g(["log", "--format=%s", b])).stdout.trim().split("\n");

// not set up, then init
let [d, g] = await repo("r");
let s = await flow.read(g);
assert.equal(s.config.saved, false, "no gitflow keys yet"); assert.equal(s.config.master, "main"); assert.equal(s.config.develop, null);
assert.deepEqual(s.suggest, { master: "main", develop: "develop" });
assert.deepEqual(s.graph.rows.map((r) => r.refs), [["main"]]);
await rejects(flow.start(g, s, "feature", "early"), /no develop branch/);
await rejects(flow.init(g, { master: "main", develop: "main" }), /must differ/);
await rejects(flow.init(g, { master: "trunk", develop: "develop" }), /no branch trunk/);
assert.match(await flow.init(g, { master: "main", develop: "develop" }), /set up/);
s = await flow.read(g);
assert.equal(s.head, "develop"); assert.equal(s.config.feature, "feature/"); assert.equal(s.unreleased, 0); assert.ok(s.config.saved);
assert.equal((await g(["config", "gitflow.prefix.support"])).stdout.trim(), "support/", "git-flow AVH sees it as set up");

// feature: start, commit, finish
await rejects(flow.start(g, s, "feature", "bad name"), /./);
assert.match(await flow.start(g, s, "feature", "login"), /Started feature\/login from develop/);
await commit(d, g, "login.txt", "x\n");
s = await flow.read(g);
assert.deepEqual(s.branches.feature, [{ kind: "feature", full: "feature/login", name: "login", ahead: 1 }]);
await rejects(flow.start(g, s, "feature", "login"), /already exists/);
writeFileSync(`${d}/a.txt`, "dirty\n");
s = await flow.read(g);
await rejects(flow.finish(g, s, "feature", "login"), /Commit or stash/);
await g(["checkout", "--", "a.txt"]);
s = await flow.read(g);
assert.match(await flow.finish(g, s, "feature", "login"), /Merged feature\/login into develop and deleted it/);
s = await flow.read(g);
assert.equal(s.head, "develop"); assert.equal(s.branches.feature.length, 0); assert.equal(s.unreleased, 1, "the feature's commit, not its merge");
assert.equal((await log(g, "develop"))[0], "Merge branch 'feature/login' into develop");

// release: one at a time, tag, back-merge
assert.match(await flow.start(g, s, "release", "1.0"), /from develop/);
s = await flow.read(g);
await rejects(flow.start(g, s, "release", "1.1"), /Finish release\/1.0 first/);
await commit(d, g, "VERSION", "1.0\n");
s = await flow.read(g);
assert.match(await flow.finish(g, s, "release", "1.0"), /Released 1.0: merged into main, tagged, merged back into develop/);
s = await flow.read(g);
assert.equal(s.tag, "1.0"); assert.equal(s.unreleased, 0, "the back-merge does not count"); assert.equal(s.head, "develop");
assert.ok(!s.heads.includes("release/1.0"));
await rejects(flow.start(g, s, "release", "1.0"), /Tag 1.0 already exists/);

// hotfix from main with a conflict on the back-merge, resolved, then Finish again
await commit(d, g, "a.txt", "develop side\n");
s = await flow.read(g);
assert.match(await flow.start(g, s, "hotfix", "1.0.1"), /from main/);
await commit(d, g, "a.txt", "hotfix side\n");
s = await flow.read(g);
await rejects(flow.finish(g, s, "hotfix", "1.0.1"), /Conflict merging 1.0.1 into develop/);
s = await flow.read(g);
assert.ok(s.merging); assert.equal(s.head, "develop");
await rejects(flow.finish(g, s, "hotfix", "1.0.1"), /merge is in progress/);
writeFileSync(`${d}/a.txt`, "both\n"); await g(["add", "a.txt"]); await g(["commit", "-q", "--no-edit"]);
s = await flow.read(g);
assert.match(await flow.finish(g, s, "hotfix", "1.0.1"), /Hotfixed 1.0.1/);
s = await flow.read(g);
assert.equal(s.tag, "1.0.1"); assert.ok(!s.heads.includes("hotfix/1.0.1")); assert.equal(s.branches.hotfix.length, 0);
assert.equal((await g(["tag", "--list"])).stdout.trim(), "1.0\n1.0.1");

// the graph: every commit in the lane of the branch it was made on, deleted branches named from their merge
const lane = (subject) => s.graph.lanes[s.graph.rows.find((r) => r.subject === subject).lane];
assert.equal(s.graph.rows.length, Number((await g(["rev-list", "--count", "--all"])).stdout.trim()));
assert.ok(s.graph.rows.every((r) => r.lane >= 0));
assert.deepEqual([lane("edit login.txt").name, lane("edit login.txt").kind, lane("edit login.txt").live], ["feature/login", "feature", false]);
assert.equal(lane("edit VERSION").name, "release/1.0");
assert.equal(lane("Merge branch 'release/1.0'").name, "main");
assert.equal(lane("Merge branch 'feature/login' into develop").name, "develop");
assert.equal(lane("init").name, "main");
const col = (name) => s.graph.lanes.find((l) => l.name === name).col;
assert.ok(col("main") < col("hotfix/1.0.1") && col("hotfix/1.0.1") <= col("release/1.0") && col("release/1.0") < col("develop") && col("develop") < col("feature/login"), "main, hotfix, release, develop, feature left to right");
assert.ok(s.graph.links.some((l) => l.from === lane("Merge branch 'feature/login' into develop").id && l.to === lane("edit login.txt").id), "the feature's merge into develop");
assert.ok(s.graph.rows.find((r) => r.subject === "Merge branch 'release/1.0'").tags.includes("1.0"));

// agent branches with no prefix, with or without git flow set up, show as "other"
await g(["checkout", "-q", "-b", "claude/fix-x", "develop"]); await commit(d, g, "x.txt", "x\n");
await g(["checkout", "-q", "-b", "feature/a", "develop"]); await commit(d, g, "fa.txt", "a\n");
await g(["checkout", "-q", "-b", "feature/b", "develop"]); await commit(d, g, "fb.txt", "b\n");
s = await flow.read(g);
assert.deepEqual(s.branches.other.map((b) => [b.full, b.ahead]), [["claude/fix-x", 1]]);
assert.equal(lane("edit x.txt").kind, "other"); assert.ok(lane("edit x.txt").live);
assert.notEqual(col("feature/a"), col("feature/b"), "two features alive at once get two columns");
assert.ok(col("claude/fix-x") > Math.max(col("feature/a"), col("feature/b")));

// master-named repo and a repo with no commits
[d, g] = await repo("m"); await g(["branch", "-m", "master"]);
assert.equal((await flow.read(g)).suggest.master, "master");
const e = mkdtempSync(`${T}/e-`); const ge = mk(e); await ge(["init", "-q", "-b", "main"]);
s = await flow.read(ge); assert.equal(s.config, null); assert.ok(s.empty);
// only main and an agent branch, never set up: drawn, nothing asked first
[d, g] = await repo("a"); await g(["checkout", "-q", "-b", "worktree-1"]); await commit(d, g, "w.txt", "w\n");
s = await flow.read(g);
assert.equal(s.config.master, "main"); assert.deepEqual(s.missing, []); assert.deepEqual(s.branches.other.map((b) => b.full), ["worktree-1"]);
assert.deepEqual(s.graph.lanes.map((l) => [l.name, l.col]), [["main", 0], ["worktree-1", 1]]);
await rejects(flow.init(ge, { master: "main", develop: "develop" }), /first commit/);
// history but no branch at all (a detached checkout): still drawn, at HEAD
[d, g] = await repo("h"); await commit(d, g, "h.txt", "h\n");
await g(["checkout", "-q", "--detach"]); await g(["branch", "-D", "main"]);
s = await flow.read(g);
assert.ok(!s.empty); assert.equal(s.head, null); assert.equal(s.config.master, null);
assert.deepEqual(s.graph.rows.map((r) => r.refs), [["HEAD"], []]);
if (!process.argv[2]) rmSync(T, { recursive: true, force: true });
console.log("all git-flow checks passed");
