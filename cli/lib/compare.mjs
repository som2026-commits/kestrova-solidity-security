// Comparing two scans honestly.
//
// Free previews only contain severity counts and the SET of High/Medium detector names, so preview comparisons are
// made per detector name plus per-severity counts:
//   NEW       a High/Medium detector present now and not in the baseline, or a severity count that went up
//             (an extra instance of an existing detector; the exact finding needs the full report)
//   EXISTING  detector present in both
//   RESOLVED  detector in the baseline and gone now, ONLY when both sides analyzed the same scope successfully
//             (or the code was deleted)
//   UNKNOWN   anything that could not be determined (a scan failed, the scope was not analyzed, no baseline)
// Full paid reports (if the developer has them) are compared per finding with stable fingerprints instead.
import { createHash } from "node:crypto";

// Slither detector impact (from Slither's detector documentation). Unknown High/Medium names are treated as High
// for --fail-on so a blocking gate errs on the safe side.
const HIGH = ["abiencoderv2-array", "arbitrary-send-erc20", "arbitrary-send-erc20-permit", "arbitrary-send-eth",
  "array-by-reference", "controlled-array-length", "controlled-delegatecall", "delegatecall-loop", "encode-packed-collision",
  "incorrect-exp", "incorrect-return", "incorrect-shift", "msg-value-loop", "multiple-constructors", "name-reused",
  "protected-vars", "public-mappings-nested", "reentrancy-eth", "return-leave", "rtlo", "shadowing-state",
  "storage-array", "suicidal", "unchecked-transfer", "uninitialized-state", "uninitialized-storage",
  "unprotected-upgrade", "weak-prng"];
const MEDIUM = ["boolean-cst", "constant-function-asm", "constant-function-state", "divide-before-multiply",
  "domain-separator-collision", "enum-conversion", "erc20-interface", "erc721-interface", "incorrect-equality",
  "locked-ether", "mapping-deletion", "out-of-order-retryable", "reentrancy-no-eth", "reused-constructor",
  "shadowing-abstract", "tautological-compare", "tautology", "tx-origin", "unchecked-lowlevel", "unchecked-send",
  "uninitialized-local", "unused-return", "write-after-write"];
export const SEVERITIES = ["High", "Medium", "Low", "Informational", "Optimization"];
export const RANK = { none: 0, optimization: 0, informational: 0, low: 1, medium: 2, high: 3 };

export function impactOf(detector) {
  if (HIGH.includes(detector)) return { severity: "High", known: true };
  if (MEDIUM.includes(detector)) return { severity: "Medium", known: true };
  return { severity: "High", known: false };
}

const item = (status, severity, what, detail = "") => ({ status, severity, what, detail });

/**
 * @param {object|null} base     preview result for the base scope, or null when the base side has no files
 * @param {object|null} current  preview result for the current scope, or null when the current side has no files
 * @param {{baseError?:string, currentError?:string, deletedOnly?:boolean}} o
 */
export function comparePreviews(base, current, o = {}) {
  const items = [];
  const notes = [];
  const cur = new Set(current?.detectors || []);
  const bas = new Set(base?.detectors || []);
  if (o.currentError) {
    for (const d of bas) items.push(item("UNKNOWN", impactOf(d).severity, d, `current scan failed: ${o.currentError}`));
    notes.push("The current code could not be analyzed, so nothing can be reported as new or resolved.");
    return { items, counts: countsTable(base, null), complete: false, notes };
  }
  if (current && (o.baseError || base === undefined)) {
    for (const d of cur) items.push(item("NEW", impactOf(d).severity, d, `no baseline (${o.baseError || "not available"}); treated as new`));
    notes.push("No usable baseline: every current High/Medium detector is listed as new.");
    return { items, counts: countsTable(null, current), complete: false, notes };
  }
  for (const d of [...cur].sort()) {
    const sev = impactOf(d).severity;
    items.push(bas.has(d) ? item("EXISTING", sev, d) : item("NEW", sev, d, base ? "" : "in new code"));
  }
  for (const d of [...bas].sort()) {
    if (cur.has(d)) continue;
    items.push(item("RESOLVED", impactOf(d).severity, d, current ? "" : "code removed"));
  }
  // Extra instances hidden behind an existing detector name show up only as a higher count.
  for (const sev of SEVERITIES) {
    const b = base?.counts?.[sev] || 0, c = current?.counts?.[sev] || 0;
    const newNamed = items.filter((i) => i.status === "NEW" && i.severity === sev).length;
    const resolvedNamed = items.filter((i) => i.status === "RESOLVED" && i.severity === sev).length;
    if (c - b > newNamed) items.push(item("NEW", sev, `+${c - b - newNamed} ${sev} finding(s)`,
      sev === "High" || sev === "Medium" ? "extra instance(s) of a detector already present; exact location needs the full report"
                                         : "the free preview names High/Medium detectors only"));
    if (b - c > resolvedNamed) items.push(item("RESOLVED", sev, `-${b - c - resolvedNamed} ${sev} finding(s)`, "count went down"));
  }
  if (Object.values(impactOfAll(cur)).some((k) => !k)) notes.push("Some detector names are not in Kestrova's impact table; they are treated as High for --fail-on.");
  return { items, counts: countsTable(base, current), complete: true, notes };
}

function impactOfAll(set) { return Object.fromEntries([...set].map((d) => [d, impactOf(d).known])); }

function countsTable(base, current) {
  return Object.fromEntries(SEVERITIES.map((s) => [s, [base ? base.counts?.[s] || 0 : null, current ? current.counts?.[s] || 0 : null]]));
}

export function gate(result, failOn) {
  const min = RANK[(failOn || "none").toLowerCase()] || 0;
  if (!min) return [];
  return result.items.filter((i) => i.status === "NEW" && (RANK[i.severity.toLowerCase()] || 0) >= min);
}

// ---------- full (paid) reports: per-finding fingerprints ----------

// Stable across line moves: detector + Slither's description with every "#12-34" line reference removed.
export function fingerprint(f, renames = []) {
  let desc = String(f.description || "");
  for (const r of renames) desc = desc.split(r.from).join(r.to);
  desc = desc.replace(/#\d+(-\d+)?/g, "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${f.detector}|${desc}`).digest("hex").slice(0, 16);
}

/**
 * Compare two full reports ({findings:[{detector, impact, description, locations:[{file, lines}]}]}).
 * renames: [{from, to}] relative paths; analyzed: relative files the CURRENT scan covered (others -> UNKNOWN);
 * deleted: relative files deleted since the base.
 */
export function compareReports(baseReport, currentReport, { renames = [], analyzed, deleted = [] } = {}) {
  const fileOf = (f) => (f.locations && f.locations[0] && f.locations[0].file) || "";
  const curFiles = new Set([...(analyzed || []), ...(currentReport.findings || []).flatMap((f) => (f.locations || []).map((l) => l.file))]);
  const pool = new Map();
  for (const f of currentReport.findings || []) {
    const k = fingerprint(f);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(f);
  }
  const items = [];
  for (const f of baseReport.findings || []) {
    const k = fingerprint(f, renames);
    const match = pool.get(k);
    const renamed = renames.reduce((p, r) => (p === r.from ? r.to : p), fileOf(f));
    if (match && match.length) {
      const c = match.shift();
      items.push({ status: "EXISTING", severity: c.impact, detector: c.detector, file: fileOf(c), lines: c.locations?.[0]?.lines, fingerprint: k });
    } else if (deleted.includes(fileOf(f))) {
      items.push({ status: "RESOLVED", severity: f.impact, detector: f.detector, file: fileOf(f), lines: f.locations?.[0]?.lines, fingerprint: k, detail: "file deleted" });
    } else if (curFiles.has(renamed)) {
      items.push({ status: "RESOLVED", severity: f.impact, detector: f.detector, file: renamed, lines: f.locations?.[0]?.lines, fingerprint: k, detail: "line numbers are from the baseline" });
    } else {
      items.push({ status: "UNKNOWN", severity: f.impact, detector: f.detector, file: renamed, lines: f.locations?.[0]?.lines, fingerprint: k, detail: "file not analyzed in the current scan" });
    }
  }
  for (const rest of pool.values()) for (const c of rest)
    items.push({ status: "NEW", severity: c.impact, detector: c.detector, file: fileOf(c), lines: c.locations?.[0]?.lines, fingerprint: fingerprint(c) });
  return { items, complete: true, notes: [] };
}

// ---------- rendering ----------

const ORDER = { NEW: 0, UNKNOWN: 1, EXISTING: 2, RESOLVED: 3 };
const SEV_ORDER = { High: 0, Medium: 1, Low: 2, Informational: 3, Optimization: 4 };
const sortItems = (items) => [...items].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || ((SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)));

export function renderText(title, result, scopeLines = []) {
  const out = [title, ...scopeLines];
  if (!result.items.length) out.push("No High/Medium detectors on either side.");
  for (const i of sortItems(result.items)) {
    const where = i.file ? ` ${i.file}${i.lines ? `#${i.lines.join("-")}` : ""}` : "";
    out.push(`  ${i.status.padEnd(8)} ${String(i.severity).padEnd(13)} ${i.what || i.detector}${where}${i.detail ? `  (${i.detail})` : ""}`);
  }
  if (result.counts) out.push("Counts (baseline -> current): " + Object.entries(result.counts)
    .map(([s, [b, c]]) => `${s} ${b ?? "-"}->${c ?? "-"}`).join(", "));
  for (const n of result.notes || []) out.push(`Note: ${n}`);
  out.push("Automated static analysis, not an audit. Free previews name High/Medium detectors only; exact lines need the optional paid report (1 USDC, your approval).");
  return out.join("\n");
}

export function renderMarkdown(title, result, scopeLines = []) {
  const out = [`### ${title}`, "", ...scopeLines.map((l) => `- ${l}`), ""];
  const items = sortItems(result.items);
  if (items.length) {
    out.push("| Status | Severity | Finding | Detail |", "|---|---|---|---|");
    for (const i of items) out.push(`| ${i.status} | ${i.severity} | \`${(i.what || i.detector)}\`${i.file ? ` ${i.file}${i.lines ? `#${i.lines.join("-")}` : ""}` : ""} | ${i.detail || ""} |`);
  } else out.push("No High/Medium detectors on either side.");
  if (result.counts) out.push("", "Counts (baseline → current): " + Object.entries(result.counts).map(([s, [b, c]]) => `${s} ${b ?? "–"}→${c ?? "–"}`).join(", "));
  for (const n of result.notes || []) out.push("", `> ${n}`);
  out.push("", "_Automated static analysis by Kestrova (Slither), not an audit. Free previews list High/Medium detector names only._");
  return out.join("\n") + "\n";
}
