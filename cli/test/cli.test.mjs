import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../bin/kestrova-scan.mjs";

process.env.KESTROVA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kstate-"));   // never write into examples/

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FOUNDRY = path.join(REPO, "examples", "foundry-vault");
const PREVIEW = { compiler: "0.8.38", counts: { High: 1, Informational: 3 }, detectors: ["reentrancy-eth"],
                  note: "Automated static analysis; not an audit." };

// Local stand-in for the service; records every request so tests can prove no payment is ever attempted.
async function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

function capture() {
  const o = [], e = [];
  return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) };
}

const noPayment = (seen) => seen.every((r) => !("payment-signature" in r.headers) && !("x-payment" in r.headers));

test("preview: summary, exit codes, raw JSON unchanged, attribution, never a payment header", async () => {
  const s = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(PREVIEW)); });
  try {
    let c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url], { ...c, cwd: FOUNDRY }), 0);
    assert.match(c.o.join("\n"), /High: 1/); assert.match(c.o.join("\n"), /reentrancy-eth/);
    assert.match(c.o.join("\n"), /only with your approval/);
    c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--fail-on", "high"], { ...c, cwd: FOUNDRY }), 1);
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--fail-on", "medium"], { ...capture(), cwd: FOUNDRY }), 1);
    c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--json"], { ...c, cwd: FOUNDRY }), 0);
    assert.deepEqual(JSON.parse(c.o.join("\n")), PREVIEW);
    const req = s.seen[0];
    assert.equal(req.method, "POST"); assert.equal(req.url, "/preview?src=cli");
    assert.match(req.headers["user-agent"], /^kestrova-cli\//);
    assert.deepEqual(Object.keys(JSON.parse(req.body).sources).sort(),
                     ["lib/minitoken/src/MiniERC20.sol", "src/Vault.sol", "src/interfaces/IVault.sol"]);
    assert.ok(s.seen.every((r) => r.url.startsWith("/preview")) && noPayment(s.seen));
  } finally { await s.close(); }
});

test("clean preview passes --fail-on high", async () => {
  const s = await server((req, res) => { res.writeHead(200); res.end(JSON.stringify({ counts: { Informational: 1 }, detectors: [] })); });
  try { assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--fail-on", "high"], { ...capture(), cwd: FOUNDRY }), 0); }
  finally { await s.close(); }
});

test("service errors: rate limit, bad source, unreachable -> exit 3 with a clear message", async () => {
  let status = 429;
  const s = await server((req, res) => {
    if (status === 429) { res.writeHead(429, { "retry-after": "600" }); res.end(JSON.stringify({ error: "rate limited" })); }
    else { res.writeHead(400); res.end(JSON.stringify({ detail: "compilation or analysis failed: x" })); }
  });
  try {
    let c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url], { ...c, cwd: FOUNDRY }), 3);
    assert.match(c.e.join("\n"), /preview limit reached; retry in 600s/);
    status = 400; c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url], { ...c, cwd: FOUNDRY }), 3);
    assert.match(c.e.join("\n"), /compilation or analysis failed/);
    assert.ok(noPayment(s.seen));
  } finally { await s.close(); }
  const c = capture();
  assert.equal(await main(["--yes", "--no-cache", "--url", "http://127.0.0.1:9"], { ...c, cwd: FOUNDRY }), 3);
  assert.match(c.e.join("\n"), /cannot reach Kestrova/);
});

test("--terms reads the public 402 offer once and never pays", async () => {
  const offer = { x402Version: 2, accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000", payTo: "CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc" }] };
  const s = await server((req, res) => {
    res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(offer)).toString("base64") }); res.end("{}");
  });
  try {
    const c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--terms"], { ...c, cwd: FOUNDRY }), 0);
    assert.match(c.o.join("\n"), /1 USDC .* payTo CWJdBX/);
    assert.match(c.o.join("\n"), /This tool never pays/);
    assert.equal(s.seen.length, 1); assert.ok(noPayment(s.seen));
  } finally { await s.close(); }
});

test("--dry-run and --bundle never touch the network", async () => {
  const s = await server((req, res) => { res.writeHead(500); res.end(); });
  try {
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--dry-run"], { ...capture(), cwd: FOUNDRY }), 0);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-")), "bundle.json");
    const c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url, "--bundle", out], { ...c, cwd: FOUNDRY }), 0);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(out, "utf8")).sources).length, 3);
    assert.match(c.e.join("\n"), /only with your approval/);
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
});

test("over the free limit: refuses before any request and explains", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "big-"));
  fs.writeFileSync(path.join(root, "foundry.toml"), "");
  fs.mkdirSync(path.join(root, "src"));
  for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(root, "src", `C${i}.sol`), `pragma solidity ^0.8.20;\ncontract C${i} {}\n`);
  const s = await server((req, res) => { res.writeHead(200); res.end("{}"); });
  try {
    const c = capture();
    assert.equal(await main(["--yes", "--no-cache", "--url", s.url], { ...c, cwd: root }), 2);
    assert.match(c.e.join("\n"), /21 files \(limit 20\)/);
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
});

test("usage errors exit 2", async () => {
  assert.equal(await main(["--fail-on", "critical"], capture()), 2);
  assert.equal(await main(["--nope"], capture()), 2);
  assert.equal(await main(["missing-dir"], { ...capture(), cwd: FOUNDRY }), 2);
});

test("runs when started through a symlink (as npm installs bin entries)", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klink-"));
  const link = path.join(dir, "kestrova-scan");
  fs.symlinkSync(path.join(REPO, "cli", "bin", "kestrova-scan.mjs"), link);
  const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0); assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});
