#!/usr/bin/env python3
"""/lookup TICKER — wheel-focused snapshot of a stock and its near-term puts.

Read-only. Fetches stock price + nearest wheel-candidate put contracts,
prints a structured report with bid/ask/Greeks/IV/OI, scores wheelability
of the best candidate, and saves an inline-renderable chart to /tmp.

Usage:
    python tools/lookup.py TSLA
    python tools/lookup.py WMT --mode live
    python tools/lookup.py NVDA --dte-min 7 --dte-max 14 --strike-pct 0.05

If --mode / --dte-* / --strike-pct are omitted, defaults come from
config.MODES["manual"].
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

# Make project-root importable when this file runs as `python tools/lookup.py`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
import alpaca_data as ad


# ── Wheelability scoring ────────────────────────────────────────────────────
#
# Scores a put-selling setup (NOT a price-direction prediction) against the
# wheelable-stock criteria documented in CLAUDE.md.  Each component is
# transparent and based on data we actually fetch — so the user can see
# exactly *why* a setup got the grade it did.
#
# Components and weights:
#   IV              0–3   30%+ great, 20–30% ok, <20% thin
#   Spread tight    0–2   <5% wide great, 5–15% ok, 15%+ illiquid
#   Open interest   0–1   ≥100 contracts at this strike
#   BP fit          0–1   strike*100 ≤ 25% of the mode's options BP
#   Already held    0–1   you already own ≥100 shares (covered-call entry)
#   Total           0–8
#
# Earnings proximity is shown as a footer warning, not scored — Alpaca doesn't
# give us earnings dates and we don't want to fail-closed on a missing field.

def grade_letter(score: int, max_score: int) -> str:
    pct = score / max_score if max_score else 0
    if pct >= 0.85:
        return "A"
    if pct >= 0.70:
        return "B"
    if pct >= 0.55:
        return "C"
    if pct >= 0.40:
        return "D"
    return "F"


def grade_emoji(score: int, max_score: int) -> str:
    pct = score / max_score if max_score else 0
    if pct >= 0.70:
        return "🟢"
    if pct >= 0.45:
        return "🟡"
    return "🔴"


def score_iv(iv: float | None) -> tuple[int, str]:
    if iv is None:
        return 0, "IV unavailable"
    pct = iv * 100
    if pct >= 30:
        return 3, f"IV {pct:.0f}% — high (fat premium)"
    if pct >= 20:
        return 2, f"IV {pct:.0f}% — moderate"
    if pct >= 10:
        return 1, f"IV {pct:.0f}% — low"
    return 0, f"IV {pct:.0f}% — very low (thin premium)"


def score_spread(bid: float, ask: float) -> tuple[int, str]:
    if bid <= 0 or ask <= 0:
        return 0, "No live quote"
    mid = (bid + ask) / 2
    if mid == 0:
        return 0, "No live quote"
    width_pct = (ask - bid) / mid * 100
    if width_pct < 5:
        return 2, f"Spread {width_pct:.1f}% wide — tight (liquid)"
    if width_pct < 15:
        return 1, f"Spread {width_pct:.1f}% wide — ok"
    return 0, f"Spread {width_pct:.1f}% wide — illiquid"


def score_open_interest(oi: int | None) -> tuple[int, str]:
    if oi is None:
        return 0, "OI unavailable"
    if oi >= 100:
        return 1, f"Open interest {oi:,} — fillable"
    return 0, f"Open interest {oi:,} — thin"


def score_bp_fit(strike: float, options_bp: float, cash: float = 0.0) -> tuple[int, str]:
    cash_required = strike * 100
    # Wheel sells CSPs against options_buying_power (pending orders reserve from it).
    # If options_bp is 0 but cash covers it, surface that — the wheel won't fire,
    # but the user can see *why* (margin saturation, not insufficient funds).
    if options_bp <= 0:
        if cash >= cash_required:
            return 0, (f"Need ${cash_required:,.0f} — options BP $0 (margin saturated); "
                       f"cash ${cash:,.0f} would cover, but wheel needs free options BP")
        return 0, f"Need ${cash_required:,.0f} — options BP $0 and cash ${cash:,.0f} short"
    pct_of_bp = cash_required / options_bp * 100
    if pct_of_bp <= 25:
        return 1, f"Need ${cash_required:,.0f} of ${options_bp:,.0f} BP ({pct_of_bp:.0f}%) — fits"
    if pct_of_bp <= 50:
        return 0, f"Need ${cash_required:,.0f} of ${options_bp:,.0f} BP ({pct_of_bp:.0f}%) — heavy"
    return 0, f"Need ${cash_required:,.0f} of ${options_bp:,.0f} BP ({pct_of_bp:.0f}%) — too much"


def score_holdings_context(stock_position: dict | None) -> tuple[int, str]:
    if stock_position is None:
        return 0, "No existing shares — fresh CSP entry"
    qty = abs(int(float(stock_position.get("qty", 0))))
    if qty >= 100:
        return 1, f"Already hold {qty} shares — covered-call entry available"
    return 0, f"Hold {qty} shares (<100 — not yet wheelable as covered call)"


def compute_wheelability(
    *,
    iv: float | None,
    bid: float,
    ask: float,
    open_interest: int | None,
    strike: float,
    options_bp: float,
    stock_position: dict | None,
    cash: float = 0.0,
) -> dict:
    """Compute wheelability score and reasons for one put candidate."""
    components = [
        score_iv(iv),
        score_spread(bid, ask),
        score_open_interest(open_interest),
        score_bp_fit(strike, options_bp, cash),
        score_holdings_context(stock_position),
    ]
    max_score = 3 + 2 + 1 + 1 + 1  # 8
    total = sum(pts for pts, _ in components)
    return {
        "score": total,
        "max_score": max_score,
        "grade": grade_letter(total, max_score),
        "emoji": grade_emoji(total, max_score),
        "reasons": [reason for _, reason in components],
    }


# ── Candidate selection ────────────────────────────────────────────────────

def pick_put_candidates(
    underlying: str,
    stock_price: float,
    strike_pct: float,
    dte_min: int,
    dte_max: int,
    n: int = 3,
    mode: str = "manual",
) -> list[dict]:
    """Return up to `n` near-target put contracts, enriched with quote+Greeks.

    Strategy:
      1. Pull all active puts in the DTE window via /options/contracts
      2. Filter strikes to within ±25% of the target ~10%-OTM strike
      3. Pull the chain snapshots for the underlying (one call → all Greeks)
      4. Sort by closeness to target, take top N, attach the snapshot data
    """
    target_strike = stock_price * (1 - strike_pct)
    contracts = ad.find_option_contracts(
        underlying=underlying,
        option_type="put",
        exp_min_days=dte_min,
        exp_max_days=dte_max,
        strike_low=target_strike * 0.75,
        strike_high=target_strike * 1.25,
        mode=mode,
    )
    if not contracts:
        return []

    target_dte_mid = (dte_min + dte_max) // 2
    today = date.today()

    def score(c: dict) -> float:
        strike_diff = abs(float(c["strike_price"]) - target_strike)
        exp = date.fromisoformat(c["expiration_date"])
        dte = (exp - today).days
        dte_diff = abs(dte - target_dte_mid)
        return strike_diff * 2 + dte_diff

    contracts.sort(key=score)
    top = contracts[:n]

    # One snapshot call for the whole chain — cheaper than per-contract calls.
    snapshots = ad.get_option_chain_snapshots(
        underlying,
        option_type="put",
        exp_min_days=dte_min,
        exp_max_days=dte_max,
        mode=mode,
    )

    enriched = []
    for c in top:
        snap = snapshots.get(c["symbol"], {})
        quote = snap.get("latestQuote") or {}
        greeks = snap.get("greeks") or {}
        bid = float(quote.get("bp") or 0)
        ask = float(quote.get("ap") or 0)
        enriched.append({
            "symbol": c["symbol"],
            "strike": float(c["strike_price"]),
            "expiration": c["expiration_date"],
            "dte": (date.fromisoformat(c["expiration_date"]) - today).days,
            "open_interest": int(c.get("open_interest") or 0) or None,
            "bid": bid,
            "ask": ask,
            "mid": (bid + ask) / 2 if (bid > 0 and ask > 0) else 0.0,
            "delta": greeks.get("delta"),
            "gamma": greeks.get("gamma"),
            "theta": greeks.get("theta"),
            "vega": greeks.get("vega"),
            "iv": snap.get("impliedVolatility"),
        })
    return enriched


# ── Position cross-reference ────────────────────────────────────────────────

def existing_positions(symbol: str) -> dict:
    """Look up current positions in this name across both paper accounts.

    Returns {"manual": pos_or_None, "live": pos_or_None}. Either
    side may raise on auth errors (e.g., live creds not set) — we swallow
    those and return None for that side so /lookup still works for users with
    only one account configured.
    """
    out = {}
    for mode in ("manual", "live"):
        try:
            out[mode] = ad.get_position(symbol, mode=mode)
        except Exception:
            out[mode] = None
    return out


# ── Chart rendering ────────────────────────────────────────────────────────

def render_chart(
    symbol: str,
    bars: list[dict],
    stock_price: float,
    candidate_strikes: list[float],
    out_dir: str | None = None,
) -> str:
    if out_dir is None:
        out_dir = tempfile.gettempdir()
    """Render a 90-day price chart with candidate strikes overlaid. Returns path."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.dates import DateFormatter

    if not bars:
        return ""

    dates = [datetime.fromisoformat(b["t"].replace("Z", "+00:00")).date() for b in bars]
    closes = [float(b["c"]) for b in bars]

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.plot(dates, closes, color="#1f77b4", linewidth=1.5, label=f"{symbol} close")
    ax.axhline(stock_price, color="#1f77b4", linestyle=":", alpha=0.6,
               label=f"Now ${stock_price:.2f}")

    colors = ["#d62728", "#ff7f0e", "#2ca02c"]
    for i, strike in enumerate(candidate_strikes):
        ax.axhline(strike, color=colors[i % len(colors)], linestyle="--", alpha=0.7,
                   label=f"Put strike ${strike:.0f}")

    ax.set_title(f"{symbol} — 90-day price with wheel-candidate put strikes")
    ax.set_xlabel("Date")
    ax.set_ylabel("Price ($)")
    ax.xaxis.set_major_formatter(DateFormatter("%b %d"))
    ax.grid(alpha=0.3)
    ax.legend(loc="best", fontsize=9)
    fig.autofmt_xdate()
    fig.tight_layout()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(out_dir, f"lookup_{symbol}_{ts}.png")
    fig.savefig(out_path, dpi=110)
    plt.close(fig)
    return out_path


# ── Report rendering ───────────────────────────────────────────────────────

def format_report(
    *,
    symbol: str,
    stock_price: float,
    prev_close: float | None,
    candidates: list[dict],
    positions: dict,
    options_bp: float,
    cash: float,
    chart_path: str,
    mode: str,
) -> str:
    lines = []
    change_str = ""
    if prev_close and prev_close > 0:
        chg = stock_price - prev_close
        chg_pct = chg / prev_close * 100
        sign = "+" if chg >= 0 else ""
        change_str = f"  ({sign}{chg:.2f} / {sign}{chg_pct:.2f}%)"

    lines.append(f"╔═ {symbol} ".ljust(60, "═") + "╗")
    lines.append(f"║ Price: ${stock_price:.2f}{change_str}")
    lines.append(f"║ Mode context: {mode}  |  Options BP: ${options_bp:,.0f}  |  Cash: ${cash:,.0f}")

    for tag, pos in positions.items():
        if pos:
            qty = pos.get("qty", "?")
            avg = float(pos.get("avg_entry_price", 0) or 0)
            mv = float(pos.get("market_value", 0) or 0)
            upl = float(pos.get("unrealized_pl", 0) or 0)
            lines.append(f"║ Held ({tag}): qty {qty} @ ${avg:.2f}  MV ${mv:,.0f}  UPL ${upl:+,.0f}")
    lines.append("╚" + "═" * 58 + "╝")

    if not candidates:
        lines.append("")
        lines.append("No put contracts found in the requested DTE/strike window.")
        lines.append("Try a wider --dte-min/--dte-max or different --strike-pct.")
        return "\n".join(lines)

    lines.append("")
    lines.append(f"── Wheel-candidate puts ──")
    for i, c in enumerate(candidates, 1):
        delta = c["delta"]
        theta = c["theta"]
        iv = c["iv"]
        delta_str = f"{delta:+.2f}" if delta is not None else "—"
        theta_str = f"{theta:+.3f}" if theta is not None else "—"
        iv_str = f"{iv*100:.0f}%" if iv is not None else "—"
        oi_str = f"{c['open_interest']:,}" if c["open_interest"] else "—"

        lines.append("")
        lines.append(f"  [{i}] ${c['strike']:.0f} put  exp {c['expiration']} ({c['dte']}d)")
        lines.append(f"      Bid/Ask: ${c['bid']:.2f} / ${c['ask']:.2f}    Mid: ${c['mid']:.2f}"
                     f"    OI: {oi_str}")
        lines.append(f"      Delta: {delta_str}    Theta: {theta_str}    IV: {iv_str}")
        if c["mid"] > 0:
            collateral = c["strike"] * 100
            premium = c["mid"] * 100
            ret_pct = premium / collateral * 100
            lines.append(f"      → ${premium:.0f} premium / ${collateral:,.0f} collateral"
                         f"  =  {ret_pct:.2f}% / {c['dte']}d")

    # Wheelability footer on the BEST (top) candidate.
    best = candidates[0]
    score = compute_wheelability(
        iv=best["iv"],
        bid=best["bid"],
        ask=best["ask"],
        open_interest=best["open_interest"],
        strike=best["strike"],
        options_bp=options_bp,
        cash=cash,
        stock_position=positions.get(mode),
    )
    lines.append("")
    lines.append("─" * 60)
    lines.append(f"Wheel setup (top candidate): {score['emoji']} {score['score']}/{score['max_score']}"
                 f" — Grade {score['grade']}")
    for reason in score["reasons"]:
        lines.append(f"  • {reason}")
    lines.append("")
    lines.append("⚠ Earnings dates not checked — Alpaca doesn't provide them.")
    lines.append("  If earnings fall in the contract's DTE window, IV will collapse")
    lines.append("  after the print; verify on yahoo finance / marketchameleon before selling.")
    lines.append("")
    lines.append("This scores SETUP QUALITY, not a price-direction call.")
    lines.append("─" * 60)

    if chart_path:
        lines.append("")
        lines.append(f"Chart: {chart_path}")

    return "\n".join(lines)


# ── Orchestration ──────────────────────────────────────────────────────────

def run_lookup(symbol: str, mode: str, strike_pct: float, dte_min: int, dte_max: int) -> str:
    symbol = symbol.upper().strip()

    trade = ad.get_stock_quote(symbol, mode=mode)
    stock_price = float(trade["p"])

    bars = ad.get_stock_bars(symbol, days=90, mode=mode)
    prev_close = float(bars[-2]["c"]) if len(bars) >= 2 else None

    candidates = pick_put_candidates(
        underlying=symbol,
        stock_price=stock_price,
        strike_pct=strike_pct,
        dte_min=dte_min,
        dte_max=dte_max,
        n=3,
        mode=mode,
    )

    positions = existing_positions(symbol)

    options_bp = 0.0
    cash = 0.0
    try:
        account = ad.get_account(mode=mode)
        options_bp = float(account.get("options_buying_power") or 0)
        cash = float(account.get("cash") or 0)
    except Exception as e:
        # Don't silently mask a real failure as "$0 BP" — print why so the user
        # can tell "fetch broke" apart from "account legitimately has $0 BP".
        print(f"⚠ Could not fetch account ({mode}): {e}", file=sys.stderr)

    chart_path = ""
    if bars:
        try:
            chart_path = render_chart(
                symbol=symbol,
                bars=bars,
                stock_price=stock_price,
                candidate_strikes=[c["strike"] for c in candidates],
            )
        except Exception as e:
            chart_path = f"(chart render failed: {e})"

    return format_report(
        symbol=symbol,
        stock_price=stock_price,
        prev_close=prev_close,
        candidates=candidates,
        positions=positions,
        options_bp=options_bp,
        cash=cash,
        chart_path=chart_path,
        mode=mode,
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("ticker", help="Stock ticker (e.g. TSLA, WMT)")
    p.add_argument("--mode", default="manual", choices=["manual", "live"],
                   help="Which paper account to query for BP/positions context (data is identical)")
    p.add_argument("--strike-pct", type=float, default=None,
                   help="OTM percentage for the target put strike (default: mode's put_strike_pct)")
    p.add_argument("--dte-min", type=int, default=None,
                   help="Minimum days to expiration (default: mode's put_dte_min)")
    p.add_argument("--dte-max", type=int, default=None,
                   help="Maximum days to expiration (default: mode's put_dte_max)")
    args = p.parse_args(argv)

    cfg = config.get_mode(args.mode)
    strike_pct = args.strike_pct if args.strike_pct is not None else cfg["put_strike_pct"]
    dte_min = args.dte_min if args.dte_min is not None else cfg["put_dte_min"]
    dte_max = args.dte_max if args.dte_max is not None else cfg["put_dte_max"]

    report = run_lookup(args.ticker, args.mode, strike_pct, dte_min, dte_max)
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
