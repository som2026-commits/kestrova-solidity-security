import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK = path.resolve(HERE, "..", "..", "integrations", "hardhat", "kestrova-task.cjs");

// Stand-in for Hardhat 2's task builder: records the definition and lets the test run the action.
function fakeTaskApi() {
  const def = { params: [], flags: [] };
  const builder = {
    addOptionalParam(name) { def.params.push(name); return builder; },
    addFlag(name) { def.flags.push(name); return builder; },
    addOptionalVariadicPositionalParam(name) { def.params.push(name); return builder; },
    setAction(fn) { def.action = fn; return builder; },
  };
  return { def, task: (name, desc) => { def.name = name; def.desc = desc; return builder; } };
}

test("hardhat task registers `kestrova` and runs the CLI from the project root (dry run, no network)", async () => {
  const { register, cliPath } = require(TASK);
  assert.ok(fs.existsSync(cliPath()));
  const api = fakeTaskApi();
  register(api.task, { string: "string" });
  assert.equal(api.def.name, "kestrova");
  assert.deepEqual(api.def.params, ["failOn", "targets"]);
  assert.deepEqual(api.def.flags, ["dryRun"]);
  assert.match(api.def.desc, /not an audit/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-"));
  fs.writeFileSync(path.join(root, "hardhat.config.js"), "module.exports = {};");
  fs.mkdirSync(path.join(root, "contracts"));
  fs.writeFileSync(path.join(root, "contracts", "A.sol"), "pragma solidity ^0.8.20;\ncontract A {}\n");
  const status = await api.def.action({ failOn: "none", dryRun: true, targets: undefined },
                                      { config: { paths: { root } } });
  assert.equal(status, 0);
});
