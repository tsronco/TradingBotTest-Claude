#!/usr/bin/env python3
"""/wheel-status — per-symbol view of the wheel state in both accounts.

Shows for every wheeled symbol: stage (1 CSP / 2 CC), the open contract if
any, days to expiration, entry premium, current premium, profit %, and how
close it is to the mode's early-close trigger. Read-only.

Usage:
    python tools/wheel_status.py
    python tools/wheel_status.py --mode live
    python tools/wheel_status.py --mode manual TSLA  # one symbol
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config
import alpaca_data as ad


def _load_state(mode: str) -> dict:
    cfg = config.get_mode(mode)
    path = ROOT / cfg["wheel_state_file"]
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def _fmt_contract_line(symbol: str, sym_state: dict, early_close_pct: float) -> list[str]:
    contract = sym_state.get("current_contract")
    stage = sym_state.get("stage", 1)
    stage_label = "Stage 1 (CSP)" if stage == 1 else "Stage 2 (CC)"
    shares = sym_state.get("shares_qty", 0)
    cost_basis = sym_state.get("cost_basis_per_share")
    cost_basis_str = f"${cost_basis:.2f}" if cost_basis else "—"
    total_premium = sym_state.get("total_premium_collected", 0) or 0
    cycles = sym_state.get("cycle_count", 0)

    header = (
        f"  {symbol:<6} {stage_label:<14}  shares: {shares:>4}  "
        f"cost basis: {cost_basis_str:>7}  cycles: {cycles}  total premium: ${total_premium:.2f}"
    )

    if not contract:
        return [header, f"         (no open contract)"]

    entry = sym_state.get("contract_entry_price")
    expiration = sym_state.get("contract_expiration")

    dte_str = "?"
    if expiration:
        try:
            dte = (date.fromisoformat(expiration) - date.today()).days
            dte_str = f"{dte}d"
        except ValueError:
            pass

    # Live current premium
    quote = None
    try:
        quote = ad.get_option_quote(contract, mode=_state_mode_cache.get("mode", "manual"))
    except Exception:
        pass

    if quote and quote["bid"] > 0 and quote["ask"] > 0:
        current = (quote["bid"] + quote["ask"]) / 2
        current_str = f"${current:.2f}"
    else:
        current_str = "—"

    profit_str = "—"
    progress_str = ""
    if entry and quote and quote["bid"] > 0:
        current = (quote["bid"] + quote["ask"]) / 2
        # For a SHORT option (we sold to open), profit = entry - current
        profit = entry - current
        profit_pct = profit / entry * 100 if entry else 0
        profit_str = f"${profit*100:+.0f} ({profit_pct:+.0f}%)"
        # Trigger matches wheel_strategy.check_early_close: current <= entry * early_close_pct.
        # config's early_close_pct is the buy-back ratio of entry, NOT the profit threshold.
        # E.g. 0.40 = "buy back at 40% of entry" = 60% profit captured.
        target = entry * early_close_pct
        profit_threshold_pct = int((1 - early_close_pct) * 100)
        if current <= target:
            progress_str = f"  TRIGGER HIT — close eligible"
        else:
            # progress = how much of (entry - target) distance we've covered
            distance_needed = entry - target  # = entry * (1 - early_close_pct)
            pct_done = (entry - current) / distance_needed * 100 if distance_needed else 0
            pct_done = max(0, min(100, pct_done))
            progress_str = f"  {pct_done:.0f}% toward {profit_threshold_pct}%-profit close"

    detail = (
        f"         contract: {contract}  exp: {expiration} ({dte_str})  "
        f"entry: ${entry:.2f}  now: {current_str}  P&L: {profit_str}{progress_str}"
        if entry is not None else
        f"         contract: {contract}  exp: {expiration} ({dte_str})  (entry price not yet recorded)"
    )

    return [header, detail]


# Tiny module-level cache so _fmt_contract_line knows which mode it's rendering
# (avoids threading mode through every call).
_state_mode_cache: dict = {"mode": "manual"}


def render_mode(mode: str, only_symbol: str | None) -> str:
    cfg = config.get_mode(mode)
    state = _load_state(mode)
    if not state:
        return f"[{mode}] no state file at {cfg['wheel_state_file']}"

    _state_mode_cache["mode"] = mode

    out = [f"═══ {mode.upper()} ".ljust(80, "═")]
    last_checked = state.get("_meta", {}).get("last_checked", "?")
    out.append(f"  last checked: {last_checked}")
    out.append(f"  early-close threshold: {int(cfg['early_close_pct']*100)}%")
    out.append("")

    symbols = [s for s in state if not s.startswith("_")] if not only_symbol else [only_symbol]
    if only_symbol and only_symbol not in state:
        out.append(f"  symbol {only_symbol!r} not in {mode} wheel state")
        return "\n".join(out)

    for sym in symbols:
        sym_state = state.get(sym)
        if not isinstance(sym_state, dict):
            continue
        out.extend(_fmt_contract_line(sym, sym_state, cfg["early_close_pct"]))
        out.append("")

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Per-symbol wheel state.")
    p.add_argument("--mode", choices=["manual", "live", "both"], default="both")
    p.add_argument("symbol", nargs="?", default=None,
                   help="Show only this symbol (case-insensitive).")
    args = p.parse_args(argv)

    only = args.symbol.upper() if args.symbol else None
    modes = ["manual", "live"] if args.mode == "both" else [args.mode]
    print("\n\n".join(render_mode(m, only) for m in modes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
