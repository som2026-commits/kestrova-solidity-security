# kestrova-scan

Free Slither preview of a Foundry, Hardhat or plain Solidity project from the command line, using
[Kestrova](https://kestrova.onrender.com). It has no dependencies and needs Node 18+. **Not an audit.**

```bash
kestrova-scan --dry-run                 # list exactly which .sol files would be uploaded (no network)
kestrova-scan                           # free preview of src/ (Foundry) or contracts/ (Hardhat)
kestrova-scan src/Vault.sol --json      # one contract + its imports; raw service JSON
kestrova-scan --fail-on high            # CI: exit 1 on High findings
kestrova-scan src/Vault.sol --bundle vault.json   # sources for the optional paid report (1 USDC, your approval)
kestrova-scan --terms                   # current paid terms (reads the public 402 offer; never pays)
kestrova-scan --changed [main]          # only changed contracts (+ importers) vs the same files on main
kestrova-scan --staged                  # exactly what is staged for the next commit, vs HEAD
kestrova-scan --baseline | --compare    # whole-project baseline, then compare against it
kestrova-scan --install-hook [--enforce] | --uninstall-hook   # optional pre-commit hook (advisory by default)
kestrova-scan --to-sarif report.json --sarif-out kestrova.sarif   # offline: full/highlights/address-risk report -> SARIF 2.1.0
```

**Daily workflow:** [docs/DAILY_WORKFLOW.md](../docs/DAILY_WORKFLOW.md). It covers NEW / EXISTING / RESOLVED /
UNKNOWN, the hook, CI and the free-quota impact.

**First upload from a project:** shows the exact files and asks once; the approval is remembered in
`.kestrova/consent.json`. Pass `--yes` in CI. Identical sources are answered from a local cache. No telemetry.

**Not published to npm yet:** run `node cli/bin/kestrova-scan.mjs` from this repository.

**Privacy:**
- **Uploaded:** only `.sol` files, and only your targets plus the files they import. Remapped and `node_modules`
  imports are resolved.
- **Refused:** files outside the project (including via symlinks) and files that look like they contain secrets.
  The one exception is imported `.sol` files inside a `node_modules` folder of the project or a parent folder
  (hoisted workspaces).
- **Never read:** `.env`, keys, configs other than the remappings, and build output.
- Uploaded copies only have their import paths rewritten to service-safe names, in place, so finding line numbers
  match your files.

**Payments:** this tool contains no payment code. The full line-level report is optional. It costs 1 USDC via x402 on
Solana, paid by your own wallet client and only with your explicit approval.

**Exit codes:**
- `0`: ok;
- `1`: findings at or above `--fail-on`;
- `2`: usage, collection or limit problem (nothing sent);
- `3`: service unreachable or rate-limited (nothing charged).

**Tests:** `node --test test/*.test.mjs` (offline: a local stand-in server, no real service calls).
