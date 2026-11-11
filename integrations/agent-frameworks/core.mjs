// Framework-agnostic Kestrova client for autonomous agents (used by the AgentKit and Solana Agent Kit adapters).
//
// Payment safety: this module never holds keys and never signs. Paid calls happen ONLY when the agent developer
// passes BOTH an x402-capable `paymentFetch` (e.g. a fetch wrapped by their own x402 client and wallet) AND a
// `maxPaymentUsd` cap; the price in the server's 402 offer is checked against the cap BEFORE paymentFetch is called.
// Without them, paid actions return the price and how to enable payment, and nothing is paid.
export const DEFAULT_URL = "https://kestrova-api.onrender.com";
export const VERSION = "0.1.0";
const UA = `kestrova-agent-tools/${VERSION}`;

export class KestrovaError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

function base(url) { return (url || DEFAULT_URL).replace(/\/+$/, ""); }

async function call(fetchImpl, url, path, body, tag) {
  const res = await fetchImpl(`${base(url)}${path}?src=${tag}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { res, json, text };
}

function offerOf(res) {
  const h = res.headers.get("payment-required");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

/** Free: verified?, proxy?, privileged controls of a deployed EVM contract. */
export async function contractRiskPreview({ chain, address }, { url, fetchImpl = fetch, tag = "agent" } = {}) {
  const { res, json, text } = await call(fetchImpl, url, "/risk/address/preview", { chain, address }, tag);
  if (res.status === 200 && json) return json;
  throw new KestrovaError((json && json.error) || text.slice(0, 200), res.status, json);
}

/** Free: Slither preview of Solidity sources (severity counts + High/Medium detector names). */
export async function solidityPreview({ sources }, { url, fetchImpl = fetch, tag = "agent" } = {}) {
  const { res, json, text } = await call(fetchImpl, url, "/preview", { sources }, tag);
  if (res.status === 200 && json) return json;
  throw new KestrovaError((json && (json.error || json.detail)) || text.slice(0, 200), res.status, json);
}

/**
 * Paid x402 call with a hard price cap. Returns {paid:false, ...} without paying when payment is not configured or
 * the offer exceeds the cap; {paid:true, result} on success; never retries a payment.
 */
export async function paidCall(path, body, { url, fetchImpl = fetch, paymentFetch, maxPaymentUsd = 0, tag = "agent" } = {}) {
  const probe = await call(fetchImpl, url, path, body, tag);
  if (probe.res.status !== 402) {
    if (probe.res.ok) return { paid: false, result: probe.json };
    throw new KestrovaError((probe.json && (probe.json.error || probe.json.detail)) || probe.text.slice(0, 200), probe.res.status, probe.json);
  }
  const offer = offerOf(probe.res);
  const amounts = (offer?.accepts || []).map((a) => Number(a.amount)).filter((n) => Number.isFinite(n) && n > 0);
  if (!amounts.length) throw new KestrovaError("402 without a readable payment offer", 402);
  const priceUsd = Math.max(...amounts) / 1e6;                       // every offered rail must fit the cap
  const terms = (offer.accepts || []).map((a) => ({ network: a.network, amount: a.amount, payTo: a.payTo, asset: a.asset }));
  if (typeof paymentFetch !== "function")
    return { paid: false, priceUsd, terms, message: "payment not configured: pass an x402 paymentFetch (your own wallet) and maxPaymentUsd to enable this paid action" };
  if (!(priceUsd <= Number(maxPaymentUsd)))
    return { paid: false, priceUsd, terms, message: `price ${priceUsd} USD is above maxPaymentUsd ${maxPaymentUsd}; not paid` };
  const res = await paymentFetch(`${base(url)}${path}?src=${tag}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
    body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (res.ok) return { paid: true, priceUsd, result: json };
  // Not charged on errors (the service only settles successful results); never retry a payment automatically.
  return { paid: false, priceUsd, status: res.status, error: (json && (json.error || json.status)) || text.slice(0, 200),
           recovery: json && json.recovery ? `${base(url)}${json.recovery.replace(/^POST /, "")}` : undefined };
}

/** Paid ($0.05): explained high/medium/low verdict for a deployed contract. Unverified contracts are not charged. */
export function contractRiskCheck({ chain, address }, opts = {}) {
  return paidCall("/risk/address", { chain, address }, opts);
}

/** Paid ($0.10): High/Medium Slither findings with file and lines for Solidity sources. */
export function solidityHighlights({ sources }, opts = {}) {
  return paidCall("/scan/highlights", { sources }, opts);
}

export const CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche", "linea", "scroll",
                       "sepolia", "base-sepolia"];

export const DESCRIPTIONS = {
  riskPreview: "FREE. Before interacting with a deployed EVM contract (buy, approve, deposit), check whether its source "
    + "is verified, whether it is an upgradeable proxy, and which privileged controls it has (mint, pause, blacklist, "
    + "fee/limit setters, upgrade, owner/roles). Kestrova; automated analysis, not an audit.",
  riskCheck: "PAID (0.05 USDC via x402, only if payment is configured with a spending cap). Explained high/medium/low "
    + "risk verdict for a deployed EVM contract from its verified source, proxy, privileged controls and Slither "
    + "findings. Unverified contracts are not charged. Use before sending funds to an unknown contract. Not an audit.",
  solidityPreview: "FREE. Slither preview of Solidity sources you wrote: severity counts and High/Medium detector "
    + "names. Include every imported file. Not an audit.",
  solidityHighlights: "PAID (0.10 USDC via x402, only if payment is configured with a spending cap). High/Medium "
    + "Slither findings with file and lines for Solidity sources. Not an audit.",
};
