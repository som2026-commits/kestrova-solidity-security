# Kestrova quickstart (5 minutes)

Kestrova runs [Slither](https://github.com/crytic/slither) static analysis on Solidity for you and your AI coding agent.
There is nothing to install for the analysis itself: no solc, no Python.

- **Free preview:** severity counts and the names of High/Medium detectors.
- **Optional full report:** every finding with file and line, **1 USDC per scan** via [x402](https://x402.org) on
  Solana, paid by your own wallet client, **only with your approval**.
- **Not an audit.** Zero findings does not mean a contract is safe.

## Option A: inside your AI coding agent (MCP)

| Agent | One step |
|---|---|
| Claude Code | `claude mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=claude"` |
| Cursor | Settings, then MCP, then add `{"mcpServers": {"kestrova": {"url": "https://kestrova.onrender.com/mcp?src=cursor"}}}` to `~/.cursor/mcp.json` |
| VS Code (Copilot agent mode) | `code --add-mcp '{"name":"kestrova","type":"http","url":"https://kestrova.onrender.com/mcp?src=vscode"}'` |

Then ask your agent:

> Write an ERC-4626 vault for USDC, then run the Kestrova preview on it and explain any High or Medium findings.

The agent calls `scan_solidity_preview` (free). It may offer `scan_solidity_full`; that costs 1 USDC and the skill
tells it never to pay without your explicit "yes".

## Option B: from the command line, in a Foundry or Hardhat project

```bash
# from a local copy of this repository (the npm package is not published yet)
node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs --dry-run   # see exactly what would be uploaded
node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs             # free preview
```

The tool:
- detects Foundry (`foundry.toml`, remappings, `lib/`) and Hardhat (`hardhat.config.*`, `node_modules`) projects;
- uploads **only your target `.sol` files and the files they import**, never `.env`, configs, tests or anything else;
- returns the same JSON format as the API (`--json`).

## Try it on the examples

```bash
cd examples/foundry-vault && node ../../cli/bin/kestrova-scan.mjs
# Kestrova preview (compiler 0.8.38): High: 1, Informational: 3, Optimization: 1
# High/Medium detectors: reentrancy-eth
```

Next: [docs/INTEGRATIONS.md](INTEGRATIONS.md) covers every client, Foundry, Hardhat, CI and the paid report.
