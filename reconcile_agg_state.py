"""One-shot reconciliation: rebuild wheel_state_aggressive.json from Alpaca.

Bug context: tsla-monitor-aggressive.yml had a `git add A B C` chain that
aborted atomically when strategy_state_aggressive.json didn't exist (it's
only written once a TSLA position is seeded). That left wheel_state_
aggressive.json un-staged and uncommitted on every cron fire today, so
the wheel kept seeing empty state at startup and re-selling puts on
symbols where Alpaca already had open shorts. Result: MARA went to qty=-4
and we have 5 zombie shorts the wheel doesn't know about.

This script scans the aggressive Alpaca account, builds a wheel-state
dict matching the open SHORT options, and writes wheel_state_aggressive.json
so the next cron fire picks up reality. Run once locally, then commit
the resulting state file. Future cycles will manage these positions
correctly (50% close rule, expiry handling, assignment -> Stage 2).

Usage:
    python reconcile_agg_state.py
"""
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
# .env is gitignored so it only exists in the main repo, not in worktrees.
# Walk up looking for .env so this script works from either location.
def _find_env():
    p = ROOT
    for _ in range(6):
        if (p / ".env").exists():
            return p / ".env"
        p = p.parent
    return ROOT / ".env"  # fallback (will fail loudly if truly missing)

load_dotenv(_find_env())

H = {"APCA-API-KEY-ID": os.environ["ALPACA_AGG_API_KEY"],
     "APCA-API-SECRET-KEY": os.environ["ALPACA_AGG_API_SECRET"]}
BASE = os.environ.get("ALPACA_AGG_BASE_URL", "https://paper-api.alpaca.markets/v2")

# Same SYMBOLS list as config.AGGRESSIVE_SYMBOLS (priority + fallback tier).
AGG_SYMBOLS = [
    "COIN", "MARA", "RIOT", "SMCI", "NVDA", "AMD", "MU",
    "TSLA", "BAC", "XOM", "KO", "PLTR", "SOFI", "PFE",
]


def empty_symbol_state():
    return {
        "stage": 1,
        "current_contract": None,
        "contract_order_id": None,
        "contract_entry_price": None,
        "contract_entry_date": None,
        "contract_expiration": None,
        "contract_type": None,
        "contract_strike": None,
        "cost_basis_per_share": None,
        "shares_qty": 0,
        "total_cost": None,
        "total_premium_collected": 0.0,
        "total_premium_today": 0.0,
        "cycle_count": 0,
        "cycle_history": [],
        "last_action": "",
    }


def parse_occ(symbol):
    """Parse OCC option symbol like 'MARA260508P00011000' -> (ticker, expiry, type, strike)."""
    m = re.match(r"^([A-Z]+)(\d{6})([CP])(\d{8})$", symbol)
    if not m:
        return None
    ticker = m.group(1)
    yymmdd = m.group(2)
    side   = m.group(3)
    strike = int(m.group(4)) / 1000.0
    expiry = date(2000 + int(yymmdd[0:2]), int(yymmdd[2:4]), int(yymmdd[4:6]))
    return ticker, expiry, side, strike


def main():
    positions = requests.get(f"{BASE}/positions", headers=H).json()
    print(f"Fetched {len(positions)} Alpaca positions")

    # Build state dict
    state = {"_meta": {"last_checked": datetime.now(timezone.utc).isoformat(),
                        "reconciled_from_alpaca": datetime.now(timezone.utc).isoformat()}}
    for sym in AGG_SYMBOLS:
        state[sym] = empty_symbol_state()

    # Scan Alpaca for short options that match wheel symbols
    matched = 0
    for p in positions:
        if p.get("asset_class") != "us_option":
            continue
        try:
            qty = float(p["qty"])
        except (KeyError, ValueError):
            continue
        if qty >= 0:
            continue  # not a short position
        parsed = parse_occ(p["symbol"])
        if parsed is None:
            print(f"  [warn]  could not parse {p['symbol']}")
            continue
        ticker, expiry, side, strike = parsed
        if ticker not in state:
            print(f"  [warn]  {p['symbol']} ticker {ticker} not in AGG_SYMBOLS — skipping")
            continue

        # Map this short option to the symbol's wheel state
        ss = state[ticker]
        if ss["current_contract"] is not None:
            print(f"  [warn]  {ticker} has multiple short positions (existing: {ss['current_contract']}, "
                  f"now also: {p['symbol']}). Keeping first; manual cleanup may be needed.")
            continue

        ss["current_contract"]    = p["symbol"]
        ss["contract_entry_price"] = float(p["avg_entry_price"])
        ss["contract_entry_date"]  = "2026-04-30T13:30:00Z"  # approximation; real time unknown
        ss["contract_expiration"] = expiry.isoformat()
        ss["contract_type"]       = "put" if side == "P" else "call"
        ss["contract_strike"]     = strike
        ss["last_action"] = (f"Reconciled from Alpaca on 2026-04-30. Position qty={qty} "
                             f"(may be > 1 due to duplicate sells before fix).")
        # If qty < -1, mark in cycle_history that we have multiple contracts
        if qty < -1:
            ss["cycle_history"].append({
                "type": "reconciliation_warning",
                "message": f"qty={qty} — duplicate sells happened before state-save bug fix",
            })
        matched += 1
        print(f"  OK {ticker:<6} -> {p['symbol']}  entry=${float(p['avg_entry_price']):.2f}  qty={qty}")

    out = ROOT / "wheel_state_aggressive.json"
    with out.open("w") as f:
        json.dump(state, f, indent=2)
    print(f"\nWrote {out} with {matched} matched short positions, {len(AGG_SYMBOLS)} symbols total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
