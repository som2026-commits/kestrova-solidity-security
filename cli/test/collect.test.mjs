import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CollectError, LIMITS, checkLimits, collect, findImports, maskComments, uploadName } from "../lib/collect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}\.sol$/;     // the service's rule (scanner.SAFE_NAME)
const PRAGMA = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n";

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kestrova-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const lines = (s) => s.split("\n").length;

test("foundry example: only the targets and their imports, remapped import rewritten, lines preserved", () => {
  const root = path.join(REPO, "examples", "foundry-vault");
  const b = collect({ cwd: root });
  assert.equal(b.kind, "foundry");
  assert.deepEqual(b.files.map((f) => f.file).sort(),
                   ["lib/minitoken/src/MiniERC20.sol", "src/Vault.sol", "src/interfaces/IVault.sol"]);
  assert.ok(!Object.keys(b.sources).some((n) => /test|script|\.env/.test(n)));
  const vault = b.sources["src/Vault.sol"];
  assert.match(vault, /from "lib\/minitoken\/src\/MiniERC20\.sol"/);
  assert.match(vault, /from "src\/interfaces\/IVault\.sol"/);
  for (const f of b.files) {
    assert.match(f.upload, SAFE_NAME);
    assert.equal(lines(b.sources[f.upload]), lines(fs.readFileSync(path.join(root, f.file), "utf8")));
  }
  assert.equal(b.files.find((f) => f.file.startsWith("lib/")).dependency, true);
});

test("hardhat: scoped npm packages are renamed to service-safe names and imports follow", () => {
  const root = project({
    "hardhat.config.js": "module.exports = {};",
    "contracts/App.sol": PRAGMA + 'import {Lib} from "@acme/lib/src/Lib.sol";\ncontract App is Lib {}\n',
    "contracts/Unused.sol": PRAGMA + "contract Unused {}\n",
    "node_modules/@acme/lib/src/Lib.sol": PRAGMA + 'import "./util/Base.sol";\ncontract Lib is Base {}\n',
    "node_modules/@acme/lib/src/util/Base.sol": PRAGMA + "contract Base {}\n",
    "node_modules/@acme/lib/src/Other.sol": PRAGMA + "contract Other {}\n",
    ".env": "PRIVATE_KEY=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
  });
  const b = collect({ cwd: root, targets: ["contracts/App.sol"] });
  assert.deepEqual(Object.keys(b.sources).sort(), [
    "contracts/App.sol", "node_modules/_acme/lib/src/Lib.sol", "node_modules/_acme/lib/src/util/Base.sol"]);
  assert.match(b.sources["contracts/App.sol"], /"node_modules\/_acme\/lib\/src\/Lib\.sol"/);
  assert.match(b.sources["node_modules/_acme/lib/src/Lib.sol"], /import "node_modules\/_acme\/lib\/src\/util\/Base\.sol";/);
  for (const n of Object.keys(b.sources)) assert.match(n, SAFE_NAME);
});

test("default hardhat target is contracts/ and test/ script/ *.t.sol are skipped unless asked", () => {
  const root = project({
    "hardhat.config.ts": "export default {};",
    "contracts/A.sol": PRAGMA + "contract A {}\n",
    "contracts/A.t.sol": PRAGMA + "contract ATest {}\n",
    "contracts/test/Mock.sol": PRAGMA + "contract Mock {}\n",
    "scripts/x.sol": PRAGMA + "contract X {}\n",
  });
  assert.deepEqual(Object.keys(collect({ cwd: root }).sources), ["contracts/A.sol"]);
  assert.deepEqual(Object.keys(collect({ cwd: root, includeTests: true }).sources).sort(),
                   ["contracts/A.sol", "contracts/A.t.sol", "contracts/test/Mock.sol"]);
});

test("refuses secrets, non-Solidity imports, files outside the project and missing imports", () => {
  const secret = project({ "foundry.toml": "", "src/K.sol": PRAGMA + '// PRIVATE_KEY = "0123456789abcdef0123456789"\ncontract K {}\n' });
  assert.throws(() => collect({ cwd: secret }), /looks like it contains a secret/);
  assert.equal(Object.keys(collect({ cwd: secret, allowSecrets: true }).sources).length, 1);

  const env = project({ "foundry.toml": "", "src/E.sol": PRAGMA + 'import "../.env";\ncontract E {}\n', ".env": "X=1" });
  assert.throws(() => collect({ cwd: env }), /refusing non-Solidity import/);

  const outside = project({ "foundry.toml": "", "src/O.sol": PRAGMA + 'import "../../../../../etc/passwd.sol";\ncontract O {}\n' });
  assert.throws(() => collect({ cwd: outside }), CollectError);

  const missing = project({ "foundry.toml": "", "src/M.sol": PRAGMA + 'import "./Nope.sol";\ncontract M {}\n' });
  assert.throws(() => collect({ cwd: missing }), /import not found/);
});

test("a symlink pointing outside the project is refused", () => {
  const elsewhere = project({ "Evil.sol": PRAGMA + "contract Evil {}\n" });
  const root = project({ "foundry.toml": "", "src/A.sol": PRAGMA + 'import "./Link.sol";\ncontract A {}\n' });
  fs.symlinkSync(path.join(elsewhere, "Evil.sol"), path.join(root, "src", "Link.sol"));
  assert.throws(() => collect({ cwd: root }), /outside the project/);
});

test("import parsing: all forms, comments ignored, cycles terminate", () => {
  const src = [
    'import "./A.sol";', 'import "./B.sol" as B;', 'import * as C from "./C.sol";', 'import {D, E as F} from "./D.sol";',
    '// import "./Commented.sol";', '/* import "./Block.sol"; */', 'string constant s = "import \\"./NotAnImport.sol\\";";',
  ].join("\n");
  assert.deepEqual(findImports(src).map((i) => i.spec), ["./A.sol", "./B.sol", "./C.sol", "./D.sol"]);
  assert.equal(maskComments(src).length, src.length);
  const root = project({ "foundry.toml": "", "src/A.sol": PRAGMA + 'import "./B.sol";\ncontract A {}\n',
                         "src/B.sol": PRAGMA + 'import "./A.sol";\ncontract B {}\n' });
  assert.equal(Object.keys(collect({ cwd: root }).sources).length, 2);
});

test("foundry remappings: remappings.txt beats auto lib remapping; contexts are stripped", () => {
  const root = project({
    "foundry.toml": '[profile.default]\nsrc = "contracts"\n',
    "remappings.txt": "dep/=lib/dep-v2/src/\nctx:other/=lib/other/\n",
    "contracts/A.sol": PRAGMA + 'import "dep/X.sol";\nimport "other/Y.sol";\ncontract A {}\n',
    "lib/dep/src/X.sol": PRAGMA + "contract Wrong {}\n",
    "lib/dep-v2/src/X.sol": PRAGMA + "contract X {}\n",
    "lib/other/Y.sol": PRAGMA + "contract Y {}\n",
  });
  const names = Object.keys(collect({ cwd: root }).sources).sort();
  assert.deepEqual(names, ["contracts/A.sol", "lib/dep-v2/src/X.sol", "lib/other/Y.sol"]);
});

test("limits match the service and upload names are sanitized consistently", () => {
  assert.equal(LIMITS.files, 20); assert.equal(LIMITS.previewBytes, 60_000); assert.equal(LIMITS.fullBytes, 300_000);
  const many = { files: Array.from({ length: 21 }, () => ({})), bytes: 70_000 };
  assert.equal(checkLimits(many, "preview").length, 2);
  assert.equal(checkLimits({ files: [{}], bytes: 70_000 }, "full").length, 0);
  assert.equal(uploadName("node_modules/@scope/pkg/A.sol"), "node_modules/_scope/pkg/A.sol");
  assert.equal(uploadName("@x/A.sol"), "_x/A.sol");
  const clash = project({ "foundry.toml": "", "src/A.sol": PRAGMA + 'import "../a@b/X.sol";\nimport "../a_b/X.sol";\ncontract A {}\n',
                          "a@b/X.sol": PRAGMA + "contract X1 {}\n", "a_b/X.sol": PRAGMA + "contract X2 {}\n" });
  assert.throws(() => collect({ cwd: clash }), /same upload name/);
});

test("hoisted or symlinked node_modules outside the project are allowed for imported .sol only", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  fs.mkdirSync(path.join(ws, "node_modules", "@oz", "lib"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "@oz", "lib", "Base.sol"), PRAGMA + "contract Base {}\n");
  fs.writeFileSync(path.join(ws, "node_modules", "@oz", "lib", "secret.env"), "PRIVATE_KEY=1");
  fs.writeFileSync(path.join(ws, "Outside.sol"), PRAGMA + "contract Outside {}\n");
  const app = path.join(ws, "packages", "app");
  fs.mkdirSync(path.join(app, "contracts"), { recursive: true });
  fs.writeFileSync(path.join(app, "hardhat.config.js"), "module.exports = {};");
  fs.writeFileSync(path.join(app, "contracts", "A.sol"), PRAGMA + 'import "@oz/lib/Base.sol";\ncontract A is Base {}\n');
  const b = collect({ cwd: app });
  assert.deepEqual(Object.keys(b.sources).sort(), ["contracts/A.sol", "node_modules/_oz/lib/Base.sol"]);
  assert.match(b.sources["contracts/A.sol"], /"node_modules\/_oz\/lib\/Base\.sol"/);
  fs.writeFileSync(path.join(app, "contracts", "A.sol"), PRAGMA + 'import "../../../Outside.sol";\ncontract A {}\n');
  assert.throws(() => collect({ cwd: app }), /outside the project/);          // only node_modules trees, never elsewhere
  fs.writeFileSync(path.join(app, "contracts", "A.sol"), PRAGMA + 'import "@oz/lib/secret.env";\ncontract A {}\n');
  assert.throws(() => collect({ cwd: app }), /refusing non-Solidity import/);
});
