# Kestrova: Solidity security review for coding agents

An agent skill plus a remote MCP server. When your coding agent writes, changes or prepares to deploy a Solidity
contract, it runs a **free** Slither static-analysis preview, explains the results without overclaiming, and offers an
**optional** paid line-level report only after you approve the price.

## Install (pick one)
| Agent | Command |
|---|---|
| Claude Code (plugin: skill + MCP) | `/plugin marketplace add som2026-commits/kestrova-solidity-security` then `/plugin install solidity-security-review@kestrova` |
| Any agent that supports skills (SKILL.md) | `npx skills add som2026-commits/kestrova-solidity-security --skill solidity-security-review` |
| MCP only (any MCP client) | remote Streamable HTTP server `https://kestrova.onrender.com/mcp?src=registry` (Claude Code: `claude mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=skill"`) |

In our tests, agents with only the MCP server did not run the check unprompted; the skill is what makes them do it.

## What it does
- `scan_solidity_preview` (free, no key): severity counts and High/Medium detector names.
- `scan_solidity_full` (paid, optional): every finding with detector, impact, confidence and file/line locations.
  Paid per call via [x402](https://x402.org) in USDC on Solana from **your own** wallet tool; charged only if the scan
  succeeds. The skill forbids paying without your explicit approval and never handles keys.
- `payment_terms` (free): current price and payment details.

## Limits (read this)
Automated pattern detection (Slither), **not an audit**. A clean result does not mean a contract is safe. Not covered:
business logic, economic/oracle/MEV attacks, access-control intent, upgrade and admin-key risk, code not sent, deployment
configuration. Use professional audits and tests for anything holding value.

## Privacy
Sources you send are scanned in a temporary directory that is deleted after each scan; the service does not store or
log them. The service's usage log records the route, status, client family and the `src` install-channel tag, never IP
addresses or source code (IP addresses are held in memory only for rate limiting). The hosting providers (Render,
Cloudflare) may keep their own standard request logs.

## Contents
`.claude-plugin/marketplace.json` (marketplace), `solidity-security-review/` (plugin: `.claude-plugin/plugin.json`,
`.mcp.json`, `skills/solidity-security-review/SKILL.md`). No server code.

License: MIT (see LICENSE).
