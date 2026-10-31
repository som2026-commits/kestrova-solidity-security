// Where source text comes from: the working tree, the Git index (exactly what will be committed), or a commit.
// All providers take absolute paths inside the project root. Git content is read with `git cat-file` (no checkout,
// nothing written). Untracked dependency trees (node_modules, git submodules such as Foundry's lib/*) are not in the
// commit, so for them a Git provider falls back to the working tree and says so (`depsFromWorktree`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(cwd, args, { input, allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
                                       stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr || e.message || "").toString().trim().split("\n")[0];
    throw new Error(`git ${args[0]} failed: ${msg}`);
  }
}

export function gitTop(cwd) {
  const out = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  return out ? fs.realpathSync(out.trim()) : null;
}

export class FsProvider {
  constructor(root) { this.root = root; this.label = "working tree"; this.depsFromWorktree = false; }
  exists(abs) { return fs.existsSync(abs); }
  isDir(abs) { return fs.existsSync(abs) && fs.statSync(abs).isDirectory(); }
  readdir(abs) { return fs.readdirSync(abs); }
  real(abs) { return fs.realpathSync(abs); }
  size(abs) { return fs.statSync(abs).size; }
  read(abs) { return fs.readFileSync(abs, "utf8"); }
  readText(abs) { return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null; }
}

// rev: a commit-ish, or ":" for the index (staged content).
export class GitProvider {
  constructor(root, rev) {
    this.root = root;
    this.rev = rev;
    this.top = gitTop(root);
    if (!this.top) throw new Error("not a git repository");
    this.fs = new FsProvider(root);
    this.label = rev === ":" ? "staged (index)" : `commit ${rev.slice(0, 12)}`;
    this.files = new Map();          // abs path -> {mode, oid}
    this.submodules = [];
    const out = rev === ":" ? git(this.top, ["ls-files", "-s", "-z"])
      : rev === EMPTY_TREE ? "" : git(this.top, ["ls-tree", "-r", "-z", "--full-tree", rev]);
    for (const rec of out.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const meta = rec.slice(0, tab).split(/\s+/);
      const abs = path.join(this.top, rec.slice(tab + 1));
      // ls-files -s: "<mode> <oid> <stage>"; ls-tree: "<mode> <type> <oid>"
      const [mode, oid] = rev === ":" ? [meta[0], meta[1]] : [meta[0], meta[2]];
      if (mode === "160000") this.submodules.push(abs);
      else if (rev !== ":" || meta[2] === "0") this.files.set(abs, { mode, oid });
    }
    this.dirs = new Set();
    for (const f of this.files.keys()) {
      for (let d = path.dirname(f); d.length >= this.top.length; d = path.dirname(d)) {
        if (this.dirs.has(d)) break;
        this.dirs.add(d);
        if (d === this.top) break;
      }
    }
    this.depsFromWorktree = false;
  }

  _fallback(abs) {
    if (this.files.has(abs) || this.dirs.has(abs)) return false;
    const inSub = this.submodules.some((s) => abs === s || abs.startsWith(s + path.sep));
    const inNm = abs.split(path.sep).includes("node_modules");
    if (inSub || inNm) { this.depsFromWorktree = true; return true; }
    return false;
  }
  exists(abs) { return this.files.has(abs) || this.dirs.has(abs) || (this._fallback(abs) && this.fs.exists(abs)); }
  isDir(abs) { return this.dirs.has(abs) || (this._fallback(abs) && this.fs.isDir(abs)); }
  readdir(abs) {
    if (this._fallback(abs)) return this.fs.readdir(abs);
    const names = new Set();
    for (const p of [...this.files.keys(), ...this.dirs, ...this.submodules])
      if (path.dirname(p) === abs) names.add(path.basename(p));
    return [...names];
  }
  real(abs) {
    const f = this.files.get(abs);
    if (f) {
      if (f.mode === "120000") throw new Error(`symlink in ${this.label}: ${path.relative(this.root, abs)}`);
      return abs;
    }
    if (this._fallback(abs)) return this.fs.real(abs);
    throw new Error(`not in ${this.label}: ${path.relative(this.root, abs)}`);
  }
  read(abs) {
    const f = this.files.get(abs);
    if (f) return git(this.top, ["cat-file", "blob", f.oid]);
    if (this._fallback(abs)) return this.fs.read(abs);
    throw new Error(`not in ${this.label}: ${path.relative(this.root, abs)}`);
  }
  size(abs) { return Buffer.byteLength(this.read(abs)); }
  readText(abs) { return this.files.has(abs) ? this.read(abs) : null; }
}
