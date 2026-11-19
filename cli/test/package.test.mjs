// The published tarball must be installable and runnable whatever the publisher's umask (0.1.5 shipped every file as
// 0600 and a non-executable bin because it was packed from a 0600 checkout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(CLI, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function copyPackage(dst) {
  fs.cpSync(CLI, dst, { recursive: true, filter: (s) => !s.includes(`${path.sep}node_modules`) });
}

// `npm pack --json` printed an array up to npm 11 and prints an object keyed by package name from npm 12.
function packInfo(stdout) {
  const raw = JSON.parse(stdout);
  const info = Array.isArray(raw) ? raw[0] : raw?.[pkg.name];
  assert.ok(info && typeof info.filename === "string" && Array.isArray(info.files),
    `unexpected npm pack --json output: ${stdout.slice(0, 200)}`);
  return info;
}

// Modes straight from the tarball's own tar headers (independent of npm's JSON report).
function tarModes(tgz) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgz));
  const out = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const name = (str(345, 500) ? str(345, 500) + "/" : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    if (type === "0") out[name.replace(/^package\//, "")] = parseInt(str(100, 108).trim(), 8) & 0o777;
    else assert.ok(type === "5", `unexpected tar entry type ${type} for ${name}`);   // no links or devices
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function chmodAll(p, mode) {
  for (const name of fs.readdirSync(p)) {
    const f = path.join(p, name);
    if (fs.statSync(f).isDirectory()) chmodAll(f, mode);
    else fs.chmodSync(f, mode);
  }
}

test("bin, shebang and package metadata", () => {
  assert.deepEqual(pkg.bin, { "kestrova-scan": "bin/kestrova-scan.mjs" });
  const src = fs.readFileSync(path.join(CLI, pkg.bin["kestrova-scan"]), "utf8");
  assert.ok(src.startsWith("#!/usr/bin/env node\n"), "shebang");
  assert.ok(!src.includes("\r"), "no CRLF line endings");
  assert.equal(pkg.scripts.prepack, "node scripts/fix-modes.mjs");
  assert.ok(!pkg.files.includes("scripts") && !pkg.files.includes("test"), "build/test files are not shipped");
});

test("a pack from a 0600 checkout still ships 0644 files and a 0755 bin, and the packed CLI runs",
  { skip: process.platform === "win32" }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kestrova-pack-"));
    try {
      const src = path.join(tmp, "src");
      copyPackage(src);
      chmodAll(src, 0o600);                                   // what the 0.1.5 publisher's checkout looked like
      const out = packInfo(execFileSync(npm, ["pack", "--json", "--pack-destination", tmp],
        { cwd: src, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      const tgz = path.join(tmp, out.filename);
      const reported = Object.fromEntries(out.files.map((f) => [f.path, f.mode]));
      const actual = tarModes(tgz);
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(reported).sort(), "npm report matches the tarball");
      for (const modes of [reported, actual]) {
        assert.equal(modes["bin/kestrova-scan.mjs"], 0o755);
        for (const [f, m] of Object.entries(modes)) if (f !== "bin/kestrova-scan.mjs") assert.equal(m, 0o644, f);
        assert.ok(!Object.keys(modes).some((f) => f.startsWith("scripts/") || f.startsWith("test/")));
      }
      // install the packed tarball into an empty project and run it through the npm-created bin link
      const app = path.join(tmp, "app");
      fs.mkdirSync(app);
      fs.writeFileSync(path.join(app, "package.json"), '{"name":"t","version":"1.0.0","private":true}');
      execFileSync(npm, ["install", "--no-audit", "--no-fund", "--offline", tgz],
        { cwd: app, stdio: "ignore" });
      const help = execFileSync(path.join(app, "node_modules", ".bin", "kestrova-scan"), ["--help"], { encoding: "utf8" });
      assert.match(help, new RegExp(`kestrova-scan ${pkg.version.replace(/\./g, "\\.")}:`));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
