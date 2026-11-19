#!/usr/bin/env node
// prepack: npm copies file modes from the publisher's disk into the tarball. kestrova-scan 0.1.5 was packed from a
// checkout whose files were 0600, so every file shipped as 0600 and the CLI entry point was not executable. Normalize
// what the package ships (directories 0755, files 0644, bin targets 0755), then verify; refuse to pack if the
// filesystem ignores chmod (for example Android shared storage), so a broken tarball can never be published.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bins = new Set(Object.values(typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin || {})
  .map((b) => path.resolve(root, b)));
const entries = [...pkg.files, "package.json", "LICENSE"].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));

const want = new Map();
function walk(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw new Error(`symlink not allowed in the package: ${path.relative(root, p)}`);
  if (st.isDirectory()) {
    want.set(p, 0o755);
    for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  } else {
    want.set(p, bins.has(p) ? 0o755 : 0o644);
  }
}
entries.forEach(walk);
for (const b of bins) if (!want.has(b)) throw new Error(`bin target missing: ${path.relative(root, b)}`);

const bad = [];
for (const [p, mode] of want) {
  fs.chmodSync(p, mode);
  const got = fs.statSync(p).mode & 0o777;
  if (got !== mode) bad.push(`${path.relative(root, p) || "."}: ${got.toString(8)} (want ${mode.toString(8)})`);
}
if (bad.length) {
  console.error("fix-modes: this filesystem does not keep file permissions; pack from a normal Linux/macOS/Termux " +
    "home directory instead.\n" + bad.slice(0, 10).join("\n"));
  process.exit(1);
}
console.error(`fix-modes: ${want.size} paths normalized (bin ${[...bins].map((b) => path.relative(root, b)).join(", ")} 755)`);
