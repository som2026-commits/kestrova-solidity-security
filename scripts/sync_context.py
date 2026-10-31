"""Regenerate GEMINI.md and configs/AGENTS.snippet.md from the skill (single source of truth).

    python scripts/sync_context.py          # write
    python scripts/sync_context.py --check  # exit 1 if out of date (CI / tests)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "solidity-security-review" / "skills" / "solidity-security-review" / "SKILL.md"
NOTE = "<!-- Generated from solidity-security-review/skills/solidity-security-review/SKILL.md by scripts/sync_context.py. Do not edit. -->\n"


def body() -> str:
    text = SKILL.read_text()
    assert text.startswith("---\n")
    text = text.split("---\n", 2)[2].lstrip()
    # Links relative to the skill folder -> absolute GitHub links, so they work wherever the text is pasted.
    base = "https://github.com/som2026-commits/kestrova-solidity-security/blob/main/"
    return (text.replace("](reference/x402-payment.md)",
                         f"]({base}solidity-security-review/skills/solidity-security-review/reference/x402-payment.md)")
                .replace("](../../README.md)", f"]({base}README.md)"))


def outputs() -> dict:
    b = body()
    return {ROOT / "GEMINI.md": NOTE + b,
            ROOT / "configs" / "AGENTS.snippet.md": NOTE + "<!-- Paste into your project's AGENTS.md (Codex, Cursor, "
            "Copilot, Gemini and other agents read it). -->\n\n" + b.replace("# Solidity Security Review (Kestrova)",
                                                                           "## Solidity security review (Kestrova)", 1)}


if __name__ == "__main__":
    stale = [p for p, c in outputs().items() if not p.exists() or p.read_text() != c]
    if "--check" in sys.argv:
        print("\n".join(f"stale: {p.relative_to(ROOT)}" for p in stale) or "up to date")
        sys.exit(1 if stale else 0)
    for p, c in outputs().items():
        p.write_text(c)
        print("wrote", p.relative_to(ROOT))
