import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../bin/kestrova-scan.mjs";
import { HOOK_MARK } from "../lib/hook.mjs";
import { saveConsent } from "../lib/state.mjs";
import { capture, contract, repo, service, sh, stateDir, write } from "./helpers.mjs";

// Async on purpose: the stand-in service runs in this process, so a blocking spawn would deadlock the hook.
function gitCommit(root, env, extra = []) {
  return new Promise((resolve) => {
    const p = spawn("git", ["commit", "-q", "-m", "change", ...extra], { cwd: root, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (status) => resolve({ status, out }));
  });
}

async function install(root, args = []) {
  const c = capture();
  const code = await main(["--install-hook", ...args], { ...c, cwd: root });
  return { code, c, file: path.join(root, ".git", "hooks", "pre-commit") };
}

function approved(url) {
  const dir = stateDir();
  saveConsent(dir, url, ["src/V.sol"]);
  return dir;
}

test("install/uninstall: executable hook with marker; refuses foreign hooks and tracked hook folders", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  let r = await install(root);
  assert.equal(r.code, 0, r.c.text());
  const text = fs.readFileSync(r.file, "utf8");
  assert.ok(text.includes(HOOK_MARK) && text.includes("advisory") && text.includes("--cwd"));
  assert.ok(fs.statSync(r.file).mode & 0o111);
  assert.match(r.c.text(), /KESTROVA_SKIP=1 git commit/);
  let c = capture();
  assert.equal(await main(["--uninstall-hook"], { ...c, cwd: root }), 0);
  assert.ok(!fs.existsSync(r.file));

  fs.writeFileSync(r.file, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  r = await install(root);
  assert.equal(r.code, 2);
  assert.match(r.c.text(), /different pre-commit hook already exists/);
  assert.equal(fs.readFileSync(r.file, "utf8"), "#!/bin/sh\necho mine\n");
  c = capture();
  await main(["--uninstall-hook"], { ...c, cwd: root });
  assert.match(c.text(), /not installed by Kestrova; left untouched/);
  assert.ok(fs.existsSync(r.file));

  const husky = repo({ "src/V.sol": contract("V") });
  sh(husky, ["config", "core.hooksPath", ".husky"]);
  r = await install(husky);
  assert.equal(r.code, 2);
  assert.match(r.c.text(), /inside the work tree/);
  assert.ok(!fs.existsSync(path.join(husky, ".husky", "pre-commit")));
});

test("advisory hook reports new findings but never blocks; enforced hook blocks; documented bypasses work", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  const s = await service();
  const env = { KESTROVA_URL: s.url, KESTROVA_STATE_DIR: approved(s.url) };
  try {
    assert.equal((await install(root)).code, 0);
    write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG") });
    sh(root, ["add", "src/V.sol"]);
    let r = await gitCommit(root, env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NEW\s+High\s+reentrancy-eth/);
    assert.match(r.out, /advisory/);

    await main(["--uninstall-hook"], { ...capture(), cwd: root });
    assert.equal((await install(root, ["--enforce", "--fail-on", "high"])).code, 0);
    write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG\n// REENTRANCY_BUG") });
    sh(root, ["add", "src/V.sol"]);
    r = await gitCommit(root, env);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /commit blocked by 1 new finding/);
    const head = sh(root, ["rev-parse", "HEAD"]);

    r = await gitCommit(root, { ...env, KESTROVA_SKIP: "1" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /skipped \(KESTROVA_SKIP=1\)/);
    assert.notEqual(sh(root, ["rev-parse", "HEAD"]), head);

    write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG\n// REENTRANCY_BUG\n// REENTRANCY_BUG") });
    sh(root, ["add", "src/V.sol"]);
    r = await gitCommit(root, env, ["--no-verify"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(sh(root, ["status", "--porcelain"]).trim(), "", "the hook never leaves modified files behind");
  } finally { await s.close(); }
});

test("enforced hook never blocks on service problems, missing consent or non-Solidity commits", async () => {
  const root = repo({ "src/V.sol": contract("V") });
  const down = await service({ status: 429 });
  const ok = await service();
  try {
    assert.equal((await install(root, ["--enforce"])).code, 0);
    write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG") });
    sh(root, ["add", "-A"]);
    let r = await gitCommit(root, { KESTROVA_URL: down.url, KESTROVA_STATE_DIR: approved(down.url) });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not blocking the commit/);

    write(root, { "src/V.sol": contract("V", "// REENTRANCY_BUG\n// REENTRANCY_BUG") });
    sh(root, ["add", "-A"]);
    r = await gitCommit(root, { KESTROVA_URL: ok.url, KESTROVA_STATE_DIR: stateDir() });       // no consent recorded
    assert.equal(r.status, 0, r.out);
    assert.equal(ok.seen.length, 0, "nothing is uploaded without consent");
    assert.match(r.out, /approve uploads/);

    write(root, { "README.md": "only docs\n" });
    sh(root, ["add", "-A"]);
    r = await gitCommit(root, { KESTROVA_URL: ok.url, KESTROVA_STATE_DIR: approved(ok.url) });
    assert.equal(r.status, 0, r.out);
    assert.equal(ok.seen.length, 0, "no Solidity staged: no request");
  } finally { await down.close(); await ok.close(); }
});
