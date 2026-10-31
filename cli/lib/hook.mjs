// Optional Git pre-commit hook. Installs only into the repository's private hooks directory (.git/hooks or a
// hooksPath OUTSIDE the work tree); never overwrites a hook it did not write; never edits tracked files, source files
// or history. Advisory by default; blocking only with --enforce. Bypass: KESTROVA_SKIP=1 git commit … (or --no-verify).
import fs from "node:fs";
import path from "node:path";
import { git, gitTop } from "./sources.mjs";

export const HOOK_MARK = "# kestrova-scan pre-commit hook";

export class HookError extends Error {}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function hooksDir(cwd) {
  const top = gitTop(cwd);
  if (!top) throw new HookError("not inside a git repository");
  const rel = git(cwd, ["rev-parse", "--git-path", "hooks"]).trim();
  const dir = path.resolve(cwd, rel);
  const gitDir = path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim());
  return { top, dir, gitDir };
}

export function hookScript({ nodePath, cliPath, enforce, failOn, projectDir }) {
  const args = ["--hook", "--fail-on", failOn || "high", ...(enforce ? ["--enforce"] : []), ...(projectDir ? ["--cwd", projectDir] : [])];
  return `#!/bin/sh
${HOOK_MARK} (${enforce ? "ENFORCING" : "advisory"}).
# Scans the STAGED Solidity changes (exactly what is being committed) with Kestrova's free preview.
# Remove:   kestrova-scan --uninstall-hook
# Skip once: KESTROVA_SKIP=1 git commit ...   (or: git commit --no-verify)
if [ "\${KESTROVA_SKIP:-0}" = "1" ]; then echo "kestrova: skipped (KESTROVA_SKIP=1)" >&2; exit 0; fi
exec ${shq(nodePath)} ${shq(cliPath)} ${args.map(shq).join(" ")}
`;
}

export function installHook({ cwd, nodePath, cliPath, enforce = false, failOn = "high", projectDir }) {
  const { top, dir, gitDir } = hooksDir(cwd);
  const insideTree = (dir === top || dir.startsWith(top + path.sep)) && !(dir === gitDir || dir.startsWith(gitDir + path.sep));
  if (insideTree)
    throw new HookError(`hooks directory ${path.relative(top, dir)} is inside the work tree (e.g. husky); not writing a `
      + `tracked file. Add this line to your pre-commit script instead:\n  ${shq(nodePath)} ${shq(cliPath)} --hook --fail-on ${failOn}${enforce ? " --enforce" : ""}`);
  const file = path.join(dir, "pre-commit");
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(HOOK_MARK))
    throw new HookError(`a different pre-commit hook already exists (${file}); not overwriting it. Call Kestrova from it:\n`
      + `  ${shq(nodePath)} ${shq(cliPath)} --hook --fail-on ${failOn}${enforce ? " --enforce" : ""}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, hookScript({ nodePath, cliPath, enforce, failOn, projectDir }), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

export function uninstallHook({ cwd }) {
  const { dir } = hooksDir(cwd);
  const file = path.join(dir, "pre-commit");
  if (!fs.existsSync(file)) return { removed: false, file, reason: "no pre-commit hook installed" };
  if (!fs.readFileSync(file, "utf8").includes(HOOK_MARK))
    return { removed: false, file, reason: "the pre-commit hook was not installed by Kestrova; left untouched" };
  fs.unlinkSync(file);
  return { removed: true, file };
}
