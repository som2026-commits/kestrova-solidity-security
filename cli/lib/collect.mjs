// Collect exactly the Solidity sources needed to compile the chosen targets, and nothing else.
//
// Privacy rules (enforced, tested):
//   - only files ending in .sol are ever read or uploaded; .env, keys, configs and build output are never read
//   - only the targets and the files they (transitively) import; unrelated project files are not included
//   - every file must resolve (after symlinks) inside the project root; anything outside is refused
//   - files that look like they contain secrets are refused unless explicitly allowed
// Upload names follow the service's rules (start with a letter/digit/_, [A-Za-z0-9_./-], end .sol). Import strings
// are rewritten to those names in the uploaded copy only; the path text is replaced in place, so every line number
// in a finding still matches the developer's own file.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { context, defaultTargets, findRoot, resolveImport } from "./project.mjs";

export const LIMITS = { files: 20, previewBytes: 60_000, fullBytes: 300_000, maxFileBytes: 300_000 };
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(PRIVATE_KEY|MNEMONIC|SECRET_KEY|API_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{16,}/,
];

export class CollectError extends Error {}

// Blank comments (spaces) and string contents (x) without changing length, so regexes see code only.
export function maskComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      out += "  "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < src.length) { out += "  "; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {   // keep the quotes, blank the contents (same length): "import" in a string is not code
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < src.length) { out += "xx"; i += 2; continue; }
        out += "x"; i++;
      }
      if (i < src.length) out += src[i++];
      continue;
    }
    out += c; i++;
  }
  return out;
}

// [{spec, start, end}] for each import path literal (start/end index the path text inside the quotes)
export function findImports(src) {
  const masked = maskComments(src);
  const re = /\bimport\b([^;"']*?)(["'])(x+)\2/g;   // path contents are masked to x's; read them from `src`
  const out = [];
  for (const m of masked.matchAll(re)) {
    const start = m.index + m[0].length - 1 - m[3].length;
    out.push({ spec: src.slice(start, start + m[3].length), start, end: start + m[3].length });
  }
  return out;
}

export function uploadName(rel) {
  const segs = rel.split(path.sep).join("/").split("/").map((s) => s.replace(/[^A-Za-z0-9_.-]/g, "_"));
  let name = segs.join("/");
  if (!/^[A-Za-z0-9_]/.test(name)) name = "_" + name;
  if (name.length > 124) throw new CollectError(`path too long for upload: ${rel}`);
  return name;
}

function inside(child, parent) {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

function expandTargets(targets, ctx, { includeTests }) {
  const P = ctx.provider;
  const files = [];
  const walk = (p) => {
    if (P.isDir(p)) {
      const base = path.basename(p);
      if (SKIP_DIRS.includes(base)) return;
      if (!includeTests && TEST_DIRS.includes(base) && p !== ctx.root) return;
      for (const e of P.readdir(p).sort()) walk(path.join(p, e));
    } else if (p.endsWith(".sol") && (includeTests || !/\.(t|s)\.sol$/.test(p))) {
      files.push(p);
    }
  };
  for (const t of targets) {
    const abs = path.resolve(ctx.root, t);
    if (!P.exists(abs)) throw new CollectError(`target not found: ${t}`);
    walk(abs);
  }
  return [...new Set(files)];
}

export const SKIP_DIRS = ["node_modules", ".git", "out", "cache", "artifacts", "broadcast", "typechain-types", ".kestrova"];
export const TEST_DIRS = ["test", "tests", "script", "scripts"];

export function projectContext({ cwd = process.cwd(), provider } = {}) {
  const { root, kind } = findRoot(cwd);
  return context(root, kind, provider);
}

// All target .sol files of the project (as the provider sees them), e.g. to build the reverse import graph.
export function targetFiles(ctx, { targets = [], includeTests = false } = {}) {
  const t = targets.length ? targets : defaultTargets(ctx.root, ctx.kind, ctx.provider);
  return expandTargets(t.filter((x) => ctx.provider.exists(path.resolve(ctx.root, x))), ctx, { includeTests });
}

// abs -> [abs of direct imports] for the given files (resolution only; nothing is uploaded).
export function importEdges(ctx, files) {
  const edges = new Map();
  for (const f of files) {
    try {
      edges.set(f, findImports(ctx.provider.read(f)).map((i) => resolveImport(i.spec, f, ctx)));
    } catch { edges.set(f, []); }
  }
  return edges;
}

export function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

export function collect({ cwd = process.cwd(), targets = [], includeTests = false, allowSecrets = false, provider,
                          ctx, entryFiles } = {}) {
  ctx = ctx || projectContext({ cwd, provider });
  const P = ctx.provider;
  const entry = entryFiles || expandTargets(targets.length ? targets : defaultTargets(ctx.root, ctx.kind, P), ctx, { includeTests });
  if (!entry.length) throw new CollectError("no .sol files found in the targets");

  const byReal = new Map();          // canonical path -> {rel, name, src, imports:[{start,end,abs}]}
  const canon = new Map();           // any path seen -> canonical path
  const queue = entry.map((p) => ({ abs: p, via: null }));
  while (queue.length) {
    const { abs, via } = queue.shift();
    if (!abs.endsWith(".sol")) throw new CollectError(`refusing non-Solidity import ${abs} (from ${via})`);
    if (!P.exists(abs)) throw new CollectError(`import not found: ${path.relative(ctx.root, abs)} (from ${via})`);
    let real;
    try { real = P.real(abs); } catch (e) { throw new CollectError(`refusing ${path.relative(ctx.root, abs)}: ${e.message}`); }
    canon.set(abs, real);
    if (byReal.has(real)) continue;
    const nm = inside(real, ctx.root) ? null : (ctx.nodeModulesReal || []).find((d) => inside(real, d));
    if (!inside(real, ctx.root) && !nm) throw new CollectError(`refusing file outside the project: ${abs} (from ${via})`);
    const src = P.read(real);
    if (Buffer.byteLength(src) > LIMITS.maxFileBytes) throw new CollectError(`file too large to upload: ${path.relative(ctx.root, real)}`);
    if (!allowSecrets && SECRET_PATTERNS.some((re) => re.test(src)))
      throw new CollectError(`${path.relative(ctx.root, real)} looks like it contains a secret; not uploading it`);
    // Hoisted/symlinked dependencies keep a node_modules/... name; nothing outside node_modules is ever accepted.
    const rel = nm ? path.join("node_modules", path.relative(nm, real)) : path.relative(ctx.root, real);
    const node = { rel, name: uploadName(rel), src, imports: [] };
    byReal.set(real, node);
    for (const imp of findImports(src)) {
      const target = resolveImport(imp.spec, real, ctx);
      node.imports.push({ ...imp, abs: target });
      queue.push({ abs: target, via: rel });
    }
  }
  const sources = {};
  const files = [];
  const names = new Set();
  for (const node of byReal.values()) {
    if (names.has(node.name)) throw new CollectError(`two files map to the same upload name: ${node.name}`);
    names.add(node.name);
    let out = "", last = 0;
    for (const imp of node.imports) {
      out += node.src.slice(last, imp.start) + byReal.get(canon.get(imp.abs)).name;
      last = imp.end;
    }
    sources[node.name] = out + node.src.slice(last);
    files.push({ file: node.rel, upload: node.name, bytes: Buffer.byteLength(sources[node.name]),
                 sha256: sha256(node.src), dependency: /(^|\/)(node_modules|lib)\//.test(node.rel) });
  }
  const bytes = files.reduce((a, f) => a + f.bytes, 0);
  return { root: ctx.root, kind: ctx.kind, sources, files, bytes, source: P.label,
           depsFromWorktree: !!P.depsFromWorktree, entry: entry.map((p) => path.relative(ctx.root, p)) };
}

export function checkLimits(bundle, mode) {
  const maxBytes = mode === "full" ? LIMITS.fullBytes : LIMITS.previewBytes;
  const problems = [];
  if (bundle.files.length > LIMITS.files) problems.push(`${bundle.files.length} files (limit ${LIMITS.files})`);
  if (bundle.bytes > maxBytes) problems.push(`${bundle.bytes} bytes (limit ${maxBytes} for ${mode})`);
  return problems;
}

