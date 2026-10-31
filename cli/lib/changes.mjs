// Change-aware scope: which Solidity files changed since a base commit (or are staged), and which project contracts
// they affect. "Affected" = changed target files + every target file that (transitively) imports a changed file,
// because a change in a base contract or library can create a vulnerability in the contracts that use it.
// The base side is the SAME set of entry files at the base commit (renames mapped back), so both previews compare
// like with like. Nothing here uploads anything.
import path from "node:path";
import { importEdges, projectContext, targetFiles } from "./collect.mjs";
import { EMPTY_TREE, GitProvider, git, gitTop } from "./sources.mjs";

export class ChangeError extends Error {}

export function verifyCommit(top, ref) {
  const out = git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return out ? out.trim() : null;
}

export function defaultBaseRef(top) {
  for (const r of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (verifyCommit(top, r)) return r;
  }
  return "HEAD";
}

// Resolve REF to the commit to compare against. Branch refs use the merge-base with HEAD (changes made on this branch).
export function resolveBase(top, ref) {
  const head = verifyCommit(top, "HEAD");
  if (!head) return { ref, sha: EMPTY_TREE, note: "no commits yet: everything counts as new" };
  const sha = verifyCommit(top, ref);
  if (!sha) throw new ChangeError(`unknown git revision: ${ref}`);
  if (sha === head) return { ref, sha };
  const mb = git(top, ["merge-base", sha, head], { allowFail: true });
  return { ref, sha: mb ? mb.trim() : sha, note: mb && mb.trim() !== sha ? `merge-base of ${ref} and HEAD` : undefined };
}

function parseNameStatus(out, top) {
  const parts = out.split("\0");
  const rows = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++];
    const code = status[0];
    if (code === "R" || code === "C") {
      rows.push({ code, similarity: Number(status.slice(1)) || 0, oldPath: path.join(top, parts[i++]), path: path.join(top, parts[i++]) });
    } else {
      const p = path.join(top, parts[i++]);
      rows.push({ code, path: code === "D" ? null : p, oldPath: code === "A" ? null : p });
    }
  }
  return rows;
}

// mode: "worktree" (working tree incl. untracked, vs base) or "staged" (index vs base)
export function changedSolidity(root, base, mode) {
  const top = gitTop(root);
  if (!top) throw new ChangeError("not inside a git repository");
  const args = mode === "staged" ? ["diff", "--cached", "--name-status", "-M", "-z", base, "--"]
                                 : ["diff", "--name-status", "-M", "-z", base, "--"];
  const rows = parseNameStatus(git(top, args), top);
  if (mode === "worktree") {
    for (const f of git(top, ["ls-files", "-o", "--exclude-standard", "-z"]).split("\0").filter(Boolean))
      rows.push({ code: "A", path: path.join(top, f), oldPath: null, untracked: true });
  }
  const inRoot = (p) => p && (p === root || p.startsWith(root + path.sep));
  return rows.filter((r) => [r.path, r.oldPath].some((p) => p && p.endsWith(".sol") && inRoot(p)))
             .map((r) => ({ ...r, path: inRoot(r.path) ? r.path : null, oldPath: inRoot(r.oldPath) ? r.oldPath : null }));
}

// Staged files whose working-tree copy differs from what is staged (the commit is NOT what is on disk).
export function partiallyStaged(root, files) {
  const top = gitTop(root);
  if (!files.length) return [];
  const out = git(top, ["diff", "--name-only", "-z", "--", ...files.map((f) => path.relative(top, f))]);
  return out.split("\0").filter(Boolean).map((f) => path.join(top, f));
}

function reverseClosure(edges, seeds) {
  const importers = new Map();
  for (const [file, deps] of edges) for (const d of deps) {
    if (!importers.has(d)) importers.set(d, new Set());
    importers.get(d).add(file);
  }
  const out = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const f = queue.shift();
    for (const imp of importers.get(f) || []) if (!out.has(imp)) { out.add(imp); queue.push(imp); }
  }
  return out;
}

/**
 * Plan a change-aware scan.
 * @returns {{current:{ctx,entry}, base:{ctx,entry}, rows, renames, deleted, added, dependents, outsideTargets}}
 */
export function planChanged({ cwd = process.cwd(), baseRef, mode = "worktree", includeTests = false, targets = [] }) {
  const probe = projectContext({ cwd });
  const root = probe.root;
  const top = gitTop(root);
  if (!top) throw new ChangeError("not inside a git repository (use a plain scan instead)");
  const base = resolveBase(top, baseRef || (mode === "staged" ? "HEAD" : defaultBaseRef(top)));
  const rows = changedSolidity(root, base.sha, mode);

  const curCtx = projectContext({ cwd, provider: mode === "staged" ? new GitProvider(root, ":") : undefined });
  const baseCtx = projectContext({ cwd, provider: new GitProvider(root, base.sha) });
  const curTargets = targetFiles(curCtx, { targets, includeTests });
  const baseTargets = new Set(targetFiles(baseCtx, { targets, includeTests }));
  const curTargetSet = new Set(curTargets);

  const renames = rows.filter((r) => r.code === "R" && r.path && r.oldPath).map((r) => ({ from: r.oldPath, to: r.path }));
  const toOld = new Map(renames.map((r) => [r.to, r.from]));
  const seeds = new Set();
  for (const r of rows) { if (r.path) seeds.add(r.path); if (r.oldPath) seeds.add(r.oldPath); }

  const edges = importEdges(curCtx, curTargets);
  const dependents = [...reverseClosure(edges, seeds)].filter((f) => curTargetSet.has(f) && !seeds.has(f));
  const changedTargets = rows.map((r) => r.path).filter((p) => p && curTargetSet.has(p));
  const currentEntry = [...new Set([...changedTargets, ...dependents])].sort();

  // Base entries: the same files at the base commit (renamed files under their old name) + deleted target files.
  const baseEntry = new Set();
  for (const f of currentEntry) {
    const old = toOld.get(f) || f;
    if (baseTargets.has(old)) baseEntry.add(old);
  }
  const deleted = rows.filter((r) => r.code === "D" && r.oldPath && baseTargets.has(r.oldPath)).map((r) => r.oldPath);
  deleted.forEach((d) => baseEntry.add(d));
  const added = rows.filter((r) => (r.code === "A" || r.code === "C") && r.path).map((r) => r.path);
  const outsideTargets = rows.filter((r) => ![r.path, r.oldPath].some((p) => p && (curTargetSet.has(p) || baseTargets.has(p))))
                             .map((r) => r.path || r.oldPath);
  return {
    root, top, base, mode, rows,
    current: { ctx: curCtx, entry: currentEntry },
    base_: { ctx: baseCtx, entry: [...baseEntry].sort() },
    renames, deleted, added, dependents, outsideTargets,
  };
}
