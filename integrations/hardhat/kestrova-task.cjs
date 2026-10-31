// Optional Hardhat 2 task: `npx hardhat kestrova [--fail-on high] [--dry-run] [targets...]`.
// Add to hardhat.config.js:  require("./kestrova-task.cjs");   (Hardhat 3: use the npm script instead.)
// It only runs the kestrova-scan CLI (free preview). It never pays; the paid report needs your own x402 client.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function cliPath() {
  try { return require.resolve("kestrova-scan/bin/kestrova-scan.mjs"); } catch { /* not installed from npm */ }
  return path.join(__dirname, "..", "..", "cli", "bin", "kestrova-scan.mjs");
}

function register(task, types) {
  return task("kestrova", "Free Kestrova Slither preview of this project's contracts (not an audit)")
    .addOptionalParam("failOn", "exit non-zero on: high | medium | low | none", "none", types && types.string)
    .addFlag("dryRun", "only list the files that would be uploaded")
    .addOptionalVariadicPositionalParam("targets", "files or folders (default: contracts)", undefined, types && types.string)
    .setAction(async (args, hre) => {
      const argv = [cliPath(), ...(args.targets || []), "--fail-on", args.failOn];
      if (args.dryRun) argv.push("--dry-run");
      const r = spawnSync(process.execPath, argv, { cwd: hre.config.paths.root, stdio: "inherit" });
      if (r.status) process.exitCode = r.status;
      return r.status;
    });
}

module.exports = { register, cliPath };
try {
  const config = require("hardhat/config");
  register(config.task, config.types);
} catch { /* loaded outside a Hardhat 2 project (e.g. tests) */ }
