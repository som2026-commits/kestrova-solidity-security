import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../bin/kestrova-scan.mjs";
import { comparePreviews, compareReports, fingerprint, gate } from "../lib/compare.mjs";
import { capture, commit, contract, repo, service, sh, stateDir, write } from "./helpers.mjs";

const run = (root, s, args, extra = {}) => {
  const c = capture();
  return main(["--yes", "--state-dir", extra.state || stateDir(), "--url", s.url, ...args], { ...c, cwd: root, ...extra.opts })
    .then((code) => ({ code, c }));
};
const sent = (s) => s.seen.flatMap((r) => Object.keys(r.sources));

test("changed: only changed contracts and the contracts importing them are uploaded; new High is NEW", async () => {
  const root = repo({
    "src/Lib.sol": contract("Lib", "uint256 public x;"),
    "src/Vault.sol": contract("Vault", "", ["./Lib.sol"]),
    "src/Other.sol": contract("Other", "uint256 public y;"),
    "test/Vault.t.sol": contract("VaultTest"),
  });
  write(root, { "src/Lib.sol": contract("Lib", "uint256 public x; // REENTRANCY_BUG") });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "--fail-on", "high"]);
    assert.equal(code, 1, c.text());
    assert.match(c.text(), /NEW\s+High\s+reentrancy-eth/);
    assert.match(c.text(), /Also analyzed \(import a changed file\): src\/Vault\.sol/);
    assert.ok(!sent(s).includes("src/Other.sol"), "unrelated contract must not be uploaded");
    assert.ok(!sent(s).some((n) => n.startsWith("test/")), "tests are not uploaded");
    assert.equal(s.seen.length, 2);                                  // current + base
    const baseLib = s.seen.find((r) => !r.sources["src/Lib.sol"].includes("REENTRANCY_BUG"));
    assert.ok(baseLib, "base side must be the committed version");
  } finally { await s.close(); }
});

test("rename without changes: EXISTING (not NEW and not RESOLVED); old path is used for the base", async () => {
  const root = repo({ "src/A.sol": contract("A", "// REENTRANCY_BUG\nuint256 a;") });
  sh(root, ["mv", "src/A.sol", "src/B.sol"]);
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD", "--fail-on", "high"]);
    assert.equal(code, 0, c.text());
    assert.match(c.text(), /src\/A\.sol -> src\/B\.sol/);
    assert.match(c.text(), /EXISTING\s+High\s+reentrancy-eth/);
    assert.doesNotMatch(c.text(), /NEW\s+High|RESOLVED\s+High/);
    const names = s.seen.map((r) => Object.keys(r.sources).join(","));
    assert.ok(names.includes("src/B.sol") && names.includes("src/A.sol"), names.join(" | "));   // current: new path; base: old path
  } finally { await s.close(); }
});

test("deleted contract: its finding is RESOLVED as code removed; nothing else is claimed", async () => {
  const root = repo({ "src/Bad.sol": contract("Bad", "// REENTRANCY_BUG"), "src/Good.sol": contract("Good") });
  write(root, { "src/Bad.sol": null });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD"]);
    assert.equal(code, 0, c.text());
    assert.match(c.text(), /RESOLVED\s+High\s+reentrancy-eth\s+\(code removed\)/);
    assert.ok(!sent(s).includes("src/Good.sol"));
  } finally { await s.close(); }
});

test("changed import: a contract that now imports a vulnerable library gets NEW", async () => {
  const root = repo({ "src/Vault.sol": contract("Vault"), "src/Bad.sol": contract("Bad", "// REENTRANCY_BUG") });
  write(root, { "src/Vault.sol": contract("Vault", "", ["./Bad.sol"]) });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD", "--fail-on", "high"]);
    // base Vault (no import) has no High; current Vault+Bad has one
    assert.equal(code, 1, c.text());
    assert.match(c.text(), /NEW\s+High\s+reentrancy-eth/);
  } finally { await s.close(); }
});

test("an extra instance of an existing detector is NEW by count, never hidden", async () => {
  const root = repo({ "src/V.sol": contract("V", "// REENTRANCY_BUG") });
  write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG\n// REENTRANCY_BUG") });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD", "--fail-on", "high"]);
    assert.equal(code, 1, c.text());
    assert.match(c.text(), /EXISTING\s+High\s+reentrancy-eth/);
    assert.match(c.text(), /NEW\s+High\s+\+1 High finding/);
  } finally { await s.close(); }
});

test("fix verified: detector gone with the same scope analyzed -> RESOLVED, exit 0", async () => {
  const root = repo({ "src/V.sol": contract("V", "// REENTRANCY_BUG\naddress o = tx.origin;") });
  write(root, { "src/V.sol": contract("V", "address o = tx.origin;") });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD", "--fail-on", "medium"]);
    assert.equal(code, 0, c.text());
    assert.match(c.text(), /RESOLVED\s+High\s+reentrancy-eth/);
    assert.match(c.text(), /EXISTING\s+Medium\s+tx-origin/);
  } finally { await s.close(); }
});

test("base version does not compile: current findings are NEW 'no baseline', never silently clean", async () => {
  const root = repo({ "src/V.sol": contract("V", "// BROKEN") });
  write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG") });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD", "--fail-on", "high"]);
    assert.equal(code, 1, c.text());
    assert.match(c.text(), /NEW\s+High\s+reentrancy-eth\s+\(no baseline/);
  } finally { await s.close(); }
});

test("current scan fails or is rate-limited: everything UNKNOWN, nothing RESOLVED, exit 3", async () => {
  const root = repo({ "src/V.sol": contract("V", "// REENTRANCY_BUG") });
  write(root, { "src/V.sol": contract("V", "uint x;") });
  const s = await service({ status: 429 });
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD"]);
    assert.equal(code, 3, c.text());
    assert.doesNotMatch(c.text(), /RESOLVED/);
    assert.match(c.text(), /could not be analyzed/);
  } finally { await s.close(); }
});

test("scope over the free limits: nothing uploaded, reported as not analyzed", async () => {
  const files = {};
  for (let i = 0; i < 22; i++) files[`src/C${i}.sol`] = contract(`C${i}`);
  const root = repo(files);
  const changed = {};
  for (let i = 0; i < 22; i++) changed[`src/C${i}.sol`] = contract(`C${i}`, "uint256 changed;");
  write(root, changed);
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--changed", "HEAD"]);
    assert.equal(code, 2, c.text());
    assert.equal(s.seen.length, 0);
    assert.match(c.text(), /Current side NOT analyzed: over the free preview limits/);
    assert.doesNotMatch(c.text(), /First upload/);
  } finally { await s.close(); }
});

test("no Solidity changes: no network at all", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  write(root, { "README.md": "docs only\n" });
  const s = await service();
  try {
    const { code } = await run(root, s, ["--changed", "HEAD"]);
    assert.equal(code, 0);
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
});

test("identical sources are never uploaded twice (local cache)", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  write(root, { "src/V.sol": contract("V", "address o = tx.origin;") });
  const s = await service();
  const state = stateDir();
  try {
    await run(root, s, ["--changed", "HEAD"], { state });
    const first = s.seen.length;
    const { c } = await run(root, s, ["--changed", "HEAD"], { state });
    assert.equal(s.seen.length, first, "second run must be served from the cache");
    assert.match(c.text(), /Cached result reused/);
  } finally { await s.close(); }
});

test("staged mode scans exactly the staged content, flags partial staging, ignores unstaged edits", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  write(root, { "src/V.sol": contract("V", "address o = tx.origin; // staged") });
  sh(root, ["add", "src/V.sol"]);
  write(root, { "src/V.sol": contract("V", "address o = tx.origin; // staged\n// REENTRANCY_BUG unstaged") });
  write(root, { "src/Untracked.sol": contract("U", "// REENTRANCY_BUG") });
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--staged", "--fail-on", "high"]);
    assert.equal(code, 0, c.text());                                  // the High exists only in unstaged content
    assert.match(c.text(), /Partially staged \(scanned the staged version, not your working copy\): src\/V\.sol/);
    assert.match(c.text(), /NEW\s+Medium\s+tx-origin/);
    const uploaded = s.seen.map((r) => r.sources["src/V.sol"]).filter(Boolean);
    assert.ok(uploaded.some((t) => t.includes("// staged")) && uploaded.every((t) => !t.includes("unstaged")));
    assert.ok(!sent(s).includes("src/Untracked.sol"));
  } finally { await s.close(); }
});

test("consent: no upload without approval; interactive approval is remembered", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  write(root, { "src/V.sol": contract("V", "uint256 z;") });
  const s = await service();
  const state = stateDir();
  try {
    let c = capture();
    assert.equal(await main(["--changed", "HEAD", "--state-dir", state, "--url", s.url], { ...c, cwd: root, interactive: false }), 2);
    assert.equal(s.seen.length, 0);
    assert.match(c.text(), /First upload from this project.*\n.*src\/V\.sol/);
    c = capture();
    assert.equal(await main(["--changed", "HEAD", "--state-dir", state, "--url", s.url], { ...c, cwd: root, interactive: true, confirm: async () => false }), 2);
    assert.equal(s.seen.length, 0);
    c = capture();
    assert.equal(await main(["--changed", "HEAD", "--state-dir", state, "--url", s.url], { ...c, cwd: root, interactive: true, confirm: async () => true }), 0);
    assert.ok(fs.existsSync(path.join(state, "consent.json")));
    c = capture();
    let asked = false;
    assert.equal(await main(["--changed", "HEAD", "--no-cache", "--state-dir", state, "--url", s.url],
                            { ...c, cwd: root, interactive: true, confirm: async () => { asked = true; return false; } }), 0);
    assert.equal(asked, false, "approval is remembered per project and service URL");
    assert.equal(fs.readFileSync(path.join(state, ".gitignore"), "utf8").trim().split("\n").pop(), "*");
  } finally { await s.close(); }
});

test("privacy in git mode: committed symlinks and non-.sol imports are refused; .env never read", async () => {
  const root = repo({ "src/V.sol": contract("V"), ".env": "PRIVATE_KEY=0x1234567890abcdef1234567890abcdef\n" });
  fs.symlinkSync("/etc/hostname", path.join(root, "src", "Link.sol"));
  write(root, { "src/V.sol": contract("V", "", ["./Link.sol"]) });
  sh(root, ["add", "-A"]);
  const s = await service();
  try {
    const { code, c } = await run(root, s, ["--staged"]);
    assert.equal(code, 2, c.text());
    assert.match(c.text(), /NOT analyzed: refusing src\/Link\.sol: symlink/);
    assert.equal(s.seen.length, 0);
  } finally { await s.close(); }
  const root2 = repo({ "src/V.sol": contract("V") });
  write(root2, { "src/V.sol": contract("V", "", ["../.env"]), ".env": "X=1" });
  const s2 = await service();
  try {
    const { code, c } = await run(root2, s2, ["--changed", "HEAD"]);
    assert.equal(code, 2, c.text());
    assert.match(c.text(), /refusing non-Solidity import/);
    assert.equal(s2.seen.length, 0);
  } finally { await s2.close(); }
});

test("baseline + compare: NEW/RESOLVED across the whole project; different targets downgrade RESOLVED to UNKNOWN", async () => {
  const root = repo({ "src/A.sol": contract("A", "// REENTRANCY_BUG"), "src/B.sol": contract("B") });
  const s = await service();
  const state = stateDir();
  try {
    assert.equal((await run(root, s, ["--baseline"], { state })).code, 0);
    assert.ok(fs.existsSync(path.join(state, "baseline.json")));
    write(root, { "src/A.sol": contract("A"), "src/B.sol": contract("B", "address o = tx.origin;") });
    let { code, c } = await run(root, s, ["--compare", "--fail-on", "medium"], { state });
    assert.equal(code, 1, c.text());
    assert.match(c.text(), /RESOLVED\s+High\s+reentrancy-eth/);
    assert.match(c.text(), /NEW\s+Medium\s+tx-origin/);
    ({ code, c } = await run(root, s, ["--compare", "src/B.sol"], { state }));
    assert.match(c.text(), /UNKNOWN\s+High\s+reentrancy-eth\s+\(different scope/);
  } finally { await s.close(); }
});

test("markdown summary for CI is written and readable", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG") });
  const s = await service();
  const md = path.join(stateDir(), "summary.md");
  try {
    await run(root, s, ["--changed", "HEAD", "--summary-md", md]);
    const text = fs.readFileSync(md, "utf8");
    assert.match(text, /### Kestrova changed-file check/);
    assert.match(text, /\| NEW \| High \| `reentrancy-eth` \|/);
    assert.match(text, /not an audit/);
  } finally { await s.close(); }
});

// ---------- pure comparison logic ----------

test("comparePreviews rules", () => {
  const p = (detectors, counts) => ({ detectors, counts });
  let r = comparePreviews(null, p(["reentrancy-eth"], { High: 1 }));
  assert.deepEqual(r.items.map((i) => [i.status, i.what]), [["NEW", "reentrancy-eth"]]);
  r = comparePreviews(p(["tx-origin"], { Medium: 1 }), null);
  assert.equal(r.items[0].status, "RESOLVED"); assert.equal(r.items[0].detail, "code removed");
  r = comparePreviews(p(["tx-origin"], { Medium: 1 }), null, { currentError: "boom" });
  assert.equal(r.items[0].status, "UNKNOWN");
  r = comparePreviews(p([], { High: 0 }), p(["mystery-detector"], { High: 1 }));
  assert.equal(r.items[0].severity, "High");                 // unknown names are gated as High (conservative)
  assert.equal(gate(r, "high").length, 1); assert.equal(gate(r, "none").length, 0);
});

test("full-report fingerprints: stable across line moves and renames; unanalyzed files are UNKNOWN", () => {
  const f = (file, lines, fn = "withdraw", det = "reentrancy-eth") => ({ detector: det, impact: "High",
    description: `Reentrancy in Vault.${fn}() (${file}#${lines[0]}-${lines[1]}):\n\tExternal calls: (${file}#${lines[0] + 2})`,
    locations: [{ file, lines }] });
  assert.equal(fingerprint(f("src/V.sol", [10, 20])), fingerprint(f("src/V.sol", [40, 50])));
  const base = { findings: [f("src/V.sol", [10, 20]), f("src/Old.sol", [1, 5], "pay"), f("src/Gone.sol", [3, 4], "x"),
                            f("src/Other.sol", [7, 8], "y"), f("src/V.sol", [30, 35], "sweep", "arbitrary-send-eth")] };
  const current = { findings: [f("src/V.sol", [12, 22]), f("src/New.sol", [1, 5], "pay"), f("src/V.sol", [60, 70], "drain")] };
  const r = compareReports(base, current, { renames: [{ from: "src/Old.sol", to: "src/New.sol" }], deleted: ["src/Gone.sol"],
                                            analyzed: ["src/V.sol", "src/New.sol"] });
  const by = (st) => r.items.filter((i) => i.status === st).map((i) => `${i.detector}:${i.file}`).sort();
  assert.deepEqual(by("EXISTING"), ["reentrancy-eth:src/New.sol", "reentrancy-eth:src/V.sol"]);
  assert.deepEqual(by("NEW"), ["reentrancy-eth:src/V.sol"]);
  assert.deepEqual(by("RESOLVED"), ["arbitrary-send-eth:src/V.sol", "reentrancy-eth:src/Gone.sol"]);
  assert.deepEqual(by("UNKNOWN"), ["reentrancy-eth:src/Other.sol"]);
  assert.equal(r.items.find((i) => i.status === "EXISTING" && i.file === "src/V.sol").lines[0], 12);   // current lines
});

test("--compare-reports works offline from files", async () => {
  const dir = stateDir();
  const f = { detector: "tx-origin", impact: "Medium", description: "V.f() uses tx.origin (src/V.sol#5)", locations: [{ file: "src/V.sol", lines: [5, 5] }] };
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ findings: [] }));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ findings: [f] }));
  const c = capture();
  assert.equal(await main(["--compare-reports", "a.json", "b.json", "--fail-on", "medium"], { ...c, cwd: dir, fetchImpl: () => { throw new Error("no network"); } }), 1);
  assert.match(c.text(), /NEW\s+Medium\s+tx-origin src\/V\.sol#5-5/);
});
