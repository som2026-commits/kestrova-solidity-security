// Shared test helpers: throwaway git repositories and a stand-in Kestrova service whose answer depends on the
// uploaded source text (REENTRANCY_BUG -> reentrancy-eth High, tx.origin -> tx-origin Medium, BROKEN -> 400).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const PRAGMA = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n";

export function sh(cwd, args, env = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
}

export function repo(files, { kind = "foundry" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kgit-")));
  sh(root, ["init", "-q", "-b", "main"]);
  sh(root, ["config", "user.email", "t@example.com"]);
  sh(root, ["config", "user.name", "t"]);
  sh(root, ["config", "commit.gpgsign", "false"]);
  write(root, kind === "foundry" ? { "foundry.toml": '[profile.default]\nsrc = "src"\n' } : { "hardhat.config.js": "module.exports = {};\n" });
  write(root, files);
  commit(root, "base");
  return root;
}

export function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    if (body === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

export function commit(root, msg) {
  sh(root, ["add", "-A"]);
  sh(root, ["commit", "-q", "--no-verify", "-m", msg]);
  return sh(root, ["rev-parse", "HEAD"]).trim();
}

export function contract(name, body = "", imports = []) {
  return PRAGMA + imports.map((i) => `import "${i}";\n`).join("") + `contract ${name} {\n${body}\n}\n`;
}

export function analyze(sources) {
  const all = Object.values(sources).join("\n");
  if (all.includes("BROKEN")) return { status: 400, body: { detail: "compilation or analysis failed: Error: BROKEN" } };
  const high = (all.match(/REENTRANCY_BUG/g) || []).length;
  const med = (all.match(/tx\.origin/g) || []).length;
  const counts = { Informational: 1 };
  if (high) counts.High = high;
  if (med) counts.Medium = med;
  const detectors = [...(high ? ["reentrancy-eth"] : []), ...(med ? ["tx-origin"] : [])];
  return { status: 200, body: { compiler: "0.8.38", counts, detectors, note: "Automated static analysis; not an audit." } };
}

export async function service({ status } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, headers: req.headers, sources: parsed.sources || {} });
      if (status) { res.writeHead(status, { "retry-after": "900" }); res.end(JSON.stringify({ error: "rate limited" })); return; }
      const r = analyze(parsed.sources || {});
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

export function capture() {
  const o = [], e = [];
  return { o, e, out: (s) => o.push(s), err: (s) => e.push(s), text: () => o.join("\n") + "\n" + e.join("\n") };
}

export function stateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "kstate-")); }
