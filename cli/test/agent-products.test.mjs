// SARIF conversion and the AgentKit / Solana Agent Kit adapters (payment cap, never pays by default).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../bin/kestrova-scan.mjs";
import { toSarif } from "../lib/sarif.mjs";
import { contractRiskCheck, contractRiskPreview, paidCall } from "../../integrations/agent-frameworks/core.mjs";
import { createKestrovaActionProvider } from "../../integrations/agent-frameworks/agentkit.mjs";
import { createKestrovaPlugin } from "../../integrations/agent-frameworks/solana-agent-kit.mjs";

const TOKEN = "0x1111111111111111111111111111111111111111";
const REPORT = { compiler: "0.8.38", counts: { High: 1, Low: 1 }, findings: [
  { detector: "reentrancy-eth", impact: "High", confidence: "Medium", description: "Reentrancy in V.withdraw() (src/V.sol#21-26)",
    locations: [{ file: "src/V.sol", lines: [21, 26] }] },
  { detector: "missing-zero-check", impact: "Low", confidence: "Medium", description: "V.set(address) lacks a zero-check",
    locations: [{ file: "src/V.sol", lines: [30, 30] }] }] };

test("SARIF 2.1.0: rules, levels, regions, fingerprints; address-risk own-code findings too", async () => {
  const s = toSarif(REPORT);
  assert.equal(s.version, "2.1.0");
  const run = s.runs[0];
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ["reentrancy-eth", "missing-zero-check"]);
  assert.equal(run.results[0].level, "error"); assert.equal(run.results[1].level, "note");
  assert.deepEqual(run.results[0].locations[0].physicalLocation.region, { startLine: 21, endLine: 26 });
  assert.match(run.results[0].partialFingerprints["kestrovaFinding/v1"], /^[0-9a-f]{16}$/);
  assert.match(run.properties.note, /not an audit/);
  const risk = toSarif({ schema: "kestrova.address-risk/v1", findings: { own_code: [
    { detector: "tx-origin", impact: "Medium", confidence: "Medium", file: "contracts/T.sol", lines: [9, 9], description: "x" }] } });
  assert.equal(risk.runs[0].results[0].level, "warning");
  assert.throws(() => toSarif({ nope: 1 }), /not a Kestrova report/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-"));
  fs.writeFileSync(path.join(dir, "r.json"), JSON.stringify(REPORT));
  const e = [];
  assert.equal(await main(["--to-sarif", "r.json", "--sarif-out", "out.sarif"], { cwd: dir, out: () => {}, err: (x) => e.push(x),
    fetchImpl: () => { throw new Error("no network"); } }), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "out.sarif"), "utf8")).runs[0].results.length, 2);
});

// Stand-in service: free preview, and a paid route that requires a payment header (402 + offer otherwise).
async function service() {
  const seen = [];
  const offer = (amount) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount, payTo: "CWJdBX", asset: "EPjF" }] })).toString("base64");
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers });
      const route = req.url.split("?")[0];
      if (route === "/risk/address/preview") { res.writeHead(200); res.end(JSON.stringify({ verified: true, privileges: [] })); return; }
      if (route === "/risk/address" || route === "/scan/highlights") {
        if (!req.headers["payment-signature"]) {
          res.writeHead(402, { "payment-required": offer(route === "/risk/address" ? "50000" : "100000") }); res.end("{}"); return;
        }
        res.writeHead(200); res.end(JSON.stringify({ verdict: "high" })); return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

// A stand-in x402 client: the real one (your wallet) would sign; this only marks the request as paid and counts.
function fakePaymentFetch(counter) {
  return (u, init) => { counter.n++; return fetch(u, { ...init, headers: { ...init.headers, "payment-signature": "test" } }); };
}

test("paid actions never pay by default; the cap is enforced before any payment; free preview works", async () => {
  const s = await service();
  const paidCount = { n: 0 };
  try {
    assert.equal((await contractRiskPreview({ chain: "base", address: TOKEN }, { url: s.url })).verified, true);
    let r = await contractRiskCheck({ chain: "base", address: TOKEN }, { url: s.url });
    assert.equal(r.paid, false); assert.equal(r.priceUsd, 0.05); assert.match(r.message, /payment not configured/);
    r = await contractRiskCheck({ chain: "base", address: TOKEN }, { url: s.url, paymentFetch: fakePaymentFetch(paidCount) });
    assert.equal(r.paid, false); assert.match(r.message, /above maxPaymentUsd 0/); assert.equal(paidCount.n, 0);
    r = await paidCall("/scan/highlights", { sources: {} }, { url: s.url, paymentFetch: fakePaymentFetch(paidCount), maxPaymentUsd: 0.05 });
    assert.equal(r.paid, false); assert.equal(paidCount.n, 0);                     // 0.10 > 0.05 cap
    r = await contractRiskCheck({ chain: "base", address: TOKEN }, { url: s.url, paymentFetch: fakePaymentFetch(paidCount), maxPaymentUsd: 0.05 });
    assert.equal(r.paid, true); assert.equal(r.result.verdict, "high"); assert.equal(paidCount.n, 1);
    assert.ok(s.seen.every((x) => x.headers["payment-signature"] !== "test" || x.url.startsWith("/risk/address?")));
  } finally { await s.close(); }
});

// Real framework packages when available (installed outside the repo: KESTROVA_FW_NODE_MODULES=/path/node_modules).
const FW = process.env.KESTROVA_FW_NODE_MODULES;
const imp = (pkg, sub) => import(pathToFileURL(path.join(FW, pkg, sub)).href);

test("AgentKit: real customActionProvider registers 4 actions with zod schemas; actions run", { skip: !FW && "set KESTROVA_FW_NODE_MODULES" }, async () => {
  const { customActionProvider } = await import(pathToFileURL(path.join(FW, "@coinbase/agentkit/dist/index.js")).href);
  const { z } = await import(pathToFileURL(path.join(FW, "zod/index.js")).href).catch(() => imp("zod", "lib/index.js"));
  const s = await service();
  // AgentKit itself posts invocation analytics to Coinbase (cca-lite.coinbase.com) on every action, unhandled if
  // unreachable; this sandbox blocks that host, so answer only that host locally. Kestrova code sends no telemetry.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => (String(u).includes("cca-lite.coinbase.com") ? Promise.resolve(new Response("{}")) : realFetch(u, init));
  try {
    const provider = createKestrovaActionProvider({ customActionProvider, z }, { url: s.url });
    const actions = provider.getActions({});
    const names = actions.map((a) => a.name);
    assert.ok(["kestrova_contract_risk_preview", "kestrova_contract_risk_check", "kestrova_solidity_preview",
               "kestrova_solidity_highlights"].every((n) => names.some((x) => x.endsWith(n))), names.join(","));
    const preview = actions.find((a) => a.name.endsWith("kestrova_contract_risk_preview"));
    assert.equal(JSON.parse(await preview.invoke({ chain: "base", address: TOKEN })).verified, true);
    const paidAct = actions.find((a) => a.name.endsWith("kestrova_contract_risk_check"));
    assert.equal(JSON.parse(await paidAct.invoke({ chain: "base", address: TOKEN })).paid, false);
    assert.equal(paidAct.schema.safeParse({ chain: "base", address: "nope" }).success, false);
  } finally { globalThis.fetch = realFetch; await s.close(); }
});

test("Solana Agent Kit: plugin shape matches the Plugin/Action interfaces; handlers never throw", async () => {
  let z;
  if (FW) z = (await import(pathToFileURL(path.join(FW, "zod/index.js")).href).catch(() => imp("zod", "lib/index.js"))).z;
  else z = { object: (o) => ({ parse: (v) => v, shape: o }), enum: () => ({}), string: () => ({ regex: () => ({}) }), record: () => ({}) };
  const s = await service();
  try {
    const plugin = createKestrovaPlugin({ z }, { url: s.url });
    assert.equal(plugin.name, "kestrova"); assert.equal(typeof plugin.initialize, "function");
    assert.equal(plugin.actions.length, 4);
    for (const a of plugin.actions) {
      assert.ok(a.name && Array.isArray(a.similes) && a.description && a.schema && typeof a.handler === "function");
      assert.ok(Array.isArray(a.examples) && Array.isArray(a.examples[0]) && "explanation" in a.examples[0][0]);
    }
    const res = await plugin.actions[0].handler({}, { chain: "base", address: TOKEN });
    assert.equal(res.status, "success");
    const paid = await plugin.methods.kestrovaContractRiskCheck({ chain: "base", address: TOKEN });
    assert.equal(paid.paid, false);
  } finally { await s.close(); }
});
