// HTTP client for Kestrova's FREE endpoints. This module has no payment code: it never signs, never sends a
// PAYMENT-SIGNATURE / X-PAYMENT header and never retries a paid request. `terms()` only reads the public 402 offer.
export const DEFAULT_URL = "https://kestrova-api.onrender.com";
export const VERSION = "0.1.4";

export class ServiceError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

export function serviceUrl(url) { return (url || process.env.KESTROVA_URL || DEFAULT_URL).replace(/\/+$/, ""); }
const base = serviceUrl;

async function post(url, path, body, fetchImpl) {
  const headers = { "content-type": "application/json", accept: "application/json",
                    "user-agent": `kestrova-cli/${VERSION}` };
  let res;
  try {
    res = await fetchImpl(`${base(url)}${path}?src=cli`, { method: "POST", headers, body: JSON.stringify(body),
                                                          signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new ServiceError(`cannot reach Kestrova (${e.name === "TimeoutError" ? "timeout" : e.message})`, 0);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { res, json, text };
}

export async function preview(sources, { url, fetchImpl = fetch } = {}) {
  const { res, json, text } = await post(url, "/preview", { sources }, fetchImpl);
  if (res.status === 200 && json) return json;
  const detail = (json && (json.detail || json.error)) || text.slice(0, 200) || res.statusText;
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new ServiceError(`free preview limit reached; retry${retry ? ` in ${retry}s` : " later"}`, 429, json);
  }
  throw new ServiceError(`preview failed (${res.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
                         res.status, json);
}

// Read the public payment offer without paying: POST /scan with no payment header returns 402 + PAYMENT-REQUIRED.
export async function terms({ url, fetchImpl = fetch } = {}) {
  const probe = { "Terms.sol": "pragma solidity ^0.8.20; contract T {}" };
  const { res } = await post(url, "/scan", { sources: probe }, fetchImpl);
  if (res.status !== 402) throw new ServiceError(`expected a 402 offer, got ${res.status}`, res.status);
  const header = res.headers.get("payment-required");
  if (!header) throw new ServiceError("402 without PAYMENT-REQUIRED header", 402);
  const offer = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return (offer.accepts || []).map((a) => ({ network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo,
                                            scheme: a.scheme }));
}
