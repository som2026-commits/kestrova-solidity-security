# Accuracy: Kestrova on the SmartBugs-curated benchmark

Kestrova runs [Slither](https://github.com/crytic/slither). To show what that does and does not catch, we ran the
**production scanner** (same compilers, detectors and limits) on the public
[SmartBugs-curated](https://github.com/smartbugs/smartbugs-curated) dataset: 143 contracts with
line-labelled vulnerabilities in 10 categories. Run on 2026-11-01; reproducible with
`product/benchmarks/smartbugs_curated.py`.

**Results:**
- **136/143 contracts compiled** with the available compilers (0.4.26, 0.5.17, 0.6.12, 0.7.6, 0.8.0, 0.8.20, 0.8.24, 0.8.38).
  The others need an exact compiler version that isn't installed. They are reported as not compiled, never as clean.
- A labelled vulnerability counts as **detected** when a finding's location covers the labelled line (±2 lines).

| Category | Labelled | Not compiled | Detected (any severity) | Detected (High/Medium only) |
|---|---|---|---|---|
| access_control | 24 | 2 | 18/22 (82%) | 12/22 (55%) |
| arithmetic | 23 | 1 | 5/22 (23%) | 3/22 (14%) |
| bad_randomness | 34 | 0 | 33/34 (97%) | 26/34 (76%) |
| denial_of_service | 14 | 1 | 11/13 (85%) | 5/13 (38%) |
| front_running | 7 | 0 | 7/7 (100%) | 1/7 (14%) |
| other | 5 | 0 | 5/5 (100%) | 5/5 (100%) |
| reentrancy | 32 | 2 | 30/30 (100%) | 30/30 (100%) |
| short_addresses | 1 | 0 | 0/1 (0%) | 0/1 (0%) |
| time_manipulation | 7 | 0 | 7/7 (100%) | 6/7 (86%) |
| unchecked_low_level_calls | 75 | 5 | 69/70 (99%) | 69/70 (99%) |
| **total** | 222 | 11 | 185/211 (88%) | 157/211 (74%) |

**Reading this honestly:**
- **Strong:**
  - reentrancy;
  - unchecked low-level calls;
  - weak randomness;
  - timestamp dependence;
  - many access-control issues.
- **Weak:**
  - arithmetic overflow in old Solidity (Slither has no general overflow detector; Solidity ≥0.8 checks arithmetic
    itself);
  - front-running (mostly flagged only at Low/Informational);
  - short-address attacks (not detected).
- **Unlabelled findings:** 137 High/Medium findings fell on lines SmartBugs did not
  label. The labels aren't exhaustive, so these are a noise indicator, not a false-positive rate.
- **Caveats:**
  - SmartBugs-curated is small, old (mostly Solidity 0.4.x) and well known. Results on modern production code will
    differ.
  - Static analysis can't find business-logic, economic or oracle-manipulation bugs.
  - **Not an audit.** Zero findings does not mean a contract is safe.
