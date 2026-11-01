# Paying for a Kestrova full report with x402 (Solana, USDC)

Load this only when the user approves buying a full report and an x402-capable Solana wallet is configured.

## Accepted terms

The only accepted terms are below. Compare every field; if any differs, refuse and tell the user.

| Field | Value |
|---|---|
| `x402Version` | `2` |
| `accepts[].scheme` | `exact` |
| `accepts[].network` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) |
| `accepts[].asset` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC) |
| `accepts[].amount` | `1000000` (1.00 USDC) |
| `accepts[].payTo` | `CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc` |
| `accepts[].extra.feePayer` | the facilitator's fee payer (PayAI); the buyer pays no SOL |

## Over MCP

1. Call `tools/call` with `{"name": "scan_solidity_full", "arguments": {"sources": {...}}}` and no payment.
   - The result has `isError: true`.
   - Its `structuredContent` is the x402 `PaymentRequired` object, with `x402Version` and `accepts`.
   - Nothing is scanned and nothing is charged.
2. Check the terms against the table. Create the payment with your x402 client.
   - The wallet signs a transaction containing one USDC `transferChecked` for exactly those terms.
   - The facilitator adds its fee-payer signature and broadcasts it.
3. **Persist the signed payment payload before sending it.**
4. Call the same tool again with the same `sources` and `params._meta["x402/payment"] = <PaymentPayload object>`.
5. On success:
   - `structuredContent` is the report (`compiler`, `counts`, `findings` with file and line locations);
   - `result._meta["x402/payment-response"]` holds `success: true` and the Solana `transaction` signature.

## Over HTTP

1. `POST https://kestrova.onrender.com/scan` with `{"sources": {...}}` returns **402**.
   - The `PAYMENT-REQUIRED` response header holds base64-encoded JSON with the terms above.
2. Create the payment from those terms.
3. Repeat the identical request with header `PAYMENT-SIGNATURE: <base64 PaymentPayload>`.
4. **200** means the report is in the body, and the base64 `PAYMENT-RESPONSE` header holds the settlement receipt.

Official x402 clients work unmodified. Examples:
- Python `x402` with `x402.http.clients.httpx.x402AsyncTransport`;
- TypeScript `@x402/fetch` / `x402-fetch` with a Solana signer.

Configure them to:
- accept only USDC;
- cap each payment at `1000000` base units;
- accept only the `payTo` above.

## Outcomes

| Response | Meaning | What to do |
|---|---|---|
| 200 / MCP success with receipt | Paid and delivered | Done. Keep the signed payment for recovery |
| 402 + `X-Payment-Error`, or MCP `invalid payment ... not charged` | Refused before settlement | Fix the cause; a new payment is allowed |
| 202 / 409 `pending`, MCP `status: pending` | Outcome unknown | **Do not pay again.** Recover |
| 409 `already_paid`, MCP `status: already_paid` | Already settled | Recover; do not pay again |
| 429 | Too many attempts | Wait for `Retry-After` |
| 503 `... not charged` | Service unavailable before settlement | Retry later |

The service reserves each signed payment exactly once, shared by HTTP and MCP. The same signature can never be charged
or delivered twice. Signing a *new* payment after an unclear outcome *can* charge again: that is why you recover.

## Recovery (free, wallet-authenticated)

1. Ask for a challenge:

   ```
   POST https://kestrova.onrender.com/scan/recover
   {"payment": "<base64 PaymentPayload>", "wallet": "<signer address>", "action": "challenge"}
   ```

   - The response is `{"message", "token", "expires"}`.
   - The challenge is valid for 120 seconds.
   - If the original payload is lost, send `"payment_key"` instead of `"payment"`: the 64-hex sha256 of the signed
     transaction message.
2. Sign the exact `message` string with the wallet that signed the USDC transfer (ed25519 message signature).
3. Send it back:

   ```
   POST https://kestrova.onrender.com/scan/recover
   {"payment": "...", "wallet": "...", "message": "...", "token": "...", "expires": 1793500000, "signature": "<base64 ed25519 signature>"}
   ```

4. Read the response:
   - **200:** the original report.
   - **202 `pending`:** no verified on-chain settlement yet. Wait and retry recovery; never pay again.
   - **404 `not_found`:** that payment was never recorded, so it was not charged.
