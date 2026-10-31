// Local state in <project>/.kestrova/ (never uploaded, never committed: it carries its own .gitignore):
//   consent.json   the developer approved uploading .sol files from this project to a given service URL
//   cache/         preview results keyed by a hash of the exact uploaded sources (same input -> no new request)
//   baseline.json  a saved preview of the whole project, for --compare
// No telemetry: nothing in here is ever sent anywhere.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

export function stateDir(root, override) {
  return override || process.env.KESTROVA_STATE_DIR || path.join(root, ".kestrova");
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "# Kestrova local state: never commit\n*\n");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(dir, name, value) {
  ensure(dir);
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export function sourcesKey(sources, url) {
  const h = createHash("sha256");
  h.update(String(url));
  for (const k of Object.keys(sources).sort()) h.update(`\0${k}\0${sources[k]}`);
  return h.digest("hex");
}

export function hasConsent(dir, url) {
  const c = readJson(path.join(dir, "consent.json"));
  return !!(c && c.url === url && c.approved === true);
}

export function saveConsent(dir, url, files) {
  return writeJson(dir, "consent.json", { url, approved: true, approvedAt: new Date().toISOString(),
    note: "Approved uploading this project's Solidity sources (targets + their imports only) to the URL above.",
    firstUpload: files });
}

export function cacheGet(dir, key, now = Date.now()) {
  const c = readJson(path.join(dir, "cache", `${key}.json`));
  return c && now - c.at < CACHE_TTL_MS ? c.result : null;
}

export function cachePut(dir, key, result, now = Date.now()) {
  return writeJson(dir, path.join("cache", `${key}.json`), { at: now, result });
}

export function saveBaseline(dir, baseline) { return writeJson(dir, "baseline.json", baseline); }
export function loadBaseline(dir) { return readJson(path.join(dir, "baseline.json")); }
