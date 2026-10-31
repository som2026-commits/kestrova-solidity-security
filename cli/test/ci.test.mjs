// The PR workflow: static security properties, and its scan step executed for real (bash) against a local repo with
// an origin/main ref and a stand-in service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contract, repo, service, sh, stateDir, write } from "./helpers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = fs.readFileSync(path.join(REPO, "examples", "ci", "kestrova.yml"), "utf8");
const CODE = WF.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");   // ignore explanatory comments

test("workflow: least privilege, untrusted PR code is never executed, advisory by default", () => {
  assert.match(WF, /^on:\n  pull_request:/m);
  assert.doesNotMatch(CODE, /pull_request_target|workflow_run/);
  assert.match(WF, /^permissions:\n  contents: read\n(?!  \w)/m);
  assert.doesNotMatch(WF, /\$\{\{\s*secrets\./);
  assert.match(WF, /persist-credentials: false/);
  assert.match(WF, /npm ci --ignore-scripts/);
  assert.doesNotMatch(CODE, /npm (run|test|install)(?! --ignore-scripts)|npx |forge |hardhat /);
  assert.match(WF, /KESTROVA_FAIL_ON: none/);
  // untrusted values reach the shell only through env vars, never ${{ }} inside run:
  for (const block of WF.split(/\n\s+- /).filter((b) => /run: \|/.test(b)))
    assert.doesNotMatch(block.slice(block.indexOf("run: |")), /\$\{\{/);
  assert.match(WF, /3\) echo "::warning::Kestrova unavailable or rate-limited; not blocking"; exit 0/);
});

function scanStep() {
  const i = WF.indexOf("- name: Kestrova changed-file check");
  const run = WF.slice(WF.indexOf("run: |", i) + "run: |".length);
  return run.split("\n").filter((l) => l.startsWith("          ") || !l.trim()).map((l) => l.slice(10)).join("\n");
}

function bash(script, cwd, env) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", script], { cwd, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("close", (status) => resolve({ status, out }));
  });
}

async function prCheckout() {
  const root = repo({ "src/Lib.sol": contract("Lib"), "src/Vault.sol": contract("Vault", "", ["./Lib.sol"]) });
  sh(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);           // what actions/checkout fetch-depth: 0 provides
  sh(root, ["checkout", "-q", "-b", "pr"]);
  write(root, { "src/Lib.sol": contract("Lib", "// REENTRANCY_BUG") });
  sh(root, ["commit", "-qam", "pr change"]);
  const runner = stateDir();
  fs.symlinkSync(REPO, path.join(runner, "kestrova"));                    // the pinned CLI checkout
  return { root, runner };
}

test("scan step end to end: advisory passes with a readable summary; threshold fails; outage does not block", async () => {
  const { root, runner } = await prCheckout();
  const s = await service();
  const down = await service({ status: 429 });
  try {
    const summary = path.join(runner, "summary.md");
    const env = { BASE_REF: "main", RUNNER_TEMP: runner, GITHUB_STEP_SUMMARY: summary, KESTROVA_URL: s.url };
    let r = await bash(scanStep(), root, { ...env, KESTROVA_FAIL_ON: "none" });
    assert.equal(r.status, 0, r.out);
    const md = fs.readFileSync(summary, "utf8");
    assert.match(md, /### Kestrova changed-file check/);
    assert.match(md, /\| NEW \| High \| `reentrancy-eth` \|/);
    assert.match(md, /Also analyzed \(import a changed file\): src\/Vault\.sol/);
    r = await bash(scanStep(), root, { ...env, KESTROVA_FAIL_ON: "high" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /::error::Kestrova: NEW findings at or above high/);
    r = await bash(scanStep(), root, { ...env, KESTROVA_FAIL_ON: "high", KESTROVA_URL: down.url });
    // results for these exact sources are cached in RUNNER_TEMP, so clear the cache to force the outage path
    fs.rmSync(path.join(runner, "kestrova-state"), { recursive: true, force: true });
    r = await bash(scanStep(), root, { ...env, KESTROVA_FAIL_ON: "high", KESTROVA_URL: down.url });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /::warning::Kestrova unavailable or rate-limited; not blocking/);
    assert.equal(sh(root, ["status", "--porcelain"]).trim(), "", "the PR checkout is left untouched");
  } finally { await s.close(); await down.close(); }
});
