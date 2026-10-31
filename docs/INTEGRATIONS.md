# Kestrova integrations: AI coding agents, Foundry, Hardhat, CI

Kestrova is an independent service. The setups below use each tool's **standard, public** extension points (MCP
configuration, npm scripts, a Hardhat task). They are **not official integrations** of Anthropic, Cursor, Microsoft,
Foundry/Paradigm, Nomic Foundation or Trail of Bits.

**Service:** `https://kestrova.onrender.com`. MCP (Streamable HTTP, no auth): `https://kestrova.onrender.com/mcp`.
The `?src=` tag in the URLs below only attributes installs in Kestrova's aggregate usage log, with no personal data.

| Tool | Cost | What it returns |
|---|---|---|
| `scan_solidity_preview` / `POST /preview` | Free (60 kB, rate-limited per IP) | Severity counts and High/Medium detector names |
| `scan_solidity_full` / `POST /scan` | **1.00 USDC** via x402 `exact` on Solana mainnet, charged only after a successful scan | Every finding: detector, severity, confidence, file and lines |
| `payment_terms` | Free | Price, recipient, network and how to pay |

**Payment rule for every setup below:** nothing here pays automatically. The paid report needs your own x402-capable
wallet client and your explicit approval each time.

---

## 1. Claude Code

```bash
# user scope (all projects)
claude mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=claude"
claude mcp list            # expect: kestrova: https://kestrova.onrender.com/mcp?src=claude (HTTP) - √ Connected
```

Project scope (commit it so your team gets it): copy [`configs/claude-mcp.json`](../configs/claude-mcp.json) to
`.mcp.json` in the repository root. Claude Code asks each developer to approve it once.

Skill and MCP in one step:
`/plugin marketplace add som2026-commits/kestrova-solidity-security`, then
`/plugin install solidity-security-review@kestrova`. If the code host is unreachable, save
`https://kestrova.onrender.com/skill` as `.claude/skills/solidity-security-review/SKILL.md`. That route is prepared
and goes live with the next service update.

**Example workflow:**
> Add a `withdrawAll` function to src/Vault.sol, then run the Kestrova preview on src/Vault.sol and the files it
> imports. If there is a High finding, fix it and re-run the preview. Do not run the paid scan.

**Tip:** for multi-file projects, give the agent a bundle that already contains every imported file:
`kestrova-scan src/Vault.sol --bundle /tmp/vault.json`, then "use the sources in /tmp/vault.json".

## 2. Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project), from
[`configs/cursor-mcp.json`](../configs/cursor-mcp.json):

```json
{ "mcpServers": { "kestrova": { "url": "https://kestrova.onrender.com/mcp?src=cursor" } } }
```

One-click install link (Cursor's MCP deeplink; the config is base64 of the JSON above):
`cursor://anysphere.cursor-deeplink/mcp/install?name=kestrova&config=eyJ1cmwiOiJodHRwczovL2tlc3Ryb3ZhLm9ucmVuZGVyLmNvbS9tY3A/c3JjPWN1cnNvciJ9`

Optional project rule (`.cursor/rules/solidity-security.mdc`) so the agent checks contracts on its own:

```
---
description: Solidity security check
globs: ["**/*.sol"]
---
After a meaningful batch of Solidity changes (state, value transfers, external calls, access control, upgrades,
signatures, assembly), suggest ONE Kestrova check; do not repeat it while the contracts are unchanged. If a terminal is
available, run `kestrova-scan --changed` (or `--staged` before committing) and report NEW / RESOLVED / UNKNOWN items;
otherwise call the kestrova MCP tool scan_solidity_preview with the changed contract and every file it imports.
Never call scan_solidity_full (paid, 1 USDC) unless the user explicitly approves that specific payment.
This is automated analysis, not an audit.
```

## 3. VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`, from [`configs/vscode-mcp.json`](../configs/vscode-mcp.json):

```json
{ "servers": { "kestrova": { "type": "http", "url": "https://kestrova.onrender.com/mcp?src=vscode" } } }
```

Or from a terminal:
`code --add-mcp '{"name":"kestrova","type":"http","url":"https://kestrova.onrender.com/mcp?src=vscode"}'`

Install link (VS Code's `vscode:mcp/install` handler; check that your VS Code version supports it):
`vscode:mcp/install?%7B%22name%22%3A%22kestrova%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fkestrova.onrender.com%2Fmcp%3Fsrc%3Dvscode%22%7D`

Add the same instruction as the Cursor rule to `.github/copilot-instructions.md`
(see [`configs/AGENTS.snippet.md`](../configs/AGENTS.snippet.md)).

## 4. Check any MCP setup (without paying)

```bash
pip install mcp
python3 integrations/mcp/check_mcp.py --config configs/cursor-mcp.json             # discovery, terms, paid boundary
python3 integrations/mcp/check_mcp.py --config configs/vscode-mcp.json --preview   # + one free preview
```

It checks:
- that the 3 tools are discovered;
- that the free tool is read-only;
- the payment terms;
- that `scan_solidity_full` **without** a payment returns "Payment Required" and does **not** scan;
- with `--preview`, that a planted reentrancy bug is detected.

It never attaches a payment.

---

## 5. Foundry

Foundry has no plugin system, so the integration is a CLI that understands Foundry projects:
- reads `src` and `remappings` from `foundry.toml`;
- reads `remappings.txt`;
- applies forge's automatic `lib/<name>/src/` remappings.

```bash
cd my-foundry-project
node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs --dry-run      # what would be uploaded
node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs                # free preview of src/
node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs src/Vault.sol  # one contract + its imports
```

The tool:
- skips `test/`, `script/`, `*.t.sol` and `*.s.sol` by default (`--include-tests` to include them);
- uploads only imported library files, for example the 3 files of `lib/openzeppelin-contracts` you actually use, never
  the whole `lib/`.

Optional `Makefile` target:

```make
kestrova:  ## free Kestrova preview of src/ (fails on High findings)
	node $(KESTROVA)/cli/bin/kestrova-scan.mjs --fail-on high
```

## 6. Hardhat

```jsonc
// package.json
"scripts": {
  "kestrova": "kestrova-scan contracts",
  "kestrova:ci": "kestrova-scan contracts --fail-on high"
}
```

Until `kestrova-scan` is published to npm, use
`"kestrova": "node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs contracts"`.

Imports from `node_modules` (such as `@openzeppelin/contracts`) are resolved, and only the imported files are uploaded,
renamed to service-safe paths (`node_modules/_openzeppelin/...`) without changing any line numbers.

**Hardhat 2** can also run it as a task. Copy
[`integrations/hardhat/kestrova-task.cjs`](../integrations/hardhat/kestrova-task.cjs) into the project and add
`require("./kestrova-task.cjs");` to `hardhat.config.js`:

```bash
npx hardhat kestrova --dry-run
npx hardhat kestrova --fail-on high contracts/Token.sol
```

This was tested with Hardhat 2.29.1. On Hardhat 3, use the npm script.

## 7. CI (GitHub Actions example)

Daily commands (`--changed`, `--staged`, `--baseline`, `--compare`, pre-commit hook): see [DAILY_WORKFLOW.md](DAILY_WORKFLOW.md).


See [`examples/ci/kestrova.yml`](../examples/ci/kestrova.yml). It previews the PR's changed contracts against the
target branch, writes a summary table, and is advisory unless `KESTROVA_FAIL_ON` is set. The free preview is rate-limited
per IP and CI runners share IPs, so exit code 3 (service or rate limit) never fails the check.

**Exit codes:**
- `0`: ok;
- `1`: findings at or above `--fail-on`;
- `2`: usage, collection or size-limit problem (nothing was sent);
- `3`: service unreachable or rate-limited (nothing was charged).

## 8. The paid full report (optional, 1 USDC, your approval)

```bash
kestrova-scan src/Vault.sol --bundle vault.json      # exactly the sources that would be analysed
kestrova-scan --terms                                # current price/recipient (reads the 402 offer, never pays)
```

Send `vault.json` to `POST /scan` with an x402 v2 client and your own wallet (see
[`examples/python/pay_scan.py`](../examples/python/pay_scan.py), which defaults to a dry run), or let your agent call
`scan_solidity_full` after you approve. You are charged only if the scan succeeds. If a payment's outcome is unclear,
**do not pay again**: recover the report for free at `POST /scan/recover`.

## Privacy: what leaves your machine

**Uploaded:** only `.sol` files, and only the targets plus the files they import.

**Refused:** every file must sit inside the project (symlinks that escape it are refused), and a file that looks like
it contains a secret (`PRIVATE_KEY=…`, a PEM key, a mnemonic) is not uploaded unless you pass
`--allow-secret-pattern`. `--dry-run` shows the exact list first.

**Never read:** `.env`, `foundry.toml` values other than `src`/`libs`/`remappings`, `hardhat.config.*` contents,
artifacts, broadcasts and keys.
