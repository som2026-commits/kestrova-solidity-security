# Examples

| File | What it does | Cost |
|---|---|---|
| [`preview.sh`](preview.sh) | Free Slither preview of a Solidity file over HTTPS (`POST /preview`) | free |
| [`python/pay_scan.py`](python/pay_scan.py) | Full report over x402 with the official Python SDK: dry run, `--pay` (one pinned 1 USDC payment), `--recover` | 1.00 USDC per scan |

**Before paying, read:**
- **Wallet:** use a dedicated low-balance signer holding 1.00 USDC and no SOL; the facilitator pays the network fee.
- **Never pay twice:** after any unclear result (timeout, `202`/`409 pending`), run `--recover`. Recovery is free and never a payment.
- **Not an audit:** this is automated pattern detection. A clean result does not mean a contract is safe.
