// Convert a Kestrova report to SARIF 2.1.0 (GitHub code scanning, IDEs). Offline; no network.
// Accepts: a full report or highlights ({findings:[{detector, impact, confidence, description, locations:[{file, lines}]}]})
// or an address-risk result (schema kestrova.address-risk/v1: findings.own_code[...]).
import { fingerprint } from "./compare.mjs";

const LEVEL = { High: "error", Medium: "warning", Low: "note", Informational: "note", Optimization: "note" };
const SEC = { High: "8.0", Medium: "5.0", Low: "3.0", Informational: "1.0", Optimization: "0.0" };

function normalise(report) {
  if (report && report.schema === "kestrova.address-risk/v1") {
    return (report.findings?.own_code || []).map((f) => ({ detector: f.detector, impact: f.impact, confidence: f.confidence,
      description: f.description, locations: f.file ? [{ file: f.file, lines: f.lines }] : [] }));
  }
  if (!report || !Array.isArray(report.findings)) throw new Error("not a Kestrova report (no findings array)");
  return report.findings;
}

export function toSarif(report, { toolVersion = "0.1.0" } = {}) {
  const findings = normalise(report);
  const rules = new Map();
  const results = [];
  for (const f of findings) {
    if (!rules.has(f.detector)) {
      rules.set(f.detector, { id: f.detector, name: f.detector,
        shortDescription: { text: `Slither detector ${f.detector}` },
        helpUri: `https://github.com/crytic/slither/wiki/Detector-Documentation#${f.detector}`,
        defaultConfiguration: { level: LEVEL[f.impact] || "note" },
        properties: { tags: ["security", "solidity"], "security-severity": SEC[f.impact] || "1.0" } });
    }
    const locs = (f.locations || []).filter((l) => l.file).map((l) => ({ physicalLocation: {
      artifactLocation: { uri: l.file },
      ...(l.lines && l.lines.length ? { region: { startLine: l.lines[0], endLine: l.lines[l.lines.length - 1] } } : {}) } }));
    results.push({ ruleId: f.detector, level: LEVEL[f.impact] || "note",
      message: { text: `${f.impact}${f.confidence ? ` (confidence ${f.confidence})` : ""}: ${(f.description || f.detector).trim()}` },
      locations: locs, partialFingerprints: { "kestrovaFinding/v1": fingerprint(f) },
      properties: { impact: f.impact, confidence: f.confidence } });
  }
  return { $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0",
    runs: [{ tool: { driver: { name: "Kestrova (Slither)", version: toolVersion, informationUri: "https://kestrova.onrender.com",
      rules: [...rules.values()] } }, results,
      properties: { note: "Automated static analysis, not an audit. Zero findings does not mean a contract is safe." } }] };
}
