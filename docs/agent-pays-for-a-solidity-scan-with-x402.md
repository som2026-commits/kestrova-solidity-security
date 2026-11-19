# How an AI agent pays for a Solidity security scan with x402

This guide shows the whole flow an agent goes through with Kestrova: a free check of a contract, reading the price,
and paying 1 USDC per call with [x402](https://www.x402.org/) for the full report. There is no account, no API key
and no subscription. Every command below was run against the live service on 2026-11-17, and the outputs shown are
real.

Kestrova runs Slither static analysis. It is an automated check, **not an audit**: zero findings does not mean a
contract is safe.

## 0. A contract to check

`Vault.sol`, with an OpenZeppelin import (the scanner supplies OpenZeppelin Contracts 5 imports itself):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
contract Vault is Ownable {
    mapping(address => uint256) public balances;
    constructor() Ownable(msg.sender) {}
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        (bool ok, ) = msg.sender.call{value: balances[msg.sender]}("");
        require(ok);
        balances[msg.sender] = 0;
    }
}
```

## 1. Free preview (no wallet)

```bash
B=https://kestrova-api.onrender.com
jq -n --rawfile src Vault.sol '{sources: {"Vault.sol": $src}}' > body.json
curl -s $B/preview -H 'content-type: application/json' -d @body.json \
  | jq '{counts, detectors, sample: .sample_finding.detector, line: .sample_finding.location.line, more_findings}'
```
```json
{ "counts": { "High": 1, "Informational": 5 }, "detectors": ["reentrancy-eth"],
  "sample": "reentrancy-eth", "line": 8, "more_findings": 5 }
```

The preview gives severity counts, the High/Medium detector names and one real example finding (here, the
reentrancy in `withdraw`, with its line and a reviewed fix in `sample_finding`). The first request after the service
has been idle can take up to a minute.

**An agent should decide here.** If the preview is clean or the agent can fix the issue from the example, it doesn't
need to buy anything. Buy the full report only when High/Medium findings remain and the exact lines are needed, and
**only with the user's approval and within their spending limit.**

## 2. Read the price (x402 `PAYMENT-REQUIRED`)

Calling the paid route without payment returns HTTP 402. It does not scan and does not charge. The terms are in the
`PAYMENT-REQUIRED` header (base64 JSON, x402 v2):

```bash
curl -s -o /dev/null -D - $B/scan -H 'content-type: application/json' -d @body.json \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d \
  | jq '{x402Version, accepts: [.accepts[] | {network, amount, payTo}]}'
```
```json
{ "x402Version": 2,
  "accepts": [
    { "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "amount": "1000000",
      "payTo": "CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc" },
    { "network": "eip155:8453", "amount": "1000000",
      "payTo": "0xB40d2B1B0717dA534e4A98463546cA3E58206cA0" } ] }
```

`1000000` base units means 1.00 USDC. For the cheaper findings-only result (every finding with file and line, JSON,
no explanation or report files), call `POST $B/scan/findings` instead: the same flow, with `"amount": "250000"`
(0.25 USDC). The 1.00 USDC terms below:
- on **Solana mainnet**, settled by the PayAI facilitator;
- on **Base mainnet** (native USDC, EIP-3009), settled by the Coinbase CDP facilitator.

The facilitator pays the network fee, so the buyer's wallet needs only USDC.

**Check the terms before signing.** Accept only exactly this amount, asset and recipient.

## 3. Pay and get the report

Sign **one** `accepts` entry with any x402 v2 client and repeat the same request with the signed payment in the
`PAYMENT-SIGNATURE` header. On success the response is the full report: every finding with detector, severity,
confidence, file and lines, and `scope` (`application` for your code, `dependency` for OpenZeppelin and other
packages). The settlement transaction is in the `PAYMENT-RESPONSE` header.

A complete, safety-first Python client for the Solana rail, using the official x402 SDK, is in
[`examples/python/pay_scan.py`](../examples/python/pay_scan.py):

```bash
pip install "x402[svm,httpx]==2.25.0" httpx
python pay_scan.py Vault.sol                                             # dry run: checks the terms, signs nothing
KESTROVA_SIGNER_KEY_FILE=signer.json python pay_scan.py Vault.sol --pay  # pays once, saves the report
KESTROVA_SIGNER_KEY_FILE=signer.json python pay_scan.py --recover        # re-download later, free
```

## 4. The same flow over MCP

Agents that use MCP (Claude Code, Cursor, Codex and others) connect to `https://kestrova-api.onrender.com/mcp`. It is
Streamable HTTP, with no key. For Claude Code:

```bash
claude mcp add --transport http kestrova https://kestrova-api.onrender.com/mcp
```

| Tool | Cost | What it does |
|---|---|---|
| `scan_solidity_preview` | free | step 1 |
| `payment_terms` | free | recipients, networks and step-by-step payment for both rails |
| `scan_solidity_findings` | 0.25 USDC | Every finding with file/line and Slither's description (JSON). Same payment flow as `scan_solidity_full`. |
| `scan_solidity_full` | 1 USDC | Without `_meta['x402/payment']` it returns the x402 PaymentRequired terms and does not scan. Call it again with the signed payment in `_meta['x402/payment']`; the settlement is in `result._meta['x402/payment-response']`. |

## Safety rules for agents (keep them if you adapt this)

- Pay only with the user's explicit approval and within the limit they set.
- Pin the terms: exactly 1000000 base units of USDC, to the recipient above, on the expected network.
- Each signed payment is single-use. You're charged only when the scan succeeds.
- After an unclear result (timeout, 202 or 409 pending), **never pay again**. Recover the paid report with a wallet
  signature instead (`--recover` in the example, or `POST /scan/recover`).

## Limits

- Free preview: up to 15 KB and 10 files.
- Full report: up to 60 KB and 20 files (OpenZeppelin files supplied by the scanner don't count).
- A `pragma solidity` line is required.

Questions or false positives: [open an issue](https://github.com/som2026-commits/kestrova-solidity-security/issues).
