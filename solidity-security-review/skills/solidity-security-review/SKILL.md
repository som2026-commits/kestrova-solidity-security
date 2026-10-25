---
name: solidity-security-review
description: Security review for Solidity smart contracts. Use whenever you write, generate, modify or refactor a Solidity (.sol) contract, prepare one for deployment (Foundry, Hardhat, Remix, scripts), or the user asks for a security review, audit, vulnerability check or "is this contract safe". Runs a free Slither static-analysis preview, explains the results honestly, and offers an optional paid line-level report only with the user's explicit approval.
---

# Solidity Security Review (Kestrova)

Automated static analysis (Slither) to catch known vulnerability patterns before a contract is deployed.
It is a safety net, not an audit.

## When to run it
- You created a new Solidity contract or made a non-trivial change (state, transfers, external calls, access control, upgrades).
- Before any deployment step, including testnet.
- The user asks for a security review, audit, vulnerability scan or "is it safe?".
Skip it for comment-only or formatting-only edits.

## Workflow

1. **Collect sources.** Build `{"sources": {"path/File.sol": "<source>", ...}}` with the contract and every local file it
   imports (OpenZeppelin and other libraries too, if they are vendored in the project). Max 60 kB, 20 files.
2. **Free preview (no key, no payment).**
   - MCP (preferred): call `scan_solidity_preview` on the `kestrova` MCP server.
   - HTTP: `curl -s -X POST "https://kestrova.onrender.com/preview?src=skill" -H 'content-type: application/json' -d @payload.json`
   - Local alternative: if `slither` is already installed in the project, you may run it directly instead.
   The preview returns severity counts and the names of High/Medium detectors. The first call can take up to a
   minute while the service wakes up.
3. **Act on the preview.**
   - Use the detector names (e.g. `reentrancy-eth`, `tx-origin`, `unchecked-send`, `arbitrary-send-eth`) to find and
     fix the issue yourself where it is clear; re-run the preview to confirm the count drops.
   - If High/Medium findings remain and you cannot locate them, the optional full report gives exact lines.
4. **Optional paid report: ask first.** Tell the user, in one message: what was found (counts, detector names), the
   price (call `payment_terms`), that payment is USDC on Solana via
   x402 from *their own* configured wallet, and that they are charged only if the scan succeeds. Proceed only on an
   explicit "yes" and only within a spending limit the user has set. Never pay silently, never retry a payment without
   asking again, never ask for, read or handle private keys or seed phrases. If no x402-capable wallet tool is
   configured, say so and stop at the free preview.
5. **Fix and verify.** For each finding: show the location, explain the risk in one or two sentences, propose a fix
   (checks-effects-interactions, `ReentrancyGuard`, `msg.sender` instead of `tx.origin`, checked `call` results,
   access control), apply it if the user agrees, then re-run the free preview.

## How to report results (mandatory wording rules)
- Never say a contract is "safe", "secure", "audited" or "verified" because a scan found nothing. Say:
  "Slither found no issues in the patterns it checks. This is not an audit."
- Always state the coverage limits below when summarising a clean or nearly clean result.
- For contracts that will hold real value, recommend a professional audit and thorough tests in addition to this scan.

## Coverage limits
Detects known code patterns only. It does not evaluate business logic, economic, oracle or MEV attacks, whether access
control matches the intended design, upgrade and admin-key risks, code not included in the sources, or deployment
configuration. Findings can include false positives: verify each one before changing code.

## Setup (one time)
- Claude Code: `claude mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=skill"`
- Other MCP clients: remote server, Streamable HTTP, URL `https://kestrova.onrender.com/mcp?src=skill`, no auth.
- HTTP only: no setup for the free preview.
