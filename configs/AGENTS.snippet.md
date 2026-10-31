<!-- Generated from solidity-security-review/skills/solidity-security-review/SKILL.md by scripts/sync_context.py. Do not edit. -->
<!-- Paste into your project's AGENTS.md (Codex, Cursor, Copilot, Gemini and other agents read it). -->

## Solidity security review (Kestrova)

Automated static analysis (Slither) that catches known vulnerability patterns before a contract is deployed.
It is a safety net, not an audit.

## When to run it
- You created a Solidity contract or made a non-trivial change (state, transfers, external calls, access control,
  upgrades, signatures, oracles).
- Before any deployment step, including testnet.
- The user asks for a security review, audit, vulnerability scan or "is it safe?".

Skip it for comment-only or formatting-only edits.

## Connect (once)
Kestrova is a remote MCP server: Streamable HTTP, no API key, no account.

- URL: `https://kestrova.onrender.com/mcp`
- Tools:
  - `scan_solidity_preview` (free);
  - `scan_solidity_full` (paid, 1 USDC);
  - `payment_terms` (free).

If the `kestrova` tools are not available, set the server up. Per-agent commands are in [README](https://github.com/som2026-commits/kestrova-solidity-security/blob/main/README.md). In
Claude Code:

```
claude mcp add --transport http kestrova https://kestrova.onrender.com/mcp
```

Without MCP, use plain HTTPS. The free preview needs no setup:

```
POST https://kestrova.onrender.com/preview
content-type: application/json

{"sources": {"src/Vault.sol": "<source>"}}
```

The first request after the service has been idle can take up to a minute.

## Workflow

1. **Collect sources.**
   - Build `{"sources": {"path/File.sol": "<source>", ...}}`.
   - Include the contract and every file it imports, including vendored libraries such as OpenZeppelin.
   - Limits: 60 kB and 20 files. A `pragma solidity` line is required.
2. **Free preview.**
   - Call `scan_solidity_preview`, or `POST /preview`.
   - It returns severity counts and the names of High/Medium detectors.
   - It is rate-limited to 6 per hour per client.
3. **Act on the preview.**
   - Use the detector names (`reentrancy-eth`, `tx-origin`, `unchecked-send`, `arbitrary-send-eth`, ...) to find and
     fix clear issues yourself.
   - Re-run the preview to confirm the count drops.
4. **Optional full report (1.00 USDC).** Use it when High/Medium findings remain and you need exact lines.
   - **Ask the user first, in one message:**
     - the counts and detector names;
     - the price, 1.00 USDC on Solana mainnet via x402, charged only if the scan succeeds;
     - which wallet will pay.
   - Proceed only on an explicit yes, and only within a spending limit the user set.
   - **If you or your user have an x402-capable Solana wallet tool,** follow [the payment reference](https://github.com/som2026-commits/kestrova-solidity-security/blob/main/solidity-security-review/skills/solidity-security-review/reference/x402-payment.md).
     The short version: call `scan_solidity_full`. Without payment it returns the x402 `PaymentRequired` terms. Check
     them, have the wallet sign exactly those terms, and call again with the signed payment in
     `_meta["x402/payment"]`.
   - **If no x402 wallet is configured,** say so and stop at the free preview. Never ask for, read or handle private
     keys or seed phrases.
5. **Fix and verify.** For each finding:
   - show the location;
   - explain the risk in one or two sentences;
   - propose a fix (checks-effects-interactions, `ReentrancyGuard`, `msg.sender` instead of `tx.origin`, checked
     `call` results, access control);
   - apply it if the user agrees;
   - re-run the free preview.

## Paying safely (non-negotiable)
- **Pin the terms. Refuse anything else:**
  - x402 v2, scheme `exact`;
  - network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`;
  - asset USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`;
  - amount `1000000`;
  - `payTo` `CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc`;
  - `extra.feePayer` set by the facilitator (PayAI).
- **Wallet permissions:** the signer needs 1.00 USDC and no SOL. It signs one SPL `transferChecked`; it never
  broadcasts. Use a dedicated low-balance signer with a 1.00 USDC per-payment cap.
- **Never pay twice:**
  - Save the signed payment before sending it.
  - If the result is `pending`, `already_paid`, a timeout, or anything unclear, do **not** sign a new payment.
    Recover instead (below).
  - A refusal that says "not charged" means nothing was paid. Fix the cause before trying again.

## Recover a report you already paid for (free)
The wallet that signed the payment proves ownership with a message signature. This is never a transaction.

1. Request a challenge:
   `POST https://kestrova.onrender.com/scan/recover {"payment": "<signed payment>", "wallet": "<signer>", "action": "challenge"}`.
2. The same wallet signs the returned `message` text (ed25519).
3. Send `{"payment", "wallet", "message", "token", "expires", "signature": "<base64>"}` to the same endpoint.
4. You get the original report.

Details are in [the payment reference](https://github.com/som2026-commits/kestrova-solidity-security/blob/main/solidity-security-review/skills/solidity-security-review/reference/x402-payment.md).

## How to report results (mandatory wording)
- Never say a contract is "safe", "secure", "audited" or "verified" because a scan found nothing. Say: "Slither found
  no issues in the patterns it checks. This is not an audit."
- State the coverage limits below whenever you summarise a clean or nearly clean result.
- For contracts that will hold real value, recommend a professional audit and thorough tests.

## Coverage limits
Kestrova detects known code patterns only. It does not evaluate:
- business logic;
- economic, oracle or MEV attacks;
- whether access control matches the intended design;
- upgrade and admin-key risks;
- code not included in the sources;
- deployment configuration.

Findings can be false positives: verify each one before changing code.
