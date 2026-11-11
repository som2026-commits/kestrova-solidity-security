// Keeps the published client configs, install links and docs consistent with each other.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
const MCP = "https://kestrova-api.onrender.com/mcp";

test("client configs have the exact shape each client expects", () => {
  const claude = JSON.parse(read("configs/claude-mcp.json")).mcpServers.kestrova;
  assert.deepEqual(claude, { type: "http", url: `${MCP}?src=claude` });
  const cursor = JSON.parse(read("configs/cursor-mcp.json")).mcpServers.kestrova;
  assert.deepEqual(cursor, { url: `${MCP}?src=cursor` });
  const vscode = JSON.parse(read("configs/vscode-mcp.json")).servers.kestrova;
  assert.deepEqual(vscode, { type: "http", url: `${MCP}?src=vscode` });
  const plugin = JSON.parse(read("solidity-security-review/.mcp.json")).mcpServers.kestrova;
  assert.equal(plugin.type, "http"); assert.ok(plugin.url.startsWith(MCP));
});

test("install links in the docs decode to the same configs", () => {
  const doc = read("docs/INTEGRATIONS.md");
  const cursorLink = doc.match(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=kestrova&config=([A-Za-z0-9+/=]+)/);
  assert.ok(cursorLink);
  assert.deepEqual(JSON.parse(Buffer.from(cursorLink[1], "base64").toString()), JSON.parse(read("configs/cursor-mcp.json")).mcpServers.kestrova);
  const vsLink = doc.match(/vscode:mcp\/install\?(%7B[^\s`]+)/);
  assert.ok(vsLink);
  const vs = JSON.parse(decodeURIComponent(vsLink[1]));
  assert.deepEqual({ type: vs.type, url: vs.url }, JSON.parse(read("configs/vscode-mcp.json")).servers.kestrova);
  assert.equal(vs.name, "kestrova");
});

test("docs never claim official status, always say not an audit, and never pay by default", () => {
  for (const f of ["docs/QUICKSTART.md", "docs/INTEGRATIONS.md", "docs/DAILY_WORKFLOW.md", "docs/ACCURACY.md", "cli/README.md", "integrations/agent-frameworks/README.md"]) {
    const t = read(f);
    assert.match(t, /not an audit/i, f);
    assert.doesNotMatch(t, /official (partner|integration of|plugin of)|endorsed by|in partnership with/i, f);
  }
  assert.match(read("docs/INTEGRATIONS.md"), /not official integrations/);
  assert.doesNotMatch(read("cli/lib/client.mjs"), /payment-signature"?\s*:|x-payment"?\s*:/i);
});

test("CI example never pays, needs no secrets and does not block on service errors", () => {
  const ci = read("examples/ci/kestrova.yml");
  assert.doesNotMatch(ci, /\$\{\{\s*secrets\.|PRIVATE_KEY|--bundle|\/scan\b/);
  assert.match(ci, /3\) echo "::warning::Kestrova unavailable or rate-limited; not blocking"; exit 0/);
  assert.match(ci, /contents: read/);
});

test("the published CLI package ships only the CLI, README and Claude plugin files, with no payment or telemetry code", () => {
  const pkg = JSON.parse(read("cli/package.json"));
  assert.deepEqual(pkg.files, ["bin", "lib", "README.md", ".claude-plugin", ".mcp.json", "skills", "claude-marketplace.json"]);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.postinstall ?? pkg.scripts.install ?? pkg.scripts.preinstall, undefined);
  for (const dir of ["cli/bin", "cli/lib"])
    for (const f of fs.readdirSync(path.join(REPO, dir)))
      assert.doesNotMatch(read(`${dir}/${f}`), /PAYMENT-SIGNATURE"\s*\]\s*=|signTransaction|secretKey|analytics|telemetry\(/, `${dir}/${f}`);
});
