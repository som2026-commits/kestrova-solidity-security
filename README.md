# Kestrova: Solidity security review for AI coding agents

When your coding agent writes, changes or prepares to deploy a Solidity contract, Kestrova runs a **free** Slither
static-analysis preview. The agent explains the results without overclaiming, and offers an **optional** full
line-level report for **1 USDC on Solana** via [x402](https://x402.org), only after you approve it.

- **Remote MCP server:** `https://kestrova.onrender.com/mcp` (Streamable HTTP, no API key, no account).
- **Official MCP Registry name:** `io.github.som2026-commits/kestrova`.
- **Agent-readable summary:** [`/llms.txt`](https://kestrova.onrender.com/llms.txt).
- **OpenAPI:** [`/openapi.json`](https://kestrova.onrender.com/openapi.json) (the paid operation carries `x-payment-info`).

## Install

The skill is what makes agents run the check unprompted. MCP alone gives them the tools. Install both where your agent
supports it.

| Agent | MCP server | Skill / instructions |
|---|---|---|
| **Claude Code** | `claude mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=claude"` | `/plugin marketplace add som2026-commits/kestrova-solidity-security`, then `/plugin install solidity-security-review@kestrova` (skill + MCP in one step) |
| **OpenAI Codex** (CLI and IDE) | `codex mcp add kestrova --url "https://kestrova.onrender.com/mcp?src=codex"`, or append [`configs/codex-config.toml`](configs/codex-config.toml) to `~/.codex/config.toml` | `npx skills add som2026-commits/kestrova-solidity-security --skill solidity-security-review`, or paste [`configs/AGENTS.snippet.md`](configs/AGENTS.snippet.md) into `AGENTS.md` |
| **Cursor** | [`configs/cursor-mcp.json`](configs/cursor-mcp.json) → `~/.cursor/mcp.json` (or `.cursor/mcp.json`), or open `cursor://anysphere.cursor-deeplink/mcp/install?name=kestrova&config=eyJ1cmwiOiJodHRwczovL2tlc3Ryb3ZhLm9ucmVuZGVyLmNvbS9tY3A/c3JjPWN1cnNvciJ9` | `npx skills add …` (as above), or [`configs/AGENTS.snippet.md`](configs/AGENTS.snippet.md) → `AGENTS.md` |
| **GitHub Copilot / VS Code** | [`configs/vscode-mcp.json`](configs/vscode-mcp.json) → `.vscode/mcp.json`, or `code --add-mcp '{"name":"kestrova","type":"http","url":"https://kestrova.onrender.com/mcp?src=vscode"}'` | [`configs/AGENTS.snippet.md`](configs/AGENTS.snippet.md) → `AGENTS.md` or `.github/copilot-instructions.md` |
| **Gemini CLI** | `gemini extensions install https://github.com/som2026-commits/kestrova-solidity-security` (MCP + context in one step), or `gemini mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=gemini"` | included in the extension ([`GEMINI.md`](GEMINI.md)) |
| **Any MCP client** | remote Streamable HTTP server `https://kestrova.onrender.com/mcp?src=registry`, no auth | [SKILL.md](solidity-security-review/skills/solidity-security-review/SKILL.md) |
| **Custom / Web3 agents** (Solana Agent Kit, x402 clients) | MCP as above, or plain HTTPS: `POST /preview` (free), `POST /scan` (x402) | [payment reference](solidity-security-review/skills/solidity-security-review/reference/x402-payment.md) |

The `?src=` tag only attributes installs in Kestrova's aggregate usage log. The plain `/mcp` URL works the same.

## Tools

- **`scan_solidity_preview` (free):** severity counts and High/Medium detector names. 60 kB / 20 files, 6 per hour per
  client.
- **`scan_solidity_full` (paid, 1.00 USDC):** every finding with detector, impact, confidence and file/line locations.
  Without a payment it returns the x402 terms; it never scans or charges then. You are charged only if the scan
  succeeds.
- **`payment_terms` (free):** price, recipient, network, fee payer, wallet requirements, outcomes and recovery.

## Try it (no install, free)

```sh
curl -s -X POST "https://kestrova.onrender.com/preview?src=readme" -H 'content-type: application/json' \
  -d '{"sources":{"Vault.sol":"pragma solidity ^0.8.20;\ncontract Vault {\n mapping(address=>uint) public b;\n function deposit() external payable { b[msg.sender] += msg.value; }\n function withdraw() external {\n  (bool ok,) = msg.sender.call{value: b[msg.sender]}(\"\");\n  require(ok);\n  b[msg.sender] = 0;\n }\n}"}}'
```

The response contains `counts` and `detectors` (High/Medium detector names), here `reentrancy-eth`. The first call after idle can
take up to a minute.

## Payment, for autonomous agents

| Field | Value |
|---|---|
| Protocol | x402 v2, scheme `exact` (HTTP `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`; MCP `_meta["x402/payment"]`) |
| Price | 1.00 USDC (`1000000` base units) per scan. No other asset or network |
| Network | Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Asset | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Pay to | `CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc` |
| Fee payer | PayAI facilitator (`extra.feePayer`); the buyer needs **no SOL** |
| Wallet permission | sign one SPL `transferChecked` of exactly 1.00 USDC; never broadcast, never share keys |

**Replay protection:** each signed payment is accepted at most once, across HTTP and MCP. After an unclear outcome
(`pending`, `already_paid`, timeout), **do not sign a new payment**. Recover the report for free with a wallet-signed
challenge (`POST /scan/recover`). The full protocol, every outcome and the recovery steps are in the
[payment reference](solidity-security-review/skills/solidity-security-review/reference/x402-payment.md).

## Limits (read this)

Automated pattern detection (Slither), **not an audit**. A clean result does not mean a contract is safe. Not covered:
- business logic;
- economic, oracle or MEV attacks;
- access-control intent;
- upgrade and admin-key risk;
- code not sent;
- deployment configuration.

Use professional audits and tests for anything holding value.

## Privacy

- Sources you send are scanned in a temporary directory that is deleted after each scan. The service does not store or
  log them.
- The usage log records route, status, client family and the `src` tag. It never records IP addresses or source code;
  IP addresses are held in memory only for rate limiting.
- The hosting providers (Render, Cloudflare) may keep their own standard request logs.

## Contents

- `.claude-plugin/marketplace.json`: Claude Code marketplace.
- `solidity-security-review/`: the plugin (`.claude-plugin/plugin.json`, `.mcp.json`,
  `skills/solidity-security-review/SKILL.md` + `reference/`).
- `gemini-extension.json` + `GEMINI.md`: Gemini CLI extension.
- `configs/`: MCP configs for each agent and an `AGENTS.md` snippet.
- `server.json`: the MCP Registry entry.
- `scripts/sync_context.py`: regenerates `GEMINI.md` and the snippet from SKILL.md.

No server code.

License: MIT (see LICENSE).
