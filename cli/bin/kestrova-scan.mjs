#!/usr/bin/env node
// kestrova-scan: free Slither preview of a Foundry / Hardhat / plain Solidity project from the command line.
// No payments: the full report is optional, paid via x402 by YOUR wallet client with YOUR approval (see --bundle).
import fs from "node:fs";
import { CollectError, checkLimits, collect } from "../lib/collect.mjs";
import { ServiceError, VERSION, preview, terms } from "../lib/client.mjs";

const HELP = `kestrova-scan ${VERSION}: automated Slither analysis of Solidity (free preview). Not an audit.

Usage:
  kestrova-scan [targets...] [options]       scan files/dirs (default: Foundry "src", Hardhat "contracts")

Options:
  --dry-run            list exactly which files would be uploaded, then stop (no network)
  --json               print the service's JSON response unchanged
  --fail-on LEVEL      exit 1 if the preview reports LEVEL or worse: high | medium | low | none (default none)
  --bundle FILE        write {"sources": ...} to FILE for the paid full report via your own x402 client/MCP
  --full-limits        check the bundle against the paid-scan limits instead of the preview limits
  --include-tests      also scan *.t.sol / *.s.sol and test/ script/ folders
  --allow-secret-pattern  upload even if a file looks like it contains a secret (not recommended)
  --terms              show the current paid-scan terms (reads the public 402 offer; never pays)
  --url URL            service URL (default https://kestrova.onrender.com or $KESTROVA_URL)
  -h, --help, --version

Only .sol files are read; only your targets and the files they import are uploaded. The free preview returns
severity counts and High/Medium detector names. Zero findings does not mean a contract is safe.`;

const RANK = { none: 0, low: 1, medium: 2, high: 3 };

export async function main(argv, { out = console.log, err = console.error, fetchImpl = fetch, cwd = process.cwd() } = {}) {
  const opts = { targets: [], failOn: "none" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { out(HELP); return 0; }
    else if (a === "--version") { out(VERSION); return 0; }
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--include-tests") opts.includeTests = true;
    else if (a === "--allow-secret-pattern") opts.allowSecrets = true;
    else if (a === "--full-limits") opts.full = true;
    else if (a === "--terms") opts.terms = true;
    else if (a === "--fail-on") opts.failOn = (argv[++i] || "").toLowerCase();
    else if (a === "--bundle") opts.bundle = argv[++i];
    else if (a === "--url") opts.url = argv[++i];
    else if (a.startsWith("-")) { err(`unknown option ${a}\n\n${HELP}`); return 2; }
    else opts.targets.push(a);
  }
  if (!(opts.failOn in RANK)) { err("--fail-on must be high, medium, low or none"); return 2; }
  try {
    if (opts.terms) {
      for (const t of await terms({ url: opts.url, fetchImpl }))
        out(`${t.network}  ${Number(t.amount) / 1e6} USDC (${t.asset})  payTo ${t.payTo}  scheme ${t.scheme}`);
      out("Paid scans require your explicit approval and your own x402 wallet client. This tool never pays.");
      return 0;
    }
    const b = collect({ cwd, targets: opts.targets, includeTests: opts.includeTests, allowSecrets: opts.allowSecrets });
    const mode = opts.full || opts.bundle ? "full" : "preview";
    if (opts.dryRun || !opts.json) {
      err(`${b.kind} project ${b.root}`);
      err(`uploading ${b.files.length} .sol file(s), ${b.bytes} bytes:`);
      for (const f of b.files) err(`  ${f.file}${f.upload !== f.file ? `  (as ${f.upload})` : ""}${f.dependency ? "  [dependency]" : ""}`);
    }
    const problems = checkLimits(b, mode);
    if (opts.bundle) {
      fs.writeFileSync(opts.bundle, JSON.stringify({ sources: b.sources }, null, 2));
      err(`wrote ${opts.bundle}. For the full report send it to POST /scan with your x402 client, or to the MCP tool`
          + " scan_solidity_full, only with your approval (1 USDC).");
      if (problems.length) { err(`over the paid-scan limits: ${problems.join(", ")}`); return 2; }
      return 0;
    }
    if (opts.dryRun) {
      if (problems.length) err(`over the ${mode} limits: ${problems.join(", ")}`);
      return problems.length ? 2 : 0;
    }
    if (problems.length) {
      err(`over the free preview limits: ${problems.join(", ")}. Pass fewer targets (e.g. one contract file).`);
      return 2;
    }
    const r = await preview(b.sources, { url: opts.url, fetchImpl });
    if (opts.json) out(JSON.stringify(r, null, 2));
    else {
      const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "no findings";
      out(`Kestrova preview (compiler ${r.compiler || "?"}): ${counts}`);
      if ((r.detectors || []).length) out(`High/Medium detectors: ${r.detectors.join(", ")}`);
      if (r.note) out(r.note);
      out("Full line-level report: optional, 1 USDC via x402, only with your approval (kestrova-scan --terms).");
    }
    const worst = Math.max(0, ...Object.keys(r.counts || {}).map((k) => RANK[k.toLowerCase()] || 0));
    return RANK[opts.failOn] && worst >= RANK[opts.failOn] ? 1 : 0;
  } catch (e) {
    if (e instanceof CollectError) { err(`kestrova-scan: ${e.message}`); return 2; }
    if (e instanceof ServiceError) { err(`kestrova-scan: ${e.message}`); return 3; }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("kestrova-scan")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
