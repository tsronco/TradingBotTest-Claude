#!/usr/bin/env python3
"""/pnl [period] — portfolio P&L rollup across both paper accounts.

Pulls Alpaca's portfolio_history endpoint and summarizes equity change over
the requested period. Renders an equity-curve chart per account.

Usage:
    python tools/pnl.py            # day
    python tools/pnl.py week
    python tools/pnl.py 1M
    python tools/pnl.py month --no-chart
    python tools/pnl.py all
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import alpaca_data as ad


# Period aliases → Alpaca's `period` param.
PERIOD_ALIASES = {
    "day": "1D", "today": "1D", "1d": "1D", "d": "1D",
    "week": "1W", "1w": "1W", "w": "1W",
    "month": "1M", "1m": "1M", "m": "1M",
    "3m": "3M", "quarter": "3M", "q": "3M",
    "year": "1A", "1y": "1A", "1a": "1A", "y": "1A",
    "all": "all", "max": "all",
}

TIMEFRAME_FOR = {
    "1D": "5Min",
    "1W": "1H",
    "1M": "1D",
    "3M": "1D",
    "1A": "1D",
    "all": "1D",
}


def normalize_period(s: str) -> str:
    s = s.lower().strip()
    if s in PERIOD_ALIASES:
        return PERIOD_ALIASES[s]
    upper = s.upper()
    if upper in {"1D", "1W", "1M", "3M", "1A"}:
        return upper
    return "1M"


def summarize(period: str, mode: str) -> dict:
    """Return start/end equity, $ delta, % delta, peak, trough."""
    timeframe = TIMEFRAME_FOR.get(period, "1D")
    params_period = period if period != "all" else None
    try:
        if params_period is None:
            # "all" → omit period; Alpaca returns max history
            data = ad._get(
                f"{ad.TRADING_API_URL}/account/portfolio/history",
                mode,
                params={"timeframe": timeframe},
            )
        else:
            data = ad.get_portfolio_history(period=params_period, timeframe=timeframe, mode=mode)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}

    equity = [e for e in (data.get("equity") or []) if e is not None]
    timestamps = data.get("timestamp") or []
    if not equity or not timestamps:
        return {"error": "no equity history returned"}

    start = equity[0]
    end = equity[-1]
    delta = end - start
    pct = (delta / start * 100) if start else 0
    return {
        "period": period,
        "start_equity": start,
        "end_equity": end,
        "delta": delta,
        "pct": pct,
        "peak": max(equity),
        "trough": min(equity),
        "n_points": len(equity),
        "timestamps": timestamps,
        "equity": equity,
    }


def render_chart(snap_cons: dict, snap_agg: dict, period: str) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(11, 5))

    for snap, color, label in (
        (snap_cons, "#1f77b4", "Manual"),
        (snap_agg, "#d62728", "Live"),
    ):
        if "error" in snap:
            continue
        times = [datetime.fromtimestamp(t) for t in snap["timestamps"]]
        ax.plot(times, snap["equity"], color=color, linewidth=1.5, label=label)

    ax.set_title(f"Equity over {period}")
    ax.set_xlabel("Time")
    ax.set_ylabel("Equity ($)")
    ax.grid(alpha=0.3)
    ax.legend(loc="best")
    fig.autofmt_xdate()
    fig.tight_layout()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = os.path.join(tempfile.gettempdir(), f"pnl_{period}_{ts}.png")
    fig.savefig(out, dpi=110)
    plt.close(fig)
    return out


def format_summary(snap: dict, mode: str) -> list[str]:
    lines = [f"  [{mode}]"]
    if "error" in snap:
        lines.append(f"    error: {snap['error']}")
        return lines
    sign = "+" if snap["delta"] >= 0 else ""
    lines.append(f"    Start:  ${snap['start_equity']:,.2f}")
    lines.append(f"    End:    ${snap['end_equity']:,.2f}")
    lines.append(f"    Δ:      {sign}${snap['delta']:,.2f}  ({sign}{snap['pct']:.2f}%)")
    lines.append(f"    Range:  ${snap['trough']:,.2f} – ${snap['peak']:,.2f}")
    return lines


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Portfolio P&L rollup across both accounts.")
    p.add_argument("period", nargs="?", default="day",
                   help="day | week | month | 3m | year | all (default day)")
    p.add_argument("--no-chart", action="store_true")
    args = p.parse_args(argv)

    period = normalize_period(args.period)
    snap_cons = summarize(period, "manual")
    snap_agg = summarize(period, "live")

    out = [f"═══ P&L OVER {period} ".ljust(60, "═")]
    out.extend(format_summary(snap_cons, "manual"))
    out.append("")
    out.extend(format_summary(snap_agg, "live"))

    if not args.no_chart and "error" not in snap_cons or "error" not in snap_agg:
        try:
            chart_path = render_chart(snap_cons, snap_agg, period)
            out.append("")
            out.append(f"Chart: {chart_path}")
        except Exception as e:
            out.append("")
            out.append(f"(chart render failed: {e})")

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
