#!/usr/bin/env python3
"""/screen [mode] — on-demand wheel-candidate screener.

Same logic as wheel_screener.py (which runs Sundays at 6 PM ET on cron) but
prints to stdout instead of posting a Discord embed. Use this when you don't
want to wait for the next cron fire.

Usage:
    python tools/screen.py                  # manual universe (curated)
    python tools/screen.py live             # live universe (default large-caps)
    python tools/screen.py --top 5          # show only top 5
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import wheel_screener


def render(mode: str, top_n: int) -> str:
    wheel_screener.apply_mode(mode)

    out = [f"═══ WHEEL SCREENER — {mode.upper()} ".ljust(70, "═")]
    out.append(f"  Universe: {len(wheel_screener.UNIVERSE)} symbols  "
               f"(excludes {len(wheel_screener.ALREADY_WHEELED)} already wheeled)")
    out.append(f"  DTE window: {wheel_screener.TARGET_DTE_MIN}-{wheel_screener.TARGET_DTE_MAX}d")
    out.append(f"  Strike target: {wheel_screener.PUT_STRIKE_DISCOUNT*100:.0f}% OTM")

    try:
        account = wheel_screener.get_account()
        free_bp = float(account.get("options_buying_power", 0))
    except Exception as e:
        return "\n".join(out) + f"\n  ERROR fetching account: {type(e).__name__}: {e}"

    out.append(f"  Free options BP: ${free_bp:,.0f}")
    out.append("")

    results = []
    for symbol in wheel_screener.UNIVERSE:
        try:
            r = wheel_screener.score_candidate(symbol, free_bp)
            if r:
                results.append(r)
        except Exception:
            continue

    results.sort(key=lambda r: r["score"], reverse=True)
    top = results[:top_n]

    if not top:
        out.append("  No candidates returned usable data.")
        return "\n".join(out)

    out.append(f"  Top {len(top)} candidates (sorted by composite score):")
    out.append("")
    for i, r in enumerate(top, 1):
        fit = "fits BP" if r["budget_fit"] else "OVER BP"
        out.append(
            f"  {i:>2}. {r['symbol']:<6} @ ${r['price']:>7.2f}  →  "
            f"${r['strike']:>5.0f}P {r['expiry']}  "
            f"prem ${r['mid']*100:>4.0f}  yield {r['premium_yield']*100:>4.2f}%  "
            f"spread {r['spread_pct']*100:>4.1f}%  {fit}"
        )
    out.append("")
    out.append("  ⚠ Earnings dates not checked — verify on yahoo finance / "
               "earningswhispers before selling.")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="On-demand wheel-candidate screener.")
    p.add_argument("mode", nargs="?", default="manual",
                   choices=["manual", "live"])
    p.add_argument("--top", type=int, default=10)
    args = p.parse_args(argv)

    print(render(args.mode, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
