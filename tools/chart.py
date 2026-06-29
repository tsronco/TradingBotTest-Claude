#!/usr/bin/env python3
"""/chart TICKER [--days N] — historical price chart with entry markers.

Renders a price chart for the requested ticker. If we hold the stock, the
average-cost line is drawn. If a wheel contract is open in either account
on this symbol, the strike is overlaid as a dashed line.

Output is a PNG at <tempdir>/chart_<TICKER>_<TS>.png plus a brief stdout summary.

Usage:
    python tools/chart.py TSLA
    python tools/chart.py NVDA --days 180
    python tools/chart.py WMT --days 30 --mode live
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config
import alpaca_data as ad


def _wheel_strikes_for(symbol: str) -> dict[str, float]:
    """Look up open wheel contract strike(s) for `symbol` across both modes.

    Returns {mode: strike} for whichever modes have an open contract.
    """
    out: dict[str, float] = {}
    for mode in ("manual", "live"):
        cfg = config.get_mode(mode)
        path = ROOT / cfg["wheel_state_file"]
        if not path.exists():
            continue
        try:
            with open(path) as f:
                state = json.load(f)
        except Exception:
            continue
        sym_state = state.get(symbol)
        if not isinstance(sym_state, dict):
            continue
        strike = sym_state.get("contract_strike")
        contract = sym_state.get("current_contract")
        if contract and strike:
            out[mode] = float(strike)
    return out


def _avg_cost_for(symbol: str, mode: str) -> float | None:
    try:
        pos = ad.get_position(symbol, mode=mode)
    except Exception:
        return None
    if not pos:
        return None
    try:
        return float(pos.get("avg_entry_price", 0)) or None
    except (TypeError, ValueError):
        return None


def render(symbol: str, days: int, mode: str) -> str:
    bars = ad.get_stock_bars(symbol, days=days, mode=mode)
    if not bars:
        return f"No bars returned for {symbol} over the last {days} days."

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.dates import DateFormatter

    dates = [datetime.fromisoformat(b["t"].replace("Z", "+00:00")).date() for b in bars]
    closes = [float(b["c"]) for b in bars]
    high = max(closes)
    low = min(closes)
    last = closes[-1]
    first = closes[0]
    pct_change = (last - first) / first * 100 if first else 0

    fig, ax = plt.subplots(figsize=(11, 5))
    ax.plot(dates, closes, color="#1f77b4", linewidth=1.7, label=f"{symbol} close")

    avg_cons = _avg_cost_for(symbol, "manual")
    avg_agg = _avg_cost_for(symbol, "live")
    if avg_cons:
        ax.axhline(avg_cons, color="#2ca02c", linestyle="--", alpha=0.7,
                   label=f"Avg cost (cons) ${avg_cons:.2f}")
    if avg_agg and avg_agg != avg_cons:
        ax.axhline(avg_agg, color="#9467bd", linestyle="--", alpha=0.7,
                   label=f"Avg cost (agg) ${avg_agg:.2f}")

    strikes = _wheel_strikes_for(symbol)
    for m, strike in strikes.items():
        color = "#d62728" if m == "manual" else "#ff7f0e"
        ax.axhline(strike, color=color, linestyle=":", alpha=0.6,
                   label=f"Wheel strike ({m}) ${strike:.0f}")

    ax.set_title(f"{symbol} — last {days} days  ({pct_change:+.1f}%)")
    ax.set_xlabel("Date")
    ax.set_ylabel("Price ($)")
    ax.xaxis.set_major_formatter(DateFormatter("%b %d"))
    ax.grid(alpha=0.3)
    ax.legend(loc="best", fontsize=9)
    fig.autofmt_xdate()
    fig.tight_layout()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(tempfile.gettempdir(), f"chart_{symbol}_{ts}.png")
    fig.savefig(out_path, dpi=110)
    plt.close(fig)

    summary = [
        f"{symbol} — last {days} days",
        f"  First close: ${first:.2f}    Last close: ${last:.2f}    Change: {pct_change:+.2f}%",
        f"  High: ${high:.2f}    Low: ${low:.2f}",
    ]
    if avg_cons:
        summary.append(f"  Avg cost (manual): ${avg_cons:.2f}")
    if avg_agg and avg_agg != avg_cons:
        summary.append(f"  Avg cost (live):   ${avg_agg:.2f}")
    if strikes:
        for m, strike in strikes.items():
            summary.append(f"  Open wheel strike ({m}): ${strike:.2f}")
    summary.append("")
    summary.append(f"Chart: {out_path}")
    return "\n".join(summary)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Historical price chart with entry markers.")
    p.add_argument("ticker")
    p.add_argument("--days", type=int, default=90)
    p.add_argument("--mode", default="manual", choices=["manual", "live"],
                   help="Account whose data feed authenticates the request (data is identical).")
    args = p.parse_args(argv)
    print(render(args.ticker.upper(), args.days, args.mode))
    return 0


if __name__ == "__main__":
    sys.exit(main())
