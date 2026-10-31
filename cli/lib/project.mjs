// Project detection (Foundry / Hardhat / plain) and import resolution. Reads only *.sol files and the project's
// remapping configuration (foundry.toml, remappings.txt). Never reads .env or any other file.
// Every read goes through a source provider (working tree, Git index or a commit; see sources.mjs).
import fs from "node:fs";
import path from "node:path";
import { FsProvider } from "./sources.mjs";

const HARDHAT_CONFIGS = ["hardhat.config.js", "hardhat.config.ts", "hardhat.config.cjs", "hardhat.config.mjs"];

export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "foundry.toml"))) return { root: dir, kind: "foundry" };
    if (HARDHAT_CONFIGS.some((f) => fs.existsSync(path.join(dir, f)))) return { root: dir, kind: "hardhat" };
    const parent = path.dirname(dir);
    if (parent === dir) return { root: path.resolve(start), kind: "plain" };
    dir = parent;
  }
}

// Minimal foundry.toml reader: only `src`, `libs` and `remappings` in the [profile.default] (or top) section.
export function readFoundryToml(root, provider = new FsProvider(root)) {
  const out = { src: "src", libs: ["lib"], remappings: [] };
  const text = provider.readText(path.join(root, "foundry.toml"));
  if (text == null) return out;
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, "").trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim(); continue; }
    if (section && section !== "profile.default" && section !== "default") continue;
    let m = line.match(/^src\s*=\s*["']([^"']+)["']/);
    if (m) out.src = m[1];
    m = line.match(/^(libs|remappings)\s*=\s*\[(.*)$/);
    if (m) {
      let body = m[2];
      while (!body.includes("]") && i + 1 < lines.length) body += " " + lines[++i].replace(/#.*$/, "");
      const items = [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
      if (m[1] === "libs") out.libs = items; else out.remappings.push(...items);
    }
  }
  return out;
}

export function loadRemappings(root, kind, provider = new FsProvider(root)) {
  const maps = [];
  const add = (line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const ctxless = t.includes(":") && t.indexOf(":") < t.indexOf("=") ? t.slice(t.indexOf(":") + 1) : t;
    const eq = ctxless.indexOf("=");
    if (eq <= 0) return;
    maps.push({ prefix: ctxless.slice(0, eq), target: ctxless.slice(eq + 1) });
  };
  if (kind === "foundry") {
    const toml = readFoundryToml(root, provider);
    toml.remappings.forEach(add);
    // forge's automatic remappings for installed libraries: "<name>/" -> lib/<name>/src/ (or lib/<name>/)
    for (const lib of toml.libs) {
      const dir = path.join(root, lib);
      if (!provider.isDir(dir)) continue;
      for (const name of provider.readdir(dir).sort()) {
        const base = path.join(dir, name);
        if (!provider.isDir(base)) continue;
        const target = provider.exists(path.join(base, "src")) ? `${lib}/${name}/src/` : `${lib}/${name}/`;
        if (!maps.some((m) => m.prefix === `${name}/`)) maps.push({ prefix: `${name}/`, target, auto: true });
      }
    }
  }
  const rtxt = provider.readText(path.join(root, "remappings.txt"));
  if (rtxt != null) rtxt.split(/\r?\n/).forEach(add);
  // explicit remappings win over automatic ones; longer prefixes win (solc semantics)
  return maps.sort((a, b) => (a.auto === b.auto ? b.prefix.length - a.prefix.length : a.auto ? 1 : -1));
}

export function defaultTargets(root, kind, provider = new FsProvider(root)) {
  if (kind === "foundry") return [readFoundryToml(root, provider).src];
  if (kind === "hardhat") return ["contracts"];
  return ["."];
}

function nodeModulesDirs(root) {
  const dirs = [];
  let dir = root;
  for (;;) {
    const nm = path.join(dir, "node_modules");
    if (fs.existsSync(nm)) dirs.push(nm);
    const parent = path.dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

// Resolve an import string from `fromFile` to an absolute path (not yet checked for confinement).
export function resolveImport(spec, fromFile, ctx) {
  if (spec.startsWith("./") || spec.startsWith("../")) return path.resolve(path.dirname(fromFile), spec);
  for (const m of ctx.remappings) {
    if (spec.startsWith(m.prefix)) {
      const p = path.resolve(ctx.root, m.target + spec.slice(m.prefix.length));
      if (ctx.provider.exists(p)) return p;
    }
  }
  for (const nm of ctx.nodeModules) {
    const p = path.join(nm, spec);
    if (ctx.provider.exists(p)) return p;
  }
  return path.resolve(ctx.root, spec);   // solc base-path semantics
}

export function context(root, kind, provider) {
  const real = fs.realpathSync(root);
  provider = provider || new FsProvider(real);
  const nodeModules = nodeModulesDirs(real);
  // Dependency trees that may live outside the project (hoisted workspaces, symlinked node_modules): canonical paths.
  const nodeModulesReal = [...new Set(nodeModules.map((d) => { try { return fs.realpathSync(d); } catch { return d; } }))];
  return { root: real, kind, provider, remappings: loadRemappings(real, kind, provider), nodeModules, nodeModulesReal };
}
