#!/usr/bin/env node
// kestrova-scan: free Slither preview of a Foundry / Hardhat / plain Solidity project, change-aware.
// No payments: the full report is optional, paid via x402 by YOUR wallet client with YOUR approval (see --bundle).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ChangeError, partiallyStaged, planChanged, resolveBase, changedSolidity } from "../lib/changes.mjs";
import { CollectError, checkLimits, collect } from "../lib/collect.mjs";
import { ServiceError, VERSION, preview, serviceUrl, terms } from "../lib/client.mjs";
import { RANK, compareReports, comparePreviews, gate, renderMarkdown, renderText } from "../lib/compare.mjs";
import { HookError, installHook, uninstallHook } from "../lib/hook.mjs";
import { cacheGet, cachePut, hasConsent, loadBaseline, saveBaseline, saveConsent, sourcesKey, stateDir } from "../lib/state.mjs";
import { gitTop } from "../lib/sources.mjs";
import { findRoot } from "../lib/project.mjs";

const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `kestrova-scan ${VERSION}: automated Slither analysis of Solidity (free preview). Not an audit.

Daily use:
  kestrova-scan --changed [REF]     preview only changed contracts (+ the contracts that import them), compared with
                                    the same files at REF (default: origin/HEAD, main or master; merge-base)
  kestrova-scan --staged            same, for exactly what is staged for the next commit (vs HEAD)
  kestrova-scan --baseline          save a whole-project preview as the baseline (.kestrova/baseline.json)
  kestrova-scan --compare           whole-project preview compared with the saved baseline
  kestrova-scan --install-hook      optional pre-commit hook (advisory; add --enforce to block). --uninstall-hook
  kestrova-scan --dry-run [...]     list exactly which files would be uploaded, then stop (no network)
  kestrova-scan [targets...]        plain preview (default: Foundry "src", Hardhat "contracts")

Options:
  --fail-on LEVEL      high | medium | low | none (default none). Plain scans: exit 1 on findings at LEVEL or worse.
                       --changed/--staged/--compare: exit 1 only on NEW findings at LEVEL or worse.
  --base REF           base revision for --changed/--staged
  --yes                approve uploading for this run without a prompt (CI); otherwise the first upload from a
                       project asks once and remembers it in .kestrova/consent.json
  --json               machine-readable output (plain scans: the service's JSON unchanged)
  --summary-md FILE    append a Markdown summary (e.g. "$GITHUB_STEP_SUMMARY")
  --no-cache           ignore cached results (same sources are otherwise not re-uploaded for 7 days)
  --bundle FILE        write {"sources": ...} for the optional paid report via your own x402 client (1 USDC)
  --compare-reports BASE.json CURRENT.json [--renames-from REF] [--scope BUNDLE.json]
                       compare two full reports per finding (offline; no network)
  --include-tests      also scan *.t.sol / *.s.sol and test/ script/ folders
  --allow-secret-pattern  upload even if a file looks like it contains a secret (not recommended)
  --terms              show the current paid-scan terms (reads the public 402 offer; never pays)
  --cwd DIR            project directory (default: current directory)
  --state-dir DIR      local state directory (default: <project>/.kestrova)
  --url URL            service URL (default https://kestrova.onrender.com or $KESTROVA_URL)
  -h, --help, --version

Only .sol files are read; only your targets and the files they import are uploaded. No telemetry. The free preview
returns severity counts and High/Medium detector names. Zero findings does not mean a contract is safe.
Exit codes: 0 ok, 1 --fail-on threshold reached, 2 usage/collection/consent problem (nothing sent), 3 service error.`;

function parse(argv) {
  const o = { targets: [], failOn: "none" };
  const next = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--version") o.version = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else if (a === "--include-tests") o.includeTests = true;
    else if (a === "--allow-secret-pattern") o.allowSecrets = true;
    else if (a === "--full-limits") o.full = true;
    else if (a === "--terms") o.terms = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--no-cache") o.noCache = true;
    else if (a === "--changed") o.changed = true;
    else if (a.startsWith("--changed=")) { o.changed = true; o.base = a.slice(10); }
    else if (a === "--staged") o.staged = true;
    else if (a === "--hook") o.hook = true;
    else if (a === "--enforce") o.enforce = true;
    else if (a === "--baseline") o.baseline = true;
    else if (a === "--compare") o.compare = true;
    else if (a === "--install-hook") o.installHook = true;
    else if (a === "--uninstall-hook") o.uninstallHook = true;
    else if (a === "--compare-reports") { o.compareReports = [next(i), argv[i + 2]]; i += 2; if (!o.compareReports[1]) throw new Error("--compare-reports needs BASE.json CURRENT.json"); }
    else if (a === "--renames-from") o.renamesFrom = next(i++) && argv[i];
    else if (a === "--scope") o.scope = next(i++) && argv[i];
    else if (a === "--fail-on") o.failOn = next(i++) && argv[i].toLowerCase();
    else if (a === "--base") o.base = next(i++) && argv[i];
    else if (a === "--bundle") o.bundle = next(i++) && argv[i];
    else if (a === "--url") o.url = next(i++) && argv[i];
    else if (a === "--summary-md") o.summaryMd = next(i++) && argv[i];
    else if (a === "--state-dir") o.stateDir = next(i++) && argv[i];
    else if (a === "--cwd") o.cwd = next(i++) && argv[i];
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else o.targets.push(a);
  }
  return o;
}

function listFiles(err, label, b) {
  err(`${label}: ${b.files.length} .sol file(s), ${b.bytes} bytes${b.source && b.source !== "working tree" ? ` [${b.source}]` : ""}:`);
  for (const f of b.files) err(`  ${f.file}${f.upload !== f.file ? `  (as ${f.upload})` : ""}${f.dependency ? "  [dependency]" : ""}`);
}

async function defaultConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

export async function main(argv, { out = console.log, err = console.error, fetchImpl = fetch, cwd = process.cwd(),
                                   confirm, interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) } = {}) {
  let o;
  try { o = parse(argv); } catch (e) { err(`${e.message}\n\n${HELP}`); return 2; }
  if (o.help) { out(HELP); return 0; }
  if (o.version) { out(VERSION); return 0; }
  if (!(o.failOn in RANK)) { err("--fail-on must be high, medium, low or none"); return 2; }
  cwd = path.resolve(cwd, o.cwd || ".");
  // Treat a git revision given right after --changed as the base (e.g. "--changed main").
  if (o.changed && !o.base && o.targets.length) {
    const top = gitTop(cwd);
    if (top) { try { resolveBase(top, o.targets[0]); o.base = o.targets.shift(); } catch { /* it is a target */ } }
  }
  const url = serviceUrl(o.url);
  const md = (text) => { if (o.summaryMd) fs.appendFileSync(o.summaryMd, text); };

  try {
    if (o.terms) {
      for (const t of await terms({ url, fetchImpl }))
        out(`${t.network}  ${Number(t.amount) / 1e6} USDC (${t.asset})  payTo ${t.payTo}  scheme ${t.scheme}`);
      out("Paid scans require your explicit approval and your own x402 wallet client. This tool never pays.");
      return 0;
    }
    if (o.installHook || o.uninstallHook) return hookAdmin(o, { out, err, cwd });
    if (o.compareReports) return compareReportFiles(o, { out, err, cwd, md });

    const ctx = { o, out, err, fetchImpl, cwd, url, md, confirm: confirm || defaultConfirm, interactive };
    if (o.changed || o.staged || o.hook) return await changedFlow(ctx);
    if (o.baseline || o.compare) return await baselineFlow(ctx);
    return await plainFlow(ctx);
  } catch (e) {
    if (e instanceof CollectError || e instanceof ChangeError) { err(`kestrova-scan: ${e.message}`); return o.hook ? 0 : 2; }
    if (e instanceof ServiceError) { err(`kestrova-scan: ${e.message}`); return o.hook ? 0 : 3; }
    if (o.hook) { err(`kestrova: hook error (${e.message}); not blocking the commit`); return 0; }
    throw e;
  }
}

// ---------- consent + cached preview ----------

async function ensureConsent(c, root, bundles) {
  const dir = stateDir(root, c.o.stateDir);
  if (hasConsent(dir, c.url)) return true;
  c.err(`First upload from this project to ${c.url}. Only these .sol files would be sent:`);
  for (const f of new Set(bundles.flatMap((b) => b.files.map((x) => x.file)))) c.err(`  ${f}`);
  if (c.o.yes) return true;
  if (c.interactive && !c.o.hook) {
    const ok = await c.confirm(`Upload them for a free preview (and remember this for ${path.basename(root)})? [y/N] `);
    if (ok) saveConsent(dir, c.url, [...new Set(bundles.flatMap((b) => b.files.map((f) => f.file)))]);
    return ok;
  }
  c.err(c.o.hook ? "kestrova: run `kestrova-scan --staged` once in a terminal to approve uploads; commit not checked."
                 : "Not uploading: approve interactively, or pass --yes (e.g. in CI).");
  return false;
}

async function cachedPreview(c, root, bundle) {
  const dir = stateDir(root, c.o.stateDir);
  const key = sourcesKey(bundle.sources, c.url);
  if (!c.o.noCache) {
    const hit = cacheGet(dir, key);
    if (hit) return { result: hit, cached: true };
  }
  const result = await preview(bundle.sources, { url: c.url, fetchImpl: c.fetchImpl });
  try { cachePut(dir, key, result); } catch { /* read-only checkout: no cache */ }
  return { result, cached: false };
}

// ---------- plain preview (unchanged behaviour + consent + cache) ----------

async function plainFlow(c) {
  const { o, out, err } = c;
  const b = collect({ cwd: c.cwd, targets: o.targets, includeTests: o.includeTests, allowSecrets: o.allowSecrets });
  const mode = o.full || o.bundle ? "full" : "preview";
  if (o.dryRun || !o.json) { err(`${b.kind} project ${b.root}`); listFiles(err, "uploading", b); }
  const problems = checkLimits(b, mode);
  if (o.bundle) {
    fs.writeFileSync(o.bundle, JSON.stringify({ sources: b.sources }, null, 2));
    err(`wrote ${o.bundle}. For the full report send it to POST /scan with your x402 client, or to the MCP tool`
        + " scan_solidity_full, only with your approval (1 USDC).");
    if (problems.length) { err(`over the paid-scan limits: ${problems.join(", ")}`); return 2; }
    return 0;
  }
  if (o.dryRun) { if (problems.length) err(`over the ${mode} limits: ${problems.join(", ")}`); return problems.length ? 2 : 0; }
  if (problems.length) { err(`over the free preview limits: ${problems.join(", ")}. Pass fewer targets (e.g. one contract file).`); return 2; }
  if (!(await ensureConsent(c, b.root, [b]))) return 2;
  const { result: r, cached } = await cachedPreview(c, b.root, b);
  if (o.json) out(JSON.stringify(r, null, 2));
  else {
    const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "no findings";
    out(`Kestrova preview (compiler ${r.compiler || "?"})${cached ? " [cached; nothing uploaded]" : ""}: ${counts}`);
    if ((r.detectors || []).length) out(`High/Medium detectors: ${r.detectors.join(", ")}`);
    if (r.note) out(r.note);
    out("Full line-level report: optional, 1 USDC via x402, only with your approval (kestrova-scan --terms).");
  }
  const worst = Math.max(0, ...Object.keys(r.counts || {}).map((k) => RANK[k.toLowerCase()] || 0));
  return RANK[o.failOn] && worst >= RANK[o.failOn] ? 1 : 0;
}

// ---------- change-aware scan ----------

async function changedFlow(c) {
  const { o, out, err } = c;
  const mode = o.staged || o.hook ? "staged" : "worktree";
  const plan = planChanged({ cwd: c.cwd, baseRef: o.base, mode, includeTests: o.includeTests, targets: o.targets });
  const rel = (p) => path.relative(plan.root, p);
  const scope = [];
  scope.push(`Base: ${plan.base.ref} @ ${plan.base.sha.slice(0, 12)}${plan.base.note ? ` (${plan.base.note})` : ""}; comparing ${mode === "staged" ? "the STAGED content (what will be committed)" : "the working tree"}`);
  const changedRel = plan.rows.map((r) => r.code === "R" ? `${rel(r.oldPath)} -> ${rel(r.path)}` : `${r.code} ${rel(r.path || r.oldPath)}`);
  scope.push(`Changed .sol: ${changedRel.length ? changedRel.join(", ") : "none"}`);
  if (plan.dependents.length) scope.push(`Also analyzed (import a changed file): ${plan.dependents.map(rel).join(", ")}`);
  if (plan.outsideTargets.length) scope.push(`Not analyzed (outside the scanned targets, e.g. tests): ${plan.outsideTargets.map(rel).join(", ")}`);
  if (mode === "staged") {
    const partial = partiallyStaged(plan.root, plan.rows.map((r) => r.path).filter(Boolean));
    if (partial.length) scope.push(`Partially staged (scanned the staged version, not your working copy): ${partial.map(rel).join(", ")}`);
  }
  if (!plan.current.entry.length && !plan.base_.entry.length) {
    if (!o.hook || plan.rows.length) err(`kestrova: no changed Solidity contracts in scope (base ${plan.base.ref}); nothing to scan.`);
    return 0;
  }

  let cur = null, bas = null, currentError, baseError;
  try { cur = plan.current.entry.length ? collect({ ctx: plan.current.ctx, entryFiles: plan.current.entry, allowSecrets: o.allowSecrets }) : null; }
  catch (e) { if (!(e instanceof CollectError)) throw e; currentError = e.message; }
  try { bas = plan.base_.entry.length ? collect({ ctx: plan.base_.ctx, entryFiles: plan.base_.entry, allowSecrets: o.allowSecrets }) : null; }
  catch (e) { if (!(e instanceof CollectError)) throw e; baseError = e.message; }
  for (const [b, set] of [[cur, (m) => { currentError = m; cur = null; }], [bas, (m) => { baseError = m; bas = null; }]]) {
    const problems = b ? checkLimits(b, "preview") : [];
    if (problems.length) set(`over the free preview limits (${problems.join(", ")}); narrow the targets or use the paid report`);
  }
  if (cur) listFiles(err, "current", cur);
  if (bas) listFiles(err, `base (${plan.base.sha.slice(0, 12)})`, bas);
  if ((cur && cur.depsFromWorktree) || (bas && bas.depsFromWorktree))
    scope.push("Dependencies outside git (node_modules, submodules) were read from the working tree for both sides.");
  if (o.dryRun) { for (const l of scope) err(l); return currentError || baseError ? 2 : 0; }

  const toSend = currentError ? [] : [cur, bas].filter(Boolean);
  if (toSend.length && !(await ensureConsent(c, plan.root, toSend))) return o.hook ? 0 : 2;
  let curRes = cur ? undefined : null, basRes = bas ? undefined : (plan.base_.entry.length ? undefined : null);
  let serviceFailure = false;
  let cachedNote = [];
  if (cur) {
    try { const r = await cachedPreview(c, plan.root, cur); curRes = r.result; if (r.cached) cachedNote.push("current"); }
    catch (e) { if (!(e instanceof ServiceError)) throw e; currentError = e.message; serviceFailure = true; }
  }
  if (bas && !currentError) {
    try { const r = await cachedPreview(c, plan.root, bas); basRes = r.result; if (r.cached) cachedNote.push("base"); }
    catch (e) { if (!(e instanceof ServiceError)) throw e; baseError = e.message; serviceFailure = true; }
  }
  if (cachedNote.length) scope.push(`Cached result reused for: ${cachedNote.join(", ")} (identical sources; nothing re-uploaded)`);
  if (currentError) scope.push(`Current side NOT analyzed: ${currentError}`);
  if (baseError) scope.push(`Base side NOT analyzed: ${baseError}`);
  const result = comparePreviews(baseError ? undefined : basRes, currentError ? null : curRes,
                                 { baseError, currentError: currentError || (cur === null && plan.current.entry.length ? "not analyzed" : undefined) });
  const title = `Kestrova ${mode === "staged" ? "staged" : "changed-file"} check`;
  if (o.json) out(JSON.stringify({ base: plan.base, mode, scope, ...result }, null, 2));
  else out(renderText(title, result, scope));
  c.md(renderMarkdown(title, result, scope));

  const blocking = gate(result, o.failOn);
  if (o.hook) {
    if (serviceFailure || currentError) { err("kestrova: could not complete the check; not blocking the commit."); return 0; }
    if (!o.enforce) { if (blocking.length) err(`kestrova (advisory): ${blocking.length} new finding(s) at/above ${o.failOn}. Commit allowed.`); return 0; }
    if (blocking.length) err(`kestrova: commit blocked by ${blocking.length} new finding(s) at/above ${o.failOn}. Bypass once: KESTROVA_SKIP=1 git commit …`);
    return blocking.length ? 1 : 0;
  }
  if (serviceFailure && currentError) return 3;
  if (currentError && !serviceFailure) return 2;
  return blocking.length ? 1 : 0;
}

// ---------- whole-project baseline ----------

async function baselineFlow(c) {
  const { o, out, err } = c;
  const b = collect({ cwd: c.cwd, targets: o.targets, includeTests: o.includeTests, allowSecrets: o.allowSecrets });
  const dir = stateDir(b.root, o.stateDir);
  const problems = checkLimits(b, "preview");
  listFiles(err, o.baseline ? "baseline" : "current", b);
  if (problems.length) { err(`over the free preview limits: ${problems.join(", ")}. Pass fewer targets.`); return 2; }
  if (o.dryRun) return 0;
  const saved = o.compare ? loadBaseline(dir) : null;
  if (o.compare && !saved) { err("no baseline yet: run `kestrova-scan --baseline` first"); return 2; }
  if (!(await ensureConsent(c, b.root, [b]))) return 2;
  const { result, cached } = await cachedPreview(c, b.root, b);
  const top = gitTop(b.root);
  const head = top ? (await import("../lib/changes.mjs")).verifyCommit(top, "HEAD") : null;
  if (o.baseline) {
    const file = saveBaseline(dir, { savedAt: new Date().toISOString(), url: c.url, head, targets: o.targets,
                                     files: b.files.map((f) => ({ file: f.file, sha256: f.sha256 })), result });
    out(`Baseline saved (${path.relative(process.cwd(), file) || file})${cached ? " [cached result]" : ""}: ` +
        (Object.entries(result.counts || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "no findings") +
        ((result.detectors || []).length ? `; High/Medium detectors: ${result.detectors.join(", ")}` : ""));
    return 0;
  }
  const before = new Map(saved.files.map((f) => [f.file, f.sha256]));
  const now = new Map(b.files.map((f) => [f.file, f.sha256]));
  const scope = [`Baseline from ${saved.savedAt}${saved.head ? ` (commit ${saved.head.slice(0, 12)})` : ""}`];
  const added = [...now.keys()].filter((f) => !before.has(f));
  const removed = [...before.keys()].filter((f) => !now.has(f));
  const changed = [...now.keys()].filter((f) => before.has(f) && before.get(f) !== now.get(f));
  scope.push(`Files: ${changed.length} changed, ${added.length} added, ${removed.length} removed since the baseline`);
  if (JSON.stringify(saved.targets || []) !== JSON.stringify(o.targets)) scope.push("Warning: targets differ from the baseline's; RESOLVED is reported as UNKNOWN.");
  let res = comparePreviews(saved.result, result);
  if (JSON.stringify(saved.targets || []) !== JSON.stringify(o.targets))
    res = { ...res, items: res.items.map((i) => (i.status === "RESOLVED" ? { ...i, status: "UNKNOWN", detail: "different scope than the baseline" } : i)) };
  if (o.json) out(JSON.stringify({ scope, ...res }, null, 2)); else out(renderText("Kestrova baseline comparison", res, scope));
  c.md(renderMarkdown("Kestrova baseline comparison", res, scope));
  return gate(res, o.failOn).length ? 1 : 0;
}

// ---------- offline per-finding comparison of two full reports ----------

function compareReportFiles(o, { out, err, cwd, md }) {
  const read = (f) => JSON.parse(fs.readFileSync(path.resolve(cwd, f), "utf8"));
  const [base, current] = o.compareReports.map(read);
  let renames = [], deleted = [];
  if (o.renamesFrom) {
    const top = gitTop(cwd);
    if (!top) { err("--renames-from needs a git repository"); return 2; }
    const sha = resolveBase(top, o.renamesFrom).sha;
    const rows = changedSolidity(path.resolve(cwd), sha, "worktree");
    const rel = (p) => path.relative(path.resolve(cwd), p);
    renames = rows.filter((r) => r.code === "R").map((r) => ({ from: rel(r.oldPath), to: rel(r.path) }));
    deleted = rows.filter((r) => r.code === "D").map((r) => rel(r.oldPath));
  }
  const analyzed = o.scope ? Object.keys(read(o.scope).sources || {}) : undefined;
  const res = compareReports(base, current, { renames, analyzed, deleted });
  if (o.json) out(JSON.stringify(res, null, 2)); else out(renderText("Kestrova full-report comparison", res, []));
  md(renderMarkdown("Kestrova full-report comparison", res, []));
  return gate(res, o.failOn).length ? 1 : 0;
}

// ---------- pre-commit hook admin ----------

function hookAdmin(o, { out, err, cwd }) {
  try {
    if (o.uninstallHook) {
      const r = uninstallHook({ cwd });
      out(r.removed ? `Removed ${r.file}` : `Nothing removed: ${r.reason}`);
      return 0;
    }
    const failOn = o.failOn === "none" ? "high" : o.failOn;
    const projectDir = findRoot(cwd).root;
    const file = installHook({ cwd, nodePath: process.execPath, cliPath: CLI_PATH, enforce: o.enforce, failOn, projectDir });
    out(`Installed ${file} (${o.enforce ? `ENFORCING: blocks commits that add new ${failOn}+ findings` : `advisory: reports new ${failOn}+ findings, never blocks`}).`);
    out("It scans only the staged Solidity changes with the free preview, and never modifies files or history.");
    out("Skip once: KESTROVA_SKIP=1 git commit …   (or git commit --no-verify)   Remove: kestrova-scan --uninstall-hook");
    return 0;
  } catch (e) {
    if (e instanceof HookError) { err(`kestrova-scan: ${e.message}`); return 2; }
    throw e;
  }
}

// Run when executed directly, including through a symlink (npm installs bin entries as symlinks).
function invokedDirectly() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(CLI_PATH); } catch { return false; }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
