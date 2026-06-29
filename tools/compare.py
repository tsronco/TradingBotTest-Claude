#!/usr/bin/env python3
"""/compare — ad-hoc head-to-head between manual and live accounts.

Same comparison the 4:12 PM ET daily summary posts to Discord, but ad-hoc to
stdout instead of an embed. Useful for "who's winning right now?" checks
between scheduled summaries.

Usage:
    python tools/compare.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config
import daily_summary as ds


def _format_money(n: float) -> str:
    return f"${n:,.2f}"


def render() -> str:
    try:
        cons = ds._snapshot(config.MODES["manual"])
    except Exception as e:
        cons = {"error": f"{type(e).__name__}: {e}"}
    try:
        aggr = ds._snapshot(config.MODES["live"])
    except Exception as e:
        aggr = {"error": f"{type(e).__name__}: {e}"}

    out = [f"═══ HEAD-TO-HEAD ".ljust(60, "═")]

    if "error" in cons or "error" in aggr:
        if "error" in cons:
            out.append(f"  manual: {cons['error']}")
        if "error" in aggr:
            out.append(f"  live:   {aggr['error']}")
        return "\n".join(out)

    rows = [
        ("Equity",          _format_money(cons["equity"]),        _format_money(aggr["equity"])),
        ("Cash",            _format_money(cons["cash"]),          _format_money(aggr["cash"])),
        ("Portfolio val",   _format_money(cons["portfolio"]),     _format_money(aggr["portfolio"])),
        ("Premium today",   _format_money(cons["premium_today"]), _format_money(aggr["premium_today"])),
        ("Premium total",   _format_money(cons["premium_total"]), _format_money(aggr["premium_total"])),
        ("Wheel cycles",    str(cons["cycles"]),                  str(aggr["cycles"])),
        ("Long opts P&L",   _format_money(cons["long_pnl"]),      _format_money(aggr["long_pnl"])),
        ("Long opts open",  str(cons["long_count"]),              str(aggr["long_count"])),
        ("Wheel symbols",   str(len(cons["wheel_symbols"])),      str(len(aggr["wheel_symbols"]))),
    ]

    out.append(f"  {'Metric':<18} {'Conservative':>14}  {'Aggressive':>14}")
    out.append(f"  {'-'*18} {'-'*14}  {'-'*14}")
    for label, c, a in rows:
        out.append(f"  {label:<18} {c:>14}  {a:>14}")

    diff = aggr["equity"] - cons["equity"]
    if diff > 0:
        leader = f"Aggressive leads by {_format_money(abs(diff))}"
    elif diff < 0:
        leader = f"Conservative leads by {_format_money(abs(diff))}"
    else:
        leader = "Tied"
    out.append("")
    out.append(f"  → {leader}")

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    print(render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
