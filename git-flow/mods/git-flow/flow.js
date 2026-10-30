// The git-flow branching model in plain git, with the git-flow (AVH) tool's config keys, branch names and merges, so a
// repo set up here also works with `git flow` and the other way round. Every function takes git(args), which runs git in
// the repo and resolves with { code, stdout, stderr }: the panel passes Herdr's exec, a test passes node's.
export const KINDS = ["feature", "release", "hotfix"];
export const BASE = { feature: "develop", release: "develop", hotfix: "master" }; // the branch each one starts from
const PREFIX = { feature: "feature/", bugfix: "bugfix/", release: "release/", hotfix: "hotfix/", support: "support/", versiontag: "" };

export class FlowError extends Error {}

async function must(git, args) {
  const r = await git(args);
  if (r.code !== 0) throw new FlowError((r.stderr || r.stdout).trim().split("\n").pop() || `git ${args[0]} failed`);
  return r.stdout.trim();
}
const ok = async (git, args) => (await git(args)).code === 0;
const isAncestor = (git, a, b) => ok(git, ["merge-base", "--is-ancestor", a, b]);
// Commits on the right of `range` that the left lacks, merge commits left out: after a release the back-merge alone
// leaves develop with nothing to release.
const count = async (git, range) => Number((await git(["rev-list", "--count", "--no-merges", range])).stdout.trim()) || 0;

// Where the repo stands, with or without `git flow init`: its git-flow config (the saved gitflow.* keys, else names
// guessed from the branches there, `saved: false`), every local branch by kind (unprefixed ones are "other") with the
// commits each has that its base lacks, the history graph, and what blocks a finish (uncommitted changes, a merge in
// progress).
export async function read(git) {
  const cfg = {};
  for (const line of (await git(["config", "--get-regexp", "^gitflow\\."])).stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) cfg[line.slice(0, at)] = line.slice(at + 1);
  }
  const tips = {}; // branch -> commit, newest commit first
  for (const line of (await git(["for-each-ref", "--sort=-committerdate", "--format=%(objectname) %(refname:short)", "refs/heads"])).stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) tips[line.slice(at + 1)] = line.slice(0, at);
  }
  const heads = Object.keys(tips);
  const head = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || null;
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=no"])).stdout.split("\n").filter(Boolean).length;
  const merging = await ok(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const suggest = { master: heads.includes("main") || !heads.includes("master") ? "main" : "master", develop: "develop" };
  // A detached HEAD (a checked-out tag or commit, a rebase) is drawn too, as HEAD.
  const detached = head ? null : (await git(["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim() || null;
  if (detached && !Object.values(tips).includes(detached)) tips.HEAD = detached;
  if (!Object.keys(tips).length) return { config: null, heads, head, dirty, merging, suggest, empty: true };
  const saved = Boolean(cfg["gitflow.branch.master"] && cfg["gitflow.branch.develop"]);
  const guess = heads.includes(suggest.master) ? suggest.master : heads[heads.length - 1] ?? null;
  const config = {
    master: cfg["gitflow.branch.master"] || guess,
    develop: cfg["gitflow.branch.develop"] || (heads.includes("develop") ? "develop" : null),
    saved,
  };
  for (const k of ["feature", "release", "hotfix", "versiontag"]) config[k] = cfg[`gitflow.prefix.${k}`] ?? PREFIX[k];
  const kindOf = (b) => b === config.master ? "master" : b === config.develop ? "develop"
    : KINDS.find((k) => config[k] && b.startsWith(config[k])) ?? "other";
  const has = (b) => b && heads.includes(b);
  const baseOf = (kind) => kind === "hotfix" || !has(config.develop) ? config.master : config.develop;
  const branches = { feature: [], release: [], hotfix: [], other: [] };
  for (const full of heads) {
    const kind = kindOf(full);
    if (!branches[kind] || branches[kind].length >= 50) continue; // production and develop are listed apart
    const prefix = kind === "other" ? "" : config[kind], base = baseOf(kind);
    branches[kind].push({ kind, full, name: full.slice(prefix.length), ahead: has(base) ? await count(git, `${base}..${full}`) : 0 });
  }
  const unreleased = has(config.master) && has(config.develop) ? await count(git, `${config.master}..${config.develop}`) : 0;
  const tag = has(config.master) ? (await git(["describe", "--tags", "--abbrev=0", config.master])).stdout.trim() || null : null;
  const graph = await history(git, tips, kindOf);
  return { config, heads, head, dirty, merging, branches, unreleased, tag, graph, suggest, missing: [config.master, config.develop].filter((b) => b && !has(b)) };
}

// The order lanes take columns in, left to right, as git-flow's diagram draws them.
const COLUMN = { master: 0, hotfix: 1, release: 2, develop: 3, feature: 4, other: 5 };
// The order lanes claim commits in: a commit belongs to the first branch whose first-parent line reaches it.
const CLAIM = { master: 0, develop: 1, release: 2, hotfix: 3, feature: 4, other: 5 };
export const MAX_COLUMNS = 8;

// The last `limit` commits of every local branch as git-flow's graph: one row per commit, newest first, in the
// lane (column) of the branch it was made on. A deleted branch keeps its own lane, named from the merge that took
// it in ("Merge branch 'feature/x'"). Lanes reuse a column once an earlier one has ended.
export async function history(git, tips, kindOf, limit = 150) {
  const names = Object.keys(tips);
  if (!names.length) return { rows: [], lanes: [], links: [], columns: 0 };
  const out = (await git(["log", "--topo-order", `-n${limit}`, "--format=%H%x1f%P%x1f%s%x1f%D", ...names.map((b) => b === "HEAD" ? b : `refs/heads/${b}`), "--"])).stdout;
  const rows = [], at = {};
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [hash, parents, subject, deco] = line.split("\x1f");
    at[hash] = rows.length;
    const tags = deco.split(", ").filter((d) => d.startsWith("tag: ")).map((d) => d.slice(5));
    rows.push({ hash, parents: parents ? parents.split(" ") : [], subject, tags, refs: [], lane: -1 });
  }
  for (const b of names) if (tips[b] in at) rows[at[tips[b]]].refs.push(b);

  const lanes = [];
  const claim = (from, name, kind, live) => {
    const lane = { id: lanes.length, name, kind, live, commits: [] };
    for (let h = from; h in at && rows[at[h]].lane < 0; h = rows[at[h]].parents[0]) {
      rows[at[h]].lane = lane.id; lane.commits.push(at[h]);
    }
    if (lane.commits.length) lanes.push(lane);
    return lane;
  };
  for (const b of [...names].sort((a, b) => CLAIM[kindOf(a)] - CLAIM[kindOf(b)])) claim(tips[b], b, kindOf(b), true);
  // What is left came in through merges of branches since deleted, or sits below the window's edge.
  for (const row of rows) {
    row.parents.slice(1).forEach((p) => {
      if (!(p in at) || rows[at[p]].lane >= 0) return;
      const m = /^Merge (?:branch|remote-tracking branch) '([^']+)'|^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(row.subject);
      const name = m ? m[1] ?? m[2] : null;
      claim(p, name ?? "merged", name ? kindOf(name) : "other", false);
    });
  }
  for (const row of rows) if (row.lane < 0) claim(row.hash, "", "other", false);

  // Each lane runs from its newest commit (or the merge that took it in) down to the commit it forked from; first and
// last are its own newest and oldest commits. A link is a fork (the lane leaves `from` at `row`) or a merge (the
// commit at `row` in `from` takes the lane in).
  const links = [];
  for (const lane of lanes) { lane.top = lane.first = lane.commits[0]; lane.bottom = lane.last = lane.commits[lane.commits.length - 1]; lane.open = false; }
  lanes.forEach((lane) => {
    const fork = rows[lane.bottom].parents[0];
    if (fork in at) { links.push({ row: at[fork], from: rows[at[fork]].lane, to: lane.id, kind: "fork" }); lane.bottom = at[fork]; }
    else if (fork) { lane.bottom = rows.length - 1; lane.open = true; }
  });
  rows.forEach((row, r) => row.parents.slice(1).forEach((p) => {
    if (!(p in at)) return;
    const from = lanes[rows[at[p]].lane];
    if (from.id === row.lane) return;
    from.top = Math.min(from.top, r);
    links.push({ row: r, from: row.lane, to: from.id, kind: "merge" });
  }));

  // Columns: by kind left to right, and within a kind the first column free over the lane's whole run.
  const used = []; // used[col] = [[top, bottom], ...]
  let start = 0;
  for (const kind of Object.keys(COLUMN).sort((a, b) => COLUMN[a] - COLUMN[b])) {
    let end = start;
    for (const lane of lanes.filter((l) => l.kind === kind).sort((a, b) => a.top - b.top)) {
      let col = start;
      while ((used[col] ?? []).some(([t, b]) => !(lane.bottom < t || lane.top > b))) col++;
      (used[col] ??= []).push([lane.top, lane.bottom]);
      lane.col = Math.min(col, MAX_COLUMNS - 1);
      end = Math.max(end, col + 1);
    }
    start = end;
  }
  return {
    rows: rows.map(({ hash, subject, tags, refs, lane }) => ({ hash, subject, tags, refs, lane })),
    lanes: lanes.map(({ id, name, kind, live, top, bottom, first, last, open, col }) => ({ id, name, kind, live, top, bottom, first, last, open, col })),
    links: links.filter((l) => l.from !== l.to),
    columns: Math.min(start, MAX_COLUMNS),
  };
}

// `git flow init -d` with the given branch names: writes the gitflow.* keys, makes the develop branch from the
// production one if it is missing, and checks develop out.
export async function init(git, { master, develop }) {
  master = master.trim(); develop = develop.trim();
  if (!master || !develop) throw new FlowError("Name both branches");
  if (master === develop) throw new FlowError("The production and develop branches must differ");
  for (const b of [master, develop]) await must(git, ["check-ref-format", "--branch", b]);
  if (!(await ok(git, ["rev-parse", "-q", "--verify", "HEAD"]))) throw new FlowError("Make a first commit, then set up git flow");
  const has = async (b) => ok(git, ["rev-parse", "-q", "--verify", `refs/heads/${b}`]);
  if (!(await has(master))) throw new FlowError(`There is no branch ${master}`);
  if (!(await has(develop))) await must(git, ["branch", "--no-track", develop, master]);
  await must(git, ["config", "gitflow.branch.master", master]);
  await must(git, ["config", "gitflow.branch.develop", develop]);
  for (const [k, v] of Object.entries(PREFIX)) await must(git, ["config", `gitflow.prefix.${k}`, v]);
  await must(git, ["checkout", "-q", develop]);
  return `Git flow set up: ${master} for releases, ${develop} for work`;
}

// `git flow <kind> start <name>`: a new branch from develop (a feature or a release) or from production (a hotfix).
export async function start(git, state, kind, name) {
  const c = state.config;
  name = name.trim();
  if (!name) throw new FlowError(`Name the ${kind}`);
  const full = c[kind] + name, base = c[BASE[kind]];
  if (!base || !state.heads.includes(base)) throw new FlowError(`There is no ${BASE[kind] === "develop" ? "develop" : "production"} branch: set up git flow first`);
  await must(git, ["check-ref-format", "--branch", full]);
  if (state.heads.includes(full)) throw new FlowError(`${full} already exists`);
  if (kind !== "feature" && state.branches[kind].length) throw new FlowError(`Finish ${state.branches[kind][0].full} first: git flow has one ${kind} at a time`);
  if (kind !== "feature" && (await ok(git, ["rev-parse", "-q", "--verify", `refs/tags/${c.versiontag}${name}`]))) throw new FlowError(`Tag ${c.versiontag}${name} already exists`);
  await must(git, ["checkout", "-q", "-b", full, base]);
  return `Started ${full} from ${base}`;
}

async function merge(git, from, into, message) {
  await must(git, ["checkout", "-q", into]);
  const r = await git(["merge", "--no-ff", "--no-edit", "-m", message, from]);
  if (r.code !== 0) throw new FlowError(`Conflict merging ${from} into ${into}. Resolve it in a terminal and commit, then press Finish again`);
}

// `git flow <kind> finish <name>`. A feature merges into develop. A release or hotfix merges into production, is
// tagged there, and the tag merges back into develop. Then the branch is deleted and develop checked out. Each step is
// skipped when already done, so after a conflict is resolved and committed, Finish again picks up where it stopped.
export async function finish(git, state, kind, name) {
  const c = state.config, full = c[kind] + name;
  if (state.merging) throw new FlowError("A merge is in progress: resolve it and commit first");
  if (state.dirty) throw new FlowError("Commit or stash your changes first");
  if (!c.develop) throw new FlowError("There is no develop branch: set up git flow first");
  for (const b of [full, c.develop, ...(kind === "feature" ? [] : [c.master])]) {
    if (!state.heads.includes(b)) throw new FlowError(`There is no branch ${b}`);
  }
  if (kind === "feature") {
    if (!(await isAncestor(git, full, c.develop))) await merge(git, full, c.develop, `Merge branch '${full}' into ${c.develop}`);
  } else {
    const tag = c.versiontag + name;
    if (!(await isAncestor(git, full, c.master))) await merge(git, full, c.master, `Merge branch '${full}'`);
    if (!(await ok(git, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]))) await must(git, ["tag", "-a", tag, "-m", `${kind === "release" ? "Release" : "Hotfix"} ${name}`, c.master]);
    if (!(await isAncestor(git, tag, c.develop))) await merge(git, tag, c.develop, `Merge tag '${tag}' into ${c.develop}`);
  }
  await must(git, ["checkout", "-q", c.develop]);
  await must(git, ["branch", "-d", full]);
  return kind === "feature" ? `Merged ${full} into ${c.develop} and deleted it`
    : `${kind === "release" ? "Released" : "Hotfixed"} ${c.versiontag}${name}: merged into ${c.master}, tagged, merged back into ${c.develop}`;
}

export async function checkout(git, branch) {
  await must(git, ["checkout", "-q", branch]);
  return `On ${branch}`;
}
