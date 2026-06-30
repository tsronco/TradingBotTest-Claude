"""Cross-check: Alpaca open orders/positions vs. wheel state files.

For each account (manual + live), reports any:
  - Open orders the wheel ISN'T tracking (orphan orders)
  - Open short positions the wheel ISN'T tracking (orphan positions)
  - State entries that point to contracts that don't exist on Alpaca (stale)

Long-option positions (qty > 0) are excluded from drift checks — they're
managed by long_options_strategy which reads Alpaca directly, no state file.
Stocks (TSLA shares) are likewise excluded — managed by strategy.py.

Usage:
    python tools/check_state_drift.py

Exits 0 if no drift on either account, 1 otherwise. Useful as an ad-hoc
sanity check whenever you suspect the wheel state has fallen out of sync
with reality (e.g., after an outage, or after manually placing/canceling
orders outside the wheel).

History: written 2026-04-30 after the tsla-monitor-aggressive workflow's
`git add` chain failed to commit state files for an entire trading day,
leaving 5 zombie shorts the wheel didn't track. Run this any time you're
worried something similar might have happened.
"""
import json
import os
import re
from pathlib import Path
import requests
from dotenv import load_dotenv

p = Path(__file__).resolve().parent
for _ in range(6):
    if (p / ".env").exists():
        load_dotenv(p / ".env")
        break
    p = p.parent

# Walk up to repo root for state files
REPO = Path(__file__).resolve().parent
while not (REPO / "wheel_state_manual.json").exists() and REPO.parent != REPO:
    REPO = REPO.parent

ACCOUNTS = [
    {
        "label":         "MANUAL",
        "key_env":       "ALPACA_MANUAL_API_KEY",
        "secret_env":    "ALPACA_MANUAL_API_SECRET",
        "url_env":       "ALPACA_MANUAL_BASE_URL",
        "state_file":    REPO / "wheel_state_manual.json",
    },
    {
        "label":         "LIVE",
        "key_env":       "ALPACA_LIVE_API_KEY",
        "secret_env":    "ALPACA_LIVE_API_SECRET",
        "url_env":       "ALPACA_LIVE_BASE_URL",
        "state_file":    REPO / "wheel_state_live.json",
    },
]


def parse_occ_ticker(symbol):
    """Extract the ticker prefix from an OCC option symbol (everything before
    the first digit)."""
    m = re.match(r"^([A-Z]+)\d", symbol)
    return m.group(1) if m else None


def check_account(acct):
    print(f"\n{'='*70}")
    print(f"  {acct['label']}")
    print(f"{'='*70}")

    H = {"APCA-API-KEY-ID": os.environ[acct["key_env"]],
         "APCA-API-SECRET-KEY": os.environ[acct["secret_env"]]}
    BASE = os.environ.get(acct["url_env"], "https://paper-api.alpaca.markets/v2")

    # 1) Fetch Alpaca state
    open_orders = requests.get(f"{BASE}/orders", headers=H,
                                params={"status": "open", "limit": 200}).json()
    positions = requests.get(f"{BASE}/positions", headers=H).json()

    short_options = [p for p in positions
                     if p.get("asset_class") == "us_option"
                     and float(p.get("qty", 0)) < 0]
    long_options  = [p for p in positions
                     if p.get("asset_class") == "us_option"
                     and float(p.get("qty", 0)) > 0]
    stocks        = [p for p in positions if p.get("asset_class") == "us_equity"]

    print(f"  Alpaca: {len(open_orders)} open orders, "
          f"{len(short_options)} short opts, {len(long_options)} long opts, "
          f"{len(stocks)} stocks")

    # 2) Load wheel state
    if not acct["state_file"].exists():
        print(f"  WARN: state file {acct['state_file'].name} doesn't exist")
        wheel_state = {}
    else:
        wheel_state = json.loads(acct["state_file"].read_text())

    tracked_contracts = set()
    tracked_order_ids = set()
    for sym, ss in wheel_state.items():
        if sym.startswith("_") or not isinstance(ss, dict):
            continue
        if ss.get("current_contract"):
            tracked_contracts.add(ss["current_contract"])
        if ss.get("contract_order_id"):
            tracked_order_ids.add(ss["contract_order_id"])

    # 3) Cross-check open orders
    untracked_orders = []
    for o in open_orders:
        if o.get("asset_class") != "us_option":
            continue  # only worry about option orders; stock orders are not in wheel scope
        if o["id"] not in tracked_order_ids and o["symbol"] not in tracked_contracts:
            untracked_orders.append(o)

    # 4) Cross-check open short option positions
    untracked_shorts = []
    for p in short_options:
        if p["symbol"] not in tracked_contracts:
            untracked_shorts.append(p)

    # 5) Reverse check: state points to contract that doesn't exist on Alpaca
    alpaca_short_symbols = {p["symbol"] for p in short_options}
    stale_state = []
    for sym, ss in wheel_state.items():
        if sym.startswith("_") or not isinstance(ss, dict):
            continue
        c = ss.get("current_contract")
        if c and c not in alpaca_short_symbols:
            # state says we have a short but Alpaca doesn't show one
            # check if there's a pending order for it instead
            has_pending = c in {o["symbol"] for o in open_orders}
            if not has_pending:
                stale_state.append((sym, c))

    # 6) Report
    if not untracked_orders and not untracked_shorts and not stale_state:
        print(f"  OK — all {len(open_orders)} orders and {len(short_options)} short positions tracked")
    else:
        if untracked_orders:
            print(f"  DRIFT: {len(untracked_orders)} untracked open orders:")
            for o in untracked_orders:
                print(f"    {o['side']:>4} {o['symbol']:30s} qty={o['qty']} px=${o.get('limit_price')} status={o['status']}")
        if untracked_shorts:
            print(f"  DRIFT: {len(untracked_shorts)} untracked short positions:")
            for p in untracked_shorts:
                print(f"    {p['symbol']:30s} qty={p['qty']} avg=${p.get('avg_entry_price')}")
        if stale_state:
            print(f"  STALE: {len(stale_state)} state entries point to nonexistent positions:")
            for sym, c in stale_state:
                print(f"    {sym:6s} -> {c} (no Alpaca short, no pending order)")

    if long_options:
        print(f"  Note: {len(long_options)} long option positions (managed by long_options_strategy, not wheel state):")
        for p in long_options:
            print(f"    {p['symbol']:30s} qty={p['qty']} avg=${p.get('avg_entry_price')}")

    return {
        "untracked_orders": len(untracked_orders),
        "untracked_shorts": len(untracked_shorts),
        "stale_state": len(stale_state),
    }


def main():
    totals = {"untracked_orders": 0, "untracked_shorts": 0, "stale_state": 0}
    for a in ACCOUNTS:
        result = check_account(a)
        for k, v in result.items():
            totals[k] += v

    print(f"\n{'='*70}")
    print(f"  TOTAL: {totals['untracked_orders']} untracked orders, "
          f"{totals['untracked_shorts']} untracked shorts, "
          f"{totals['stale_state']} stale state entries")
    print(f"{'='*70}")
    return 0 if all(v == 0 for v in totals.values()) else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
