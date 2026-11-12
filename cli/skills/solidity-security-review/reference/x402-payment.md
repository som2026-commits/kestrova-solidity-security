# Paying for a Kestrova full report with x402 (USDC on Base or Solana)

Load this only when the user approves buying a full report and an x402-capable Base or Solana wallet is configured.

## Accepted terms

The 402 response offers two options, Solana and Base. Use the one your wallet supports and compare every field;
if any differs, refuse and tell the user.

### Solana

| Field | Value |
|---|---|
| `x402Version` | `2` |
| `accepts[].scheme` | `exact` |
| `accepts[].network` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet) |
| `accepts[].asset` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC) |
| `accepts[].amount` | `1000000` (1.00 USDC) |
| `accepts[].payTo` | `CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc` |
| `accepts[].extra.feePayer` | the facilitator's fee payer (PayAI); the buyer pays no SOL |

### Base

| Field | Value |
|---|---|
| `x402Version` | `2` |
| `accepts[].scheme` | `exact` |
| `accepts[].network` | `eip155:8453` (Base mainnet) |
| `accepts[].asset` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC; EIP-712 domain `USD Coin`, version `2`) |
| `accepts[].amount` | `1000000` (1.00 USDC) |
| `accepts[].payTo` | `0xB40d2B1B0717dA534e4A98463546cA3E58206cA0` |
| method | EIP-3009 `transferWithAuthorization`, valid ≤ 5 minutes; no approval, no Permit2; the buyer pays no ETH |

## Over MCP

1. Call `tools/call` with `{"name": "scan_solidity_full", "arguments": {"sources": {...}}}` and no payment.
   - The result has `isError: true`.
   - Its `structuredContent` is the x402 `PaymentRequired` object, with `x402Version` and `accepts`.
   - Nothing is scanned and nothing is charged.
2. Check the terms against the table. Create the payment with your x402 client.
   - **Solana:** the wallet signs a transaction with one USDC `transferChecked` for exactly those terms; the
     facilitator adds its fee-payer signature and broadcasts it.
   - **Base:** the wallet signs one EIP-3009 authorization for exactly those terms; the facilitator submits it.
3. **Persist the signed payment payload before sending it.**
4. Call the same tool again with the same `sources` and `params._meta["x402/payment"] = <PaymentPayload object>`.
5. On success:
   - `structuredContent` is the report (`compiler`, `counts`, `findings` with file and line locations);
   - `result._meta["x402/payment-response"]` holds `success: true` and the settlement `transaction`.

## Over HTTP

1. `POST https://kestrova-api.onrender.com/scan` with `{"sources": {...}}` returns **402**.
   - The `PAYMENT-REQUIRED` response header holds base64-encoded JSON with the terms above.
2. Create the payment from those terms.
3. Repeat the identical request with header `PAYMENT-SIGNATURE: <base64 PaymentPayload>`.
4. **200** means the report is in the body, and the base64 `PAYMENT-RESPONSE` header holds the settlement receipt.

Official x402 clients work unmodified. Examples:
- Python `x402` with `x402.http.clients.httpx.x402AsyncTransport`;
- TypeScript `@x402/fetch` with a Solana signer (`@x402/svm`) or a Base signer (`@x402/evm`).

Configure them to:
- accept only USDC;
- cap each payment at `1000000` base units;
- accept only the `payTo` of the network you pay on (above).

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
   POST https://kestrova-api.onrender.com/scan/recover
   {"payment": "<base64 PaymentPayload>", "wallet": "<signer address>", "action": "challenge"}
   ```

   - The response is `{"message", "token", "expires"}`.
   - The challenge is valid for 120 seconds.
   - If the original payload is lost, send `"payment_key"` instead of `"payment"`: the 64-hex sha256 of the signed
     transaction message (Solana), or of `eip155:8453|<USDC>|<from>|<nonce>` in lower case (Base).
2. Sign the exact `message` string with the wallet that signed the USDC payment: an ed25519 message signature
   (Solana, base64), or an EIP-191 `personal_sign` signature (Base, `0x…` hex).
3. Send it back:

   ```
   POST https://kestrova-api.onrender.com/scan/recover
   {"payment": "...", "wallet": "...", "message": "...", "token": "...", "expires": 1793500000, "signature": "<base64 ed25519 signature>"}
   ```

4. Read the response:
   - **200:** the original report.
   - **202 `pending`:** no verified on-chain settlement yet. Wait and retry recovery; never pay again.
   - **404 `not_found`:** that payment was never recorded, so it was not charged.
