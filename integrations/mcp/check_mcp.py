#!/usr/bin/env python3
"""Check a Kestrova MCP setup end to end, exactly as an IDE would connect, WITHOUT ever paying.

    python3 integrations/mcp/check_mcp.py --config configs/cursor-mcp.json            # tools + terms (no scan)
    python3 integrations/mcp/check_mcp.py --config configs/vscode-mcp.json --preview  # + one free preview
    python3 integrations/mcp/check_mcp.py --url http://127.0.0.1:8000/mcp --preview --errors

Reads the server URL from a Claude Code / Cursor / VS Code config file, connects over Streamable HTTP, and checks:
  - tool discovery: the 3 tools, their read-only/paid annotations and input schema
  - payment_terms: 1.00 USDC, x402 exact (informational; never acted on)
  - paid boundary: scan_solidity_full WITHOUT a payment returns the payment terms and does not scan or charge
  - --preview: one free scan_solidity_preview of a small vulnerable contract (counts against the free rate limit)
  - --errors: invalid file name / bad source are reported as tool errors, not crashes
It never attaches `_meta["x402/payment"]` to any call. Requires: pip install mcp
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

VULN = ("// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Vault {\n"
        "  mapping(address => uint256) public bal;\n  function deposit() external payable { bal[msg.sender] += msg.value; }\n"
        "  function withdraw() external {\n    uint256 a = bal[msg.sender];\n"
        "    (bool ok,) = msg.sender.call{value: a}(\"\");\n    require(ok);\n    bal[msg.sender] = 0;\n  }\n}\n")


def url_from_config(path: str) -> tuple[str, str]:
    cfg = json.load(open(path))
    if "mcpServers" in cfg:                       # Claude Code (.mcp.json) and Cursor (mcp.json)
        entry, client = cfg["mcpServers"]["kestrova"], "claude/cursor"
        if "type" in entry and entry["type"] != "http":
            raise SystemExit(f"{path}: Claude Code entries need type 'http'")
    elif "servers" in cfg:                        # VS Code (.vscode/mcp.json)
        entry, client = cfg["servers"]["kestrova"], "vscode"
        if entry.get("type") != "http":
            raise SystemExit(f"{path}: VS Code entries need type 'http'")
    else:
        raise SystemExit(f"{path}: no mcpServers/servers block")
    return entry["url"], client


def text_of(result) -> str:
    return "\n".join(getattr(c, "text", "") for c in result.content)


async def run(url: str, preview: bool, errors: bool) -> list[tuple[str, bool, str]]:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    checks: list[tuple[str, bool, str]] = []
    ok = lambda name, cond, info="": checks.append((name, bool(cond), info))  # noqa: E731
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as s:
            init = await s.initialize()
            ok("initialize", init.serverInfo.name == "kestrova", f"server {init.serverInfo.name} {init.serverInfo.version}")
            tools = {t.name: t for t in (await s.list_tools()).tools}
            ok("tool discovery", set(tools) == {"scan_solidity_preview", "scan_solidity_full", "payment_terms"},
               ", ".join(sorted(tools)))
            pv, full = tools.get("scan_solidity_preview"), tools.get("scan_solidity_full")
            ok("preview is read-only and free", pv and pv.annotations.readOnlyHint and "FREE" in pv.description.upper())
            ok("full scan is marked paid", full and "PAID" in full.description and full.annotations.readOnlyHint is False)
            ok("input schema requires sources", pv and "sources" in pv.inputSchema.get("required", []))
            terms = json.loads(text_of(await s.call_tool("payment_terms", {})))
            ok("payment terms", terms.get("amount_base_units") == 1_000_000 and "x402" in terms.get("protocol", ""),
               f"{terms.get('price')} {terms.get('asset')} on {terms.get('network')}")
            r = await s.call_tool("scan_solidity_full", {"sources": {"Vault.sol": VULN}})   # NO payment attached
            try:
                offer = json.loads(text_of(r))
            except ValueError:
                offer = {}
            accepts = offer.get("accepts") or []
            ok("paid boundary: no payment -> terms, no scan",
               r.isError and offer.get("error") == "Payment Required" and accepts
               and not ({"counts", "findings", "compiler"} & set(offer))
               and all(a.get("amount") == "1000000" for a in accepts),
               "Payment Required, " + ", ".join(f"{a.get('network', '?')[:14]} {a.get('amount')}" for a in accepts))
            if preview:
                r = await s.call_tool("scan_solidity_preview", {"sources": {"Vault.sol": VULN}})
                body = text_of(r)
                ok("free preview finds the planted bug", not r.isError and "reentrancy-eth" in body, body[:120])
            if errors:
                r = await s.call_tool("scan_solidity_preview", {"sources": {"../evil.sol": VULN}})
                ok("bad file name is a tool error", r.isError or "bad file name" in text_of(r), text_of(r)[:100])
                r = await s.call_tool("scan_solidity_preview", {"sources": {"Broken.sol": "pragma solidity ^0.8.20; contract {"}})
                ok("compile error is a tool error", r.isError or "fail" in text_of(r).lower(), text_of(r)[:100])
    return checks


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config")
    ap.add_argument("--url")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--errors", action="store_true")
    a = ap.parse_args(argv)
    if not (a.config or a.url):
        ap.error("--config or --url")
    url, client = (a.url, "url") if a.url else url_from_config(a.config)
    print(f"[{client}] {url}")
    checks = asyncio.run(run(url, a.preview, a.errors))
    for name, passed, info in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}{('  -  ' + info) if info else ''}")
    return 0 if all(p for _, p, _ in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
