#!/usr/bin/env python3
"""One-off: buy-to-open 1 RIVN $15.50 call, May 22 2026 expiration.

Manual learning experiment outside the wheel strategy. Submits a limit
buy at the bid-ask midpoint (or close-price fallback). GTC, queues until
filled, no double-place risk because there's no monitor watching this.
"""
import json
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

API_KEY    = os.getenv("ALPACA_API_KEY")
API_SECRET = os.getenv("ALPACA_API_SECRET")
BASE_URL   = os.getenv("ALPACA_BASE_URL")
DATA_URL          = "https://data.alpaca.markets/v2"          # for stock data
OPTIONS_DATA_URL  = "https://data.alpaca.markets/v1beta1"     # for options data
HEADERS = {
    "APCA-API-KEY-ID":     API_KEY,
    "APCA-API-SECRET-KEY": API_SECRET,
    "accept":              "application/json",
}

UNDERLYING       = "RIVN"
TARGET_STRIKE    = 15.50
TARGET_EXPIRATION = "2026-05-22"

# 1. Find the contract
print(f"Looking up {UNDERLYING} ${TARGET_STRIKE} call expiring {TARGET_EXPIRATION}...")
resp = requests.get(
    f"{BASE_URL}/options/contracts",
    headers=HEADERS,
    params={
        "underlying_symbols": UNDERLYING,
        "type": "call",
        "expiration_date_gte": TARGET_EXPIRATION,
        "expiration_date_lte": TARGET_EXPIRATION,
        "strike_price_gte": TARGET_STRIKE - 0.5,
        "strike_price_lte": TARGET_STRIKE + 0.5,
        "limit": 20,
    },
    timeout=15,
)
resp.raise_for_status()
contracts = resp.json().get("option_contracts", [])
print(f"  Found {len(contracts)} candidates near ${TARGET_STRIKE}")

exact = [c for c in contracts if float(c["strike_price"]) == TARGET_STRIKE]
if not exact and contracts:
    exact = [min(contracts, key=lambda c: abs(float(c['strike_price']) - TARGET_STRIKE))]
    print(f"  No exact match. Closest: ${float(exact[0]['strike_price'])}")
    print(f"  All available: {sorted(set(float(c['strike_price']) for c in contracts))}")

if not exact:
    print("ERROR: No matching contract found")
    raise SystemExit(1)

contract = exact[0]
print(f"  Selected: {contract['symbol']}")
print(f"    strike  = ${contract['strike_price']}")
print(f"    expires = {contract['expiration_date']}")
print(f"    close   = ${contract.get('close_price')}")

# 2. Get current quote
print()
print("Getting current bid/ask quote...")
qresp = requests.get(
    f"{OPTIONS_DATA_URL}/options/quotes/latest",
    headers=HEADERS,
    params={"symbols": contract["symbol"], "feed": "indicative"},
    timeout=10,
)
qresp.raise_for_status()
quotes = qresp.json().get("quotes", {})
q = quotes.get(contract["symbol"])

if q:
    bid = float(q.get("bp") or 0)
    ask = float(q.get("ap") or 0)
    print(f"  bid=${bid:.2f}  ask=${ask:.2f}")
    if bid > 0 and ask > 0:
        limit_price = round((bid + ask) / 2, 2)
        print(f"  midpoint limit: ${limit_price:.2f}")
    else:
        cp = float(contract.get("close_price") or 0)
        limit_price = round(cp, 2) if cp > 0 else 0.50
        print(f"  no usable quote, using close: ${limit_price:.2f}")
else:
    cp = float(contract.get("close_price") or 0)
    limit_price = round(cp, 2) if cp > 0 else 0.50
    print(f"  no quote returned, using close: ${limit_price:.2f}")

cost = limit_price * 100
print(f"  estimated cost (if filled at limit): ${cost:.2f}")

# 3. Submit
print()
print(f"Submitting BUY-TO-OPEN limit @ ${limit_price:.2f}, qty 1, GTC...")
order_body = {
    "symbol":          contract["symbol"],
    "qty":             "1",
    "side":            "buy",
    "type":            "limit",
    "limit_price":     str(limit_price),
    "time_in_force":   "gtc",
    "position_intent": "buy_to_open",
}
oresp = requests.post(f"{BASE_URL}/orders", headers=HEADERS, json=order_body, timeout=15)
print(f"  HTTP {oresp.status_code}")
if oresp.status_code >= 400:
    print(f"  ERROR body: {oresp.text[:400]}")
    raise SystemExit(1)

o = oresp.json()
print(f"  Order ID:    {o['id']}")
print(f"  Status:      {o['status']}")
print(f"  Symbol:      {o['symbol']}")
print(f"  Qty:         {o['qty']}")
print(f"  Limit price: ${o.get('limit_price')}")
print(f"  TIF:         {o.get('time_in_force')}")
