#!/usr/bin/env python3
"""/positions — current holdings across both paper accounts.

Read-only. Groups positions by mode (manual / live), then by
asset class (stock / option), and prints a single tabular report with
quantity, average cost, current price, market value, and unrealized P&L.

Usage:
    python tools/positions.py                  # both accounts
    python tools/positions.py --mode live
    python tools/positions.py --filter options  # only options
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import alpaca_data as ad
from config import MODES


def _classify(p: dict) -> str:
    """Return 'option' for option contracts, 'stock' otherwise."""
    return "option" if p.get("asset_class") == "us_option" else "stock"


def _direction(p: dict) -> str:
    """Long vs short: positive qty = long, negative = short."""
    try:
        return "long" if float(p.get("qty", 0)) >= 0 else "short"
    except (TypeError, ValueError):
        return "long"


def _row(p: dict) -> dict:
    qty_f = float(p.get("qty", 0) or 0)
    entry = float(p.get("avg_entry_price", 0) or 0)
    current = float(p.get("current_price", 0) or 0)
    mv = float(p.get("market_value", 0) or 0)
    upl = float(p.get("unrealized_pl", 0) or 0)
    upl_pct = float(p.get("unrealized_plpc", 0) or 0) * 100
    return {
        "symbol": p.get("symbol", "?"),
        "qty": int(qty_f) if qty_f.is_integer() else qty_f,
        "entry": entry,
        "current": current,
        "market_value": mv,
        "upl": upl,
        "upl_pct": upl_pct,
        "kind": _classify(p),
        "side": _direction(p),
    }


def _close_progress(r: dict, early_close_pct: float | None) -> str:
    """For short options: % progress toward buy-to-close trigger.

    Trigger price = entry × early_close_pct (e.g. 0.50 manual = close at half entry).
    0% = at entry, 100% = trigger hit (ready to close), >100% = past trigger.
    Returns "—" for non-applicable rows (longs, stocks, missing data).
    """
    if early_close_pct is None or r["kind"] != "option" or r["side"] != "short":
        return "—"
    entry = r["entry"]
    current = r["current"]
    if entry <= 0:
        return "—"
    distance_needed = entry * (1 - early_close_pct)
    if distance_needed <= 0:
        return "—"
    progress = (entry - current) / distance_needed * 100
    return f"{progress:+5.0f}%"


def _format_section(title: str, rows: list[dict], early_close_pct: float | None = None,
                    show_close: bool = False) -> list[str]:
    if not rows:
        return [f"{title}: (none)"]
    lines = [title]
    if show_close:
        lines.append(f"  {'Symbol':<22} {'Side':<6} {'Qty':>6}  {'Entry':>9} {'Current':>9}  "
                     f"{'MV':>11}  {'UPL':>11}  {'UPL%':>7}  {'→Close':>7}")
        lines.append(f"  {'-'*22} {'-'*6} {'-'*6}  {'-'*9} {'-'*9}  {'-'*11}  {'-'*11}  {'-'*7}  {'-'*7}")
    else:
        lines.append(f"  {'Symbol':<22} {'Side':<6} {'Qty':>6}  {'Entry':>9} {'Current':>9}  "
                     f"{'MV':>11}  {'UPL':>11}  {'UPL%':>7}")
        lines.append(f"  {'-'*22} {'-'*6} {'-'*6}  {'-'*9} {'-'*9}  {'-'*11}  {'-'*11}  {'-'*7}")
    total_mv = 0.0
    total_upl = 0.0
    for r in rows:
        base = (
            f"  {r['symbol']:<22} {r['side']:<6} {r['qty']:>6}  "
            f"${r['entry']:>8.2f} ${r['current']:>8.2f}  "
            f"${r['market_value']:>10,.0f}  ${r['upl']:>+10,.0f}  {r['upl_pct']:>+6.1f}%"
        )
        if show_close:
            base += f"  {_close_progress(r, early_close_pct):>7}"
        lines.append(base)
        total_mv += r["market_value"]
        total_upl += r["upl"]
    total_line = (f"  {'TOTAL':<22} {'':<6} {'':>6}  {'':>9} {'':>9}  "
                  f"${total_mv:>10,.0f}  ${total_upl:>+10,.0f}")
    if show_close:
        total_line += f"  {'':>7}  {'':>7}"
    lines.append(total_line)
    return lines


def render_mode(mode: str, kind_filter: str | None) -> str:
    try:
        positions = ad.get_positions(mode=mode)
    except Exception as e:
        return f"[{mode}] could not fetch positions: {type(e).__name__}: {e}"

    rows = [_row(p) for p in positions]
    if kind_filter:
        rows = [r for r in rows if r["kind"] == kind_filter]

    stocks = [r for r in rows if r["kind"] == "stock"]
    options = [r for r in rows if r["kind"] == "option"]

    early_close_pct = MODES.get(mode, {}).get("early_close_pct")

    out = [f"═══ {mode.upper()} ".ljust(80, "═")]
    if kind_filter != "option":
        out.extend(_format_section("Stocks", stocks))
    if kind_filter != "stock":
        out.append("")
        out.extend(_format_section("Options", options, early_close_pct, show_close=True))
        if early_close_pct is not None and any(r["side"] == "short" for r in options):
            close_profit_pct = (1 - early_close_pct) * 100
            out.append(f"  → Close trigger: buy-to-close at {early_close_pct*100:.0f}% of entry "
                       f"({close_profit_pct:.0f}% profit). →Close shows progress to that trigger.")

    try:
        account = ad.get_account(mode=mode)
        out.append("")
        out.append(
            f"  Cash: ${float(account.get('cash', 0)):,.0f}    "
            f"Equity: ${float(account.get('equity', 0)):,.0f}    "
            f"Options BP: ${float(account.get('options_buying_power', 0)):,.0f}"
        )
    except Exception:
        pass

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Show holdings across both paper accounts.")
    p.add_argument("--mode", choices=["manual", "live", "both"], default="both")
    p.add_argument("--filter", choices=["stocks", "options"], default=None,
                   help="Show only stocks or only options.")
    args = p.parse_args(argv)

    kind_filter = None
    if args.filter == "stocks":
        kind_filter = "stock"
    elif args.filter == "options":
        kind_filter = "option"

    modes = ["manual", "live"] if args.mode == "both" else [args.mode]
    sections = [render_mode(m, kind_filter) for m in modes]
    print("\n\n".join(sections))
    return 0


if __name__ == "__main__":
    sys.exit(main())
