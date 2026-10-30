// Agent review's git work: a working tree saved as a git tree (a snapshot), the diff between two snapshots split into
// files and hunks, and reverting one hunk. Every function takes run(command, args), which runs in the repo's top
// folder and resolves with { code, stdout, stderr }. Snapshots write git objects into the repo (as `git stash` does)
// and nothing else: no refs, no config, and the repo's own index is only read.

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const MAX_DIFF = 4 * 1024 * 1024; // bytes of diff read; more is cut off, and the view says so

export class ReviewError extends Error {}
const must = async (run, args) => {
  const r = await run("git", [...READ, ...args]);
  if (r.code !== 0) throw new ReviewError((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r.stdout;
};

export async function toplevel(run) {
  const r = await run("git", [...READ, "rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

// The working tree now, untracked files included and ignored ones left out, as a tree. A throwaway index at `index`
// (a path outside the git folder; empty: one inside it) starts as a copy of the repo's, so only changed files are hashed.
export async function snapshot(run, index = "") {
  const script = `set -e
idx="$1"; [ -n "$idx" ] || idx="$(git rev-parse --git-path agent-review-$$.index)"
real="$(git rev-parse --git-path index)"
rm -f "$idx"; [ -f "$real" ] && cp "$real" "$idx"
trap 'rm -f "$idx"' EXIT
GIT_INDEX_FILE="$idx" git -c core.fsmonitor=false add -A
GIT_INDEX_FILE="$idx" git write-tree`;
  const r = await run("sh", ["-c", script, "sh", index]);
  if (r.code !== 0) throw new ReviewError((r.stderr || r.stdout).trim() || "snapshot failed");
  return r.stdout.trim();
}

// Where a first look starts: the commit checked out (its tree), so it shows every uncommitted change. Kept apart so
// it is one place to change.
export async function firstBaseline(run) {
  const r = await run("git", [...READ, "rev-parse", "-q", "--verify", "HEAD^{tree}"]);
  const head = await run("git", [...READ, "rev-parse", "--short", "-q", "--verify", "HEAD"]);
  return r.code === 0 ? { tree: r.stdout.trim(), label: `HEAD ${head.stdout.trim()}` } : { tree: EMPTY_TREE, label: "an empty repo" };
}

// Whether a saved snapshot is still in the repo (`git gc` prunes unreferenced ones after a while).
export async function exists(run, tree) {
  return (await run("git", [...READ, "cat-file", "-e", `${tree}^{tree}`])).code === 0;
}

export async function diff(run, base, now) {
  const out = await must(run, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, now]);
  const cut = out.length > MAX_DIFF;
  return { files: parse(cut ? out.slice(0, out.lastIndexOf("\ndiff --git ", MAX_DIFF) + 1 || MAX_DIFF) : out), cut };
}

// A patch as files: the header lines (diff --git … +++), and each hunk's @@ line and body with line numbers.
export function parse(text) {
  const files = [];
  let file = null, hunk = null, old = 0, next = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m ? m[2] : line.slice(11), header: [line], hunks: [], added: 0, removed: 0, binary: false, status: "M" };
      files.push(file); hunk = null;
      continue;
    }
    if (!file) continue;
    const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (at) {
      old = +at[1]; next = +at[3];
      hunk = { header: line, lines: [], old: +at[1], next: +at[3] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "A";
      else if (line.startsWith("deleted file mode")) file.status = "D";
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("+++ b/")) file.path = line.slice(6);
      else if (line.startsWith("--- a/") && file.status === "D") file.path = line.slice(6);
      if (line) file.header.push(line);
      continue;
    }
    const kind = line[0];
    if (kind === "+") { hunk.lines.push({ kind, text: line.slice(1), next: next++ }); file.added++; }
    else if (kind === "-") { hunk.lines.push({ kind, text: line.slice(1), old: old++ }); file.removed++; }
    else if (kind === " ") hunk.lines.push({ kind, text: line.slice(1), old: old++, next: next++ });
    else if (kind === "\\") hunk.lines.push({ kind, text: line });
  }
  for (const f of files) f.modeOnly = !f.binary && !f.hunks.length;
  return files;
}

// One hunk as a patch git apply takes: the file's header and that hunk alone.
export function hunkPatch(file, hunk) {
  const body = hunk.lines.map((l) => l.kind === "\\" ? l.text : l.kind + l.text);
  return [...file.header, hunk.header, ...body].join("\n") + "\n";
}

// Undoes one hunk in the working tree (never the index), if the file there still reads as the snapshot did.
export async function revert(run, patch) {
  const script = `printf '%s' "$1" | git apply -R --check - && printf '%s' "$1" | git apply -R -`;
  const r = await run("sh", ["-c", script, "sh", patch]);
  if (r.code !== 0) throw new ReviewError(`Not reverted: ${(r.stderr || r.stdout).trim().replace(/^error: /, "")}`);
}
