# kestrova-scan: Solidity security scanner for Foundry, Hardhat and AI coding agents

Free [Slither](https://github.com/crytic/slither) static analysis of your Solidity smart contracts from the command
line, with no local Python, solc or Slither install. Run it before a commit, in CI, or let your AI coding agent call it.
**Automated analysis, not an audit.**

```bash
npx kestrova-scan --dry-run     # see exactly which .sol files would be uploaded (no network)
npx kestrova-scan               # free preview of src/ (Foundry) or contracts/ (Hardhat)
```

Example output:

```
Kestrova preview (compiler 0.8.38): High: 1, Informational: 2
High/Medium detectors: reentrancy-eth
Automated static analysis; not an audit. Review every finding. Zero findings does NOT mean the contract is safe.
```

Node 18+, no dependencies.

## What it does

| Command | What you get |
|---|---|
| `kestrova-scan [File.sol ...]` | Free preview: severity counts and High/Medium detector names (reentrancy, tx.origin, unchecked calls, arbitrary sends and more) |
| `kestrova-scan --changed [main]` | Only the contracts you changed (plus their importers), labelled NEW / EXISTING / RESOLVED / UNKNOWN against the base branch |
| `kestrova-scan --staged` | Exactly what is staged for the next commit |
| `kestrova-scan --install-hook [--enforce]` | Optional git pre-commit hook (advisory by default). Skip once with `KESTROVA_SKIP=1` |
| `kestrova-scan --baseline` / `--compare` | Whole-project baseline, then show only new findings |
| `kestrova-scan --fail-on high` | Exit 1 on High findings (CI) |
| `kestrova-scan --to-sarif report.json --sarif-out kestrova.sarif` | Convert a full report to SARIF 2.1.0 for GitHub code scanning (offline) |
| `kestrova-scan --setup [claude\|cursor\|vscode\|codex\|gemini]` | Print how to connect Kestrova's MCP server to your coding agent (prints only) |
| `kestrova-scan --terms` | Current price of the optional full report (reads the public offer; never pays) |

Foundry `src`, `remappings.txt`, `foundry.toml` remappings and `lib/<name>/src` are understood. Hardhat
`node_modules` imports such as `@openzeppelin/contracts` are resolved. Tests and scripts are skipped unless you pass
`--include-tests`.

## AI coding agents (MCP)

Kestrova is also a remote MCP server (Streamable HTTP, no API key, no account) at `https://kestrova.onrender.com/mcp`.

```bash
claude mcp add --transport http kestrova "https://kestrova.onrender.com/mcp?src=claude"   # Claude Code
codex mcp add kestrova --url "https://kestrova.onrender.com/mcp?src=codex"                 # OpenAI Codex CLI
npx kestrova-scan --setup cursor                                                          # Cursor, VS Code, Gemini: prints the config
```

Tools: `scan_solidity_preview` (free), `payment_terms` (free), `scan_solidity_full` (paid; only with the user's
approval).

**Claude Code plugin** (skill + MCP), bundled in this package:

```bash
npm install -g kestrova-scan
claude plugin marketplace add "$(npm root -g)/kestrova-scan"
claude plugin install solidity-security-review@kestrova
```

## GitHub Actions

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0, persist-credentials: false }
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- name: Kestrova (free preview of changed contracts)
  run: |
    set +e
    npx --yes kestrova-scan@0.1.2 --changed "origin/${{ github.base_ref }}" --yes --summary-md "$GITHUB_STEP_SUMMARY"
    code=$?
    if [ "$code" = 3 ]; then echo "::warning::Kestrova unavailable or rate-limited; not blocking"; exit 0; fi
    exit $code
```

Trigger it on `pull_request` (not `pull_request_target`). The free preview
is rate-limited per IP, so exit code 3 is a warning, not a failure. Add `--fail-on high` to block on NEW High findings.

## Free preview vs. paid full report

| | Free preview | Full report (optional) |
|---|---|---|
| Price | Free, rate-limited | 1.00 USDC per scan via x402 on Solana, charged only if the scan succeeds |
| Output | Severity counts, High/Medium detector names | Every finding: detector, severity, confidence, file and line numbers |
| How | This CLI, MCP or `POST /preview` | Your own x402 wallet client or agent, with your explicit approval |

This CLI contains **no payment code** and never pays. `kestrova-scan File.sol --bundle vault.json` writes exactly the
sources a paid scan would analyse. If a payment's outcome is ever unclear, don't pay again: recover the report free
with a wallet signature at `POST /scan/recover`.

## Privacy

- **Uploaded:** only `.sol` files, and only your targets plus the files they import.
- **Refused:** files outside the project (including via symlinks) and files that look like they contain secrets.
- **Never read:** `.env`, keys, configs other than remappings, and build output.
- The first upload from a project lists the files and asks once (`.kestrova/consent.json`). Pass `--yes` in CI.
- Identical sources are answered from a local cache for 7 days. **No telemetry.**

## Limits

Slither detects known code patterns. It does not evaluate business logic, economic or oracle attacks, or whether
access control matches your intent. Findings can be false positives. For contracts that will hold real value, get a
professional audit.

**Exit codes:** `0` ok · `1` `--fail-on` threshold reached · `2` usage or collection problem (nothing sent) ·
`3` service unreachable or rate-limited (nothing charged).

Support: kestrova.security@gmail.com · Service: https://kestrova.onrender.com · License: MIT
