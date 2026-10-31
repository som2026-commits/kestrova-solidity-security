"""Buy one Kestrova full Solidity scan over x402 (1 USDC on Solana mainnet) with the official x402 Python SDK.

    pip install "x402[svm,httpx]==2.25.0" httpx
    python pay_scan.py Vault.sol                       # DRY RUN: fetch and check the payment terms; nothing is signed
    KESTROVA_SIGNER_KEY_FILE=signer.json python pay_scan.py Vault.sol --pay        # sign ONE payment, get the report
    KESTROVA_SIGNER_KEY_FILE=signer.json python pay_scan.py --recover              # re-download it later (free)

Safety rules built in (keep them if you adapt this):
- Pinned terms: exactly 1000000 base units of USDC to the Kestrova recipient on Solana mainnet, or nothing is signed.
- Atomic SDK spend cap of 1000000 and a policy that accepts only USDC to that recipient.
- The signed payment is saved to kestrova-payment.json BEFORE it is sent, and a second payment is refused while that
  file exists. After an unclear result (timeout, 202/409 pending) never pay again: run --recover.
- The signer needs 1.00 USDC and no SOL (the facilitator pays the network fee). Use a dedicated low-balance key file
  (solana-keygen JSON). The key is never printed or sent anywhere.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import httpx

BASE_URL = os.environ.get("KESTROVA_URL", "https://kestrova.onrender.com").rstrip("/")
NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
PAY_TO = "CWJdBXpfaARqqWA6XrDXsVGVcZMM8rMcQbSfLqFwNeqc"
AMOUNT = "1000000"                                    # 1.00 USDC (6 decimals)
STATE = Path(os.environ.get("KESTROVA_STATE_FILE", "kestrova-payment.json"))


def pinned(required: dict) -> dict:
    """The one acceptable requirement, or refuse."""
    if required.get("x402Version") != 2:
        raise SystemExit("refused: unexpected x402 version")
    for acc in required.get("accepts", []):
        if (acc.get("scheme") == "exact" and acc.get("network") == NETWORK and acc.get("asset") == USDC
                and acc.get("payTo") == PAY_TO and str(acc.get("amount")) == AMOUNT):
            return {**required, "accepts": [acc]}
    raise SystemExit("refused: terms are not exactly 1.00 USDC to Kestrova on Solana mainnet")


def sources(paths: list[str]) -> dict:
    files = [p for a in paths for p in (sorted(Path(a).rglob("*.sol")) if Path(a).is_dir() else [Path(a)])]
    if not files:
        raise SystemExit("give one or more .sol files or a directory")
    return {str(f): f.read_text(encoding="utf-8") for f in files}


def load_keypair(path: str):
    from solders.keypair import Keypair
    return Keypair.from_bytes(bytes(json.loads(Path(path).read_text())))


async def terms(http: httpx.AsyncClient, src: dict) -> dict:
    r = await http.post("/scan", json={"sources": src})
    if r.status_code != 402 or "payment-required" not in r.headers:
        raise SystemExit(f"expected HTTP 402 with payment terms, got {r.status_code}: {r.text[:200]}")
    return pinned(json.loads(base64.b64decode(r.headers["payment-required"])))


async def pay(http: httpx.AsyncClient, src: dict, key_file: str, rpc_url: str | None = None) -> int:
    from x402 import x402Client
    from x402.http.utils import decode_payment_required_header, encode_payment_signature_header
    from x402.mechanisms.svm.exact.register import register_exact_svm_client
    from x402.mechanisms.svm.signers import KeypairSigner

    if STATE.exists():
        raise SystemExit(f"refused: {STATE} exists, a payment was already signed. Run --recover; never pay twice")
    required = await terms(http, src)
    kp = load_keypair(key_file)
    client = x402Client().set_spend_controls({
        "allowed_assets": [{"network": NETWORK, "asset": USDC, "max_amount_per_payment": AMOUNT}],
        "max_amount_per_payment": "$1.00"})
    register_exact_svm_client(client, KeypairSigner(kp), networks=NETWORK, rpc_url=rpc_url,
                              policies=[lambda v, reqs: [r for r in reqs if getattr(r, "asset", None) == USDC
                                                         and getattr(r, "pay_to", None) == PAY_TO]])
    raw = base64.b64encode(json.dumps(required).encode()).decode()
    payload = await client.create_payment_payload(decode_payment_required_header(raw))
    header = encode_payment_signature_header(payload)
    fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)      # saved BEFORE sending
    with os.fdopen(fd, "w") as f:
        json.dump({"payment": header, "wallet": str(kp.pubkey()), "sources": src}, f)
    r = await http.post("/scan", json={"sources": src}, headers={"PAYMENT-SIGNATURE": header})
    if r.status_code == 200 and "payment-response" in r.headers:
        receipt = json.loads(base64.b64decode(r.headers["payment-response"]))
        print(json.dumps({"paid": True, "transaction": receipt.get("transaction"), "report": r.json()}, indent=1))
        return 0
    print(f"HTTP {r.status_code}: {r.text[:400]}", file=sys.stderr)
    if r.status_code in (202, 409) or r.status_code >= 500:
        print("Outcome unclear. Do NOT pay again: run with --recover.", file=sys.stderr)
    return 1


async def recover(http: httpx.AsyncClient, key_file: str) -> int:
    """Free: prove you are the wallet that signed the payment and get the original report back."""
    if not STATE.exists():
        raise SystemExit(f"{STATE} not found: nothing was signed")
    s = json.loads(STATE.read_text())
    kp = load_keypair(key_file)
    if str(kp.pubkey()) != s["wallet"]:
        raise SystemExit("refused: this key did not sign the saved payment")
    r = await http.post("/scan/recover", json={"payment": s["payment"], "wallet": s["wallet"], "action": "challenge"})
    if r.status_code != 200:
        print(f"HTTP {r.status_code}: {r.text[:300]}", file=sys.stderr)
        return 1
    ch = r.json()
    if not ch.get("message", "").startswith("Kestrova x402 report recovery"):
        raise SystemExit("refused: unexpected challenge text")
    sig = base64.b64encode(bytes(kp.sign_message(ch["message"].encode()))).decode()   # message signature, not a tx
    r = await http.post("/scan/recover", json={"payment": s["payment"], "wallet": s["wallet"], "message": ch["message"],
                                               "token": ch["token"], "expires": ch["expires"], "signature": sig})
    if r.status_code == 200:
        print(json.dumps({"recovered": True, "report": r.json()}, indent=1))
        return 0
    print(f"HTTP {r.status_code}: {r.text[:300]}" + (" (not settled yet; retry recovery later, never pay again)"
                                                      if r.status_code == 202 else ""), file=sys.stderr)
    return 1


async def main(argv=None, transport: httpx.AsyncBaseTransport | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("paths", nargs="*", help=".sol files or directories")
    ap.add_argument("--pay", action="store_true", help="sign and send ONE 1.00 USDC payment")
    ap.add_argument("--recover", action="store_true", help="re-download a report you already paid for (free)")
    a = ap.parse_args(argv)
    key_file = os.environ.get("KESTROVA_SIGNER_KEY_FILE", "")
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=180, transport=transport) as http:
        if a.recover:
            return await recover(http, key_file)
        src = sources(a.paths)
        if not a.pay:
            acc = (await terms(http, src))["accepts"][0]
            print(f"DRY RUN, nothing signed. Terms OK: {int(acc['amount']) / 1e6:.2f} USDC to {acc['payTo']} on "
                  f"{acc['network']}, fee payer {acc.get('extra', {}).get('feePayer')}. Add --pay to buy.")
            return 0
        if not key_file:
            raise SystemExit("set KESTROVA_SIGNER_KEY_FILE to a dedicated low-balance signer key file")
        return await pay(http, src, key_file, os.environ.get("SOLANA_RPC_URL"))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
