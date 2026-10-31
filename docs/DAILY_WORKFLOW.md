# Daily security workflow with Kestrova

The daily commands below give you a quick, free **automated Slither check of what you changed**, compared with the code
before your change. They are not an audit, and they don't replace a full review of the whole codebase.

**Commands** (`node /path/to/kestrova-solidity-security/cli/bin/kestrova-scan.mjs` until the npm package is published):

| When | Command | What it does |
|---|---|---|
| While working | `kestrova-scan --changed` | Previews the contracts you changed since `main` (merge-base), plus every contract that imports them. Compares them with the same files on `main` |
| Before committing | `kestrova-scan --staged` | The same, for **exactly what is staged**; unstaged edits are ignored and flagged |
| Once, then weekly | `kestrova-scan --baseline` | Saves a whole-project preview to `.kestrova/baseline.json` |
| Any time | `kestrova-scan --compare` | Whole-project preview compared with the saved baseline |
| Automatically | `kestrova-scan --install-hook` | Optional pre-commit hook. Advisory: it reports and never blocks |
| Before uploading anything | add `--dry-run` | Lists exactly which files would be sent, then stops |

This works unchanged in **Foundry** (`foundry.toml`, `src/`, `lib/`, remappings) and **Hardhat** (`contracts/`,
`node_modules`, including hoisted workspace `node_modules`) projects. No configuration files are needed.

## Reading the result

```
Kestrova changed-file check
Base: main @ 3f2a9c1e0b7d (merge-base of main and HEAD); comparing the working tree
Changed .sol: M src/Vault.sol
Also analyzed (import a changed file): src/Router.sol
  NEW      High    reentrancy-eth
  EXISTING Medium  tx-origin
  RESOLVED High    arbitrary-send-eth
Counts (baseline -> current): High 1->1, Medium 1->1, ...
```

| Status | Meaning |
|---|---|
| **NEW** | A High/Medium detector that appears now and did not before, **or** a severity count that went up. A count increase means an extra instance of a detector that already existed; the free preview can't name it, so it's shown as `+1 High finding(s)` |
| **EXISTING** | The detector is present before and after. The free preview can't tell whether it's the same instance |
| **RESOLVED** | The detector disappeared, and the **same scope was analyzed successfully on both sides**, or the code was deleted |
| **UNKNOWN** | Not determinable: a scan failed, files were outside the scope, there was no comparable baseline, or the limits were exceeded. It is **never** reported as fixed |

**Why both sides are scanned:** a change can introduce a problem in a contract you didn't edit, for example by
changing a base contract. So `--changed` also analyzes every target contract that imports a changed file. It previews
the **same files** at the base commit, so "new" means new.

**Limits of the free preview:**
- It returns severity counts and the **names** of High/Medium detectors, not locations, and not per-detector counts.
- Exact file/line findings need the optional full report: 1 USDC via x402, paid by your own wallet, only with your
  approval.
- If you have two full reports, `kestrova-scan --compare-reports old.json new.json` compares them **per finding**
  offline. It uses fingerprints that survive line moves and renames.

## Pre-commit hook (optional)

```bash
kestrova-scan --install-hook                                 # advisory (default): reports NEW High+, never blocks
kestrova-scan --install-hook --enforce --fail-on high        # blocks commits that add NEW High findings
KESTROVA_SKIP=1 git commit -m "hotfix"                       # emergency bypass for one commit (or: git commit --no-verify)
kestrova-scan --uninstall-hook                               # removes only Kestrova's hook
```

**What the hook does:**
- It scans the **staged** content of changed `.sol` files, which is exactly what will be committed.
- It says when a file is only partially staged.
- It does nothing (no network) when no Solidity is staged.

**What the hook will never do:**
- Change files or history.
- Overwrite a hook it didn't install.
- Write into a tracked hooks folder such as `.husky/`. In that case it prints the line to add yourself.
- Block a commit because the service is unavailable or rate-limited. Only an `--enforce` hook blocks, and only on NEW
  findings at or above your threshold.

**First use:** run `kestrova-scan --staged` once in a terminal and approve the upload when asked. The hook never
uploads without that approval.

## Pull requests (GitHub Actions)

Copy [`examples/ci/kestrova.yml`](../examples/ci/kestrova.yml). It previews the PR's changed contracts against the
target branch and writes a Markdown table to the job summary. It's **advisory** unless you set
`KESTROVA_FAIL_ON: high`.

Its security model:
- It treats PR code as untrusted: it's only read, no project scripts run, and dependencies install with
  `--ignore-scripts`.
- The CLI comes from a pinned copy of this repository, never from the PR.
- The token is read-only and no secrets are used.

## AI coding agents (Claude Code, Cursor, VS Code)

The skill, `AGENTS.md` snippet and Cursor rule tell agents to:
- suggest **one** check per meaningful Solidity change set: state, value transfers, external calls, access control,
  upgrades, signatures or assembly;
- not re-scan unchanged code;
- use `kestrova-scan --changed` when a shell is available (it's cached and compares with the base), otherwise the free
  MCP preview;
- **never** run the paid scan without the user's explicit approval for that specific payment.

## Privacy

**Uploaded:** only `.sol` files, and only the changed/affected contracts and the files they import.
`--dry-run` shows the exact list.

**Never uploaded:** `.env`, keys, configs, tests (by default) and anything outside the project.
`node_modules` dependency files are the only exception to "inside the project", and only `.sol` files reached through
imports.

**Approval and local state:**
- The **first** upload from a project needs your approval. It's remembered in `.kestrova/consent.json`; in CI, pass
  `--yes`.
- `.kestrova/` is local only and ignores itself in git: it holds consent, a cache of results and the baseline.
- There is **no telemetry**.

## How much of the free quota this uses

The free preview allows **6 requests per hour per IP**.

| Action | Requests |
|---|---|
| `--changed` / `--staged` | Up to 2 (current and base). Identical sources are answered from the local cache for 7 days, so committing what you just checked costs 0 |
| `--baseline` or `--compare` | 1 |
| CI run | Up to 2 per push; the CI cache isn't persisted, and runners share IPs, so rate limits are possible and never fail the check |
| No Solidity change | 0 |

A typical day of about 5 checked commits uses about 5–10 requests, spread over the day.
