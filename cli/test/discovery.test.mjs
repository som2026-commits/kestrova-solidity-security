// Discovery surface shipped in the npm package: `--setup` output, the bundled Claude Code plugin and its marketplace.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../bin/kestrova-scan.mjs";
import { CLIENTS, setupText } from "../lib/setup.mjs";
import { VERSION } from "../lib/client.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(CLI, "..");
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const MCP = "https://kestrova-api.onrender.com/mcp";

async function run(argv) {
  const out = [], err = [];
  const fetchImpl = () => { throw new Error("--setup must not use the network"); };
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), fetchImpl, cwd: CLI });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("--setup lists every client and prints offline, without writing files", async () => {
  const before = fs.readdirSync(CLI).sort();
  const r = await run(["--setup"]);
  assert.equal(r.code, 0);
  for (const k of Object.keys(CLIENTS)) assert.match(r.out, new RegExp(`--setup ${k}\\b`));
  for (const k of Object.keys(CLIENTS)) {
    const c = await run(["--setup", k]);
    assert.equal(c.code, 0, k);
    assert.match(c.out, /Never call scan_solidity_full/);
    assert.match(c.out, /not an audit/i);
  }
  assert.deepEqual(fs.readdirSync(CLI).sort(), before);
  assert.equal((await run(["--setup", "nope"])).code, 2);
});

test("--setup snippets match the repository's tested client configs exactly", () => {
  const body = (k) => CLIENTS[k].file().body;
  assert.deepEqual(JSON.parse(body("claude")), json(path.join(REPO, "configs/claude-mcp.json")));
  assert.deepEqual(JSON.parse(body("cursor")), json(path.join(REPO, "configs/cursor-mcp.json")));
  assert.deepEqual(JSON.parse(body("vscode")), json(path.join(REPO, "configs/vscode-mcp.json")));
  assert.deepEqual(JSON.parse(body("gemini")), json(path.join(REPO, "configs/gemini-settings.json")));
  const toml = fs.readFileSync(path.join(REPO, "configs/codex-config.toml"), "utf8");
  for (const line of body("codex").split("\n")) assert.ok(toml.includes(line), line);
  // Cursor deeplink carries base64 of {"url": ...}; Codex uses the documented `--url` flag.
  const link = setupText("cursor").match(/config=([A-Za-z0-9+/=]+)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(link, "base64").toString()), { url: `${MCP}?src=cursor` });
  assert.match(setupText("codex"), /codex mcp add kestrova --url "https:\/\/kestrova-api\.onrender\.com\/mcp\?src=codex"/);
});

test("bundled Claude Code plugin: manifest, skill, MCP config and an npm-sourced marketplace pinned to this version", () => {
  const plugin = json(path.join(CLI, ".claude-plugin/plugin.json"));
  assert.equal(plugin.name, "solidity-security-review");
  assert.doesNotMatch(JSON.stringify(plugin), /github\.com/);
  const skill = fs.readFileSync(path.join(CLI, "skills/solidity-security-review/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: solidity-security-review\ndescription: .+\n---\n/);
  assert.match(skill, /Ask the user first/);
  assert.ok(fs.existsSync(path.join(CLI, "skills/solidity-security-review/reference/x402-payment.md")));
  assert.deepEqual(json(path.join(CLI, ".mcp.json")).mcpServers.kestrova, { type: "http", url: `${MCP}?src=claude-plugin` });
  const m = json(path.join(CLI, "claude-marketplace.json"));
  assert.equal(m.name, "kestrova");
  assert.equal(m.plugins.length, 1);
  const [p] = m.plugins;
  assert.equal(p.name, plugin.name);
  assert.equal(p.version, plugin.version);
  assert.deepEqual(p.source, { source: "npm", package: "kestrova-scan", version: VERSION });
  assert.equal(json(path.join(CLI, "package.json")).version, VERSION);
  // The installed package directory is itself a marketplace (`claude plugin marketplace add <pkg dir>`): Claude Code
  // 2.1.316 fails to load a single-file marketplace ("cache-miss"), but loads a directory one.
  const local = json(path.join(CLI, ".claude-plugin/marketplace.json"));
  assert.deepEqual({ ...local, plugins: [{ ...local.plugins[0], source: null }] }, { ...m, plugins: [{ ...p, source: null }] });
  assert.equal(local.plugins[0].source, "./");
  assert.match(fs.readFileSync(path.join(CLI, "README.md"), "utf8"), /claude plugin marketplace add "\$\(npm root -g\)\/kestrova-scan"\n/);
});

test("npm README: real commands only, honest pricing, no dead GitHub links", () => {
  const md = fs.readFileSync(path.join(CLI, "README.md"), "utf8");
  assert.doesNotMatch(md, /github\.com\/som2026/);
  assert.match(md, /not an audit/i);
  assert.match(md, /1\.00 USDC per scan via x402 on Solana, charged only if the scan succeeds/);
  assert.match(md, new RegExp(`kestrova-scan@${VERSION.replace(/\./g, "\\.")}`));
  for (const flag of md.matchAll(/kestrova-scan[^`\n]*?(--[a-z-]+)/g))
    assert.ok(fs.readFileSync(path.join(CLI, "bin/kestrova-scan.mjs"), "utf8").includes(`"${flag[1]}"`), flag[1]);
});
