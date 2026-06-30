#!/usr/bin/env python3
"""Ad-hoc side-by-side glance at the manual (paper) and live (real money) accounts.

Same numbers as the 4:12 PM ET daily summary, but on demand to stdout.
Note: manual ($10k paper) and live (real money, separate capital) are NOT a
race — the two columns exist for a quick sanity check, not to crown a winner.

Usage:
    python tools/compare.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config
import daily_summary as ds


def _format_money(n: float) -> str:
    return f"${n:,.2f}"


def _snapshot(cfg: dict) -> dict:
    """Build a comparable snapshot dict from the surviving daily_summary helpers."""
    account = ds._get_account(cfg)
    wheel   = ds._summarize_wheel(cfg)
    _spread_legs = {
        sp["long_occ"]
        for sp in (wheel.get("spreads") or {}).values()
        if sp.get("long_occ")
    }
    longs = ds._summarize_long_options(cfg, exclude_occs=_spread_legs)
    return {
        "equity":        float(account.get("equity", account.get("portfolio_value", 0))),
        "cash":          float(account.get("cash", 0)),
        "portfolio":     float(account.get("portfolio_value", 0)),
        "premium_today": wheel.get("total_today",   0) if wheel.get("available") else 0,
        "premium_total": wheel.get("total_premium", 0) if wheel.get("available") else 0,
        "cycles":        wheel.get("total_cycles",  0) if wheel.get("available") else 0,
        "long_pnl":      longs.get("total_pnl", 0) if longs.get("available") else 0,
        "long_count":    longs.get("count",     0) if longs.get("available") else 0,
        "wheel_symbols": cfg["wheel_symbols"],
    }


def render() -> str:
    try:
        manual = _snapshot(config.MODES["manual"])
    except Exception as e:
        manual = {"error": f"{type(e).__name__}: {e}"}
    try:
        live = _snapshot(config.MODES["live"])
    except Exception as e:
        live = {"error": f"{type(e).__name__}: {e}"}

    out = [f"═══ MANUAL vs LIVE ".ljust(60, "═")]

    if "error" in manual or "error" in live:
        if "error" in manual:
            out.append(f"  manual: {manual['error']}")
        if "error" in live:
            out.append(f"  live:   {live['error']}")
        return "\n".join(out)

    rows = [
        ("Equity",         _format_money(manual["equity"]),        _format_money(live["equity"])),
        ("Cash",           _format_money(manual["cash"]),          _format_money(live["cash"])),
        ("Portfolio val",  _format_money(manual["portfolio"]),     _format_money(live["portfolio"])),
        ("Premium today",  _format_money(manual["premium_today"]), _format_money(live["premium_today"])),
        ("Premium total",  _format_money(manual["premium_total"]), _format_money(live["premium_total"])),
        ("Wheel cycles",   str(manual["cycles"]),                  str(live["cycles"])),
        ("Long opts P&L",  _format_money(manual["long_pnl"]),      _format_money(live["long_pnl"])),
        ("Long opts open", str(manual["long_count"]),              str(live["long_count"])),
        ("Wheel symbols",  str(len(manual["wheel_symbols"])),      str(len(live["wheel_symbols"]))),
    ]

    out.append(f"  {'Metric':<18} {'Manual (paper)':>16}  {'Live (real $)':>14}")
    out.append(f"  {'-'*18} {'-'*16}  {'-'*14}")
    for label, m, l in rows:
        out.append(f"  {label:<18} {m:>16}  {l:>14}")

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    print(render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
