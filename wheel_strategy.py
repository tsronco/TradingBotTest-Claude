#!/usr/bin/env python3
"""
TSLA Wheel Strategy

Stage 1 — Sell Cash-Secured Put:
  - Strike: ~10% below current price, rounded to nearest $5
  - Expiration: 2–4 weeks out (target ~3 weeks)
  - Rule: only sell if cash >= strike * 100
  - If expires worthless: sell another put (stay Stage 1)
  - If assigned: own 100 shares, move to Stage 2

Stage 2 — Sell Covered Call:
  - Strike: ~10% above cost basis, rounded to nearest $5, NEVER below cost basis
  - Expiration: 2 weeks out
  - If expires worthless: sell another call (stay Stage 2)
  - If assigned (shares called away): go back to Stage 1

Early exit: if any open contract hits 50% profit (worth ≤ 50% of entry price), buy to close
"""

import os
import json
import time
import requests
from datetime import datetime, timedelta, date
from dotenv import load_dotenv

from notifications import send_embed, log_event, Color

load_dotenv()

API_KEY    = os.getenv("ALPACA_API_KEY")
API_SECRET = os.getenv("ALPACA_API_SECRET")
BASE_URL   = os.getenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets/v2")
DATA_URL   = "https://data.alpaca.markets/v2"

HEADERS = {
    "APCA-API-KEY-ID":     API_KEY,
    "APCA-API-SECRET-KEY": API_SECRET,
    "accept":              "application/json",
}

STATE_FILE  = os.path.join(os.path.dirname(__file__), "wheel_state.json")
SYMBOL      = "TSLA"
PUT_STRIKE_PCT       = 0.10   # sell put 10% below current price
CALL_STRIKE_PCT      = 0.10   # sell call 10% above cost basis
PUT_EXPIRY_DAYS_MIN  = 14
PUT_EXPIRY_DAYS_MAX  = 35
CALL_EXPIRY_DAYS_MIN = 7
CALL_EXPIRY_DAYS_MAX = 21
EARLY_CLOSE_PCT      = 0.50   # buy to close when contract loses 50% of its value
POLL_INTERVAL        = 60     # seconds


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def load_state():
    with open(STATE_FILE) as f:
        return json.load(f)


def save_state(state):
    state["last_checked"] = datetime.utcnow().isoformat() + "Z"
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def api_get(path, params=None):
    resp = requests.get(f"{BASE_URL}{path}", headers=HEADERS, params=params)
    resp.raise_for_status()
    return resp.json()


def api_post(path, body):
    resp = requests.post(f"{BASE_URL}{path}", headers=HEADERS, json=body)
    resp.raise_for_status()
    return resp.json()


def api_delete(path):
    resp = requests.delete(f"{BASE_URL}{path}", headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


def get_latest_price(symbol):
    resp = requests.get(
        f"{DATA_URL}/stocks/{symbol}/trades/latest",
        headers=HEADERS,
        params={"feed": "iex"},
    )
    resp.raise_for_status()
    return float(resp.json()["trade"]["p"])


def get_account():
    return api_get("/account")


def get_positions():
    return api_get("/positions")


def is_market_open():
    """Returns True when NYSE regular session is open (9:30 AM–4:00 PM ET)."""
    try:
        return bool(api_get("/clock").get("is_open", False))
    except Exception as e:
        log(f"is_market_open check failed: {e} — assuming closed")
        return False


def get_order(order_id):
    """Fetch order details by ID. Returns None on 404."""
    try:
        return api_get(f"/orders/{order_id}")
    except requests.HTTPError as e:
        if e.response.status_code == 404:
            return None
        raise


def get_option_position(contract_symbol):
    """Returns position dict or None if not found."""
    try:
        return api_get(f"/positions/{contract_symbol}")
    except requests.HTTPError as e:
        if e.response.status_code == 404:
            return None
        raise


def get_stock_position(symbol):
    """Returns position dict or None if not found."""
    try:
        return api_get(f"/positions/{symbol}")
    except requests.HTTPError as e:
        if e.response.status_code == 404:
            return None
        raise


def find_best_contract(option_type, target_strike, exp_min_days, exp_max_days):
    """Find the contract closest to target_strike within the expiry window."""
    today = date.today()
    exp_min = (today + timedelta(days=exp_min_days)).isoformat()
    exp_max = (today + timedelta(days=exp_max_days)).isoformat()
    strike_low  = target_strike - 15
    strike_high = target_strike + 15

    data = api_get("/options/contracts", params={
        "underlying_symbols": SYMBOL,
        "type":               option_type,
        "expiration_date_gte": exp_min,
        "expiration_date_lte": exp_max,
        "strike_price_gte":   strike_low,
        "strike_price_lte":   strike_high,
        "limit": 50,
    })
    contracts = data.get("option_contracts", [])
    if not contracts:
        return None

    # Pick contract closest to target strike; prefer mid-range expiry (~3 weeks out)
    target_exp = today + timedelta(days=(exp_min_days + exp_max_days) // 2)

    def score(c):
        strike_diff = abs(float(c["strike_price"]) - target_strike)
        exp_date    = date.fromisoformat(c["expiration_date"])
        exp_diff    = abs((exp_date - target_exp).days)
        return strike_diff * 2 + exp_diff  # weight strike match more heavily

    return min(contracts, key=score)


def place_sell_to_open(symbol, limit_price):
    order = api_post("/orders", {
        "symbol":          symbol,
        "qty":             "1",
        "side":            "sell",
        "type":            "limit",
        "limit_price":     str(round(limit_price, 2)),
        "time_in_force":   "gtc",
        "position_intent": "sell_to_open",
    })
    log(f"Sell-to-open placed: {symbol} @ ${limit_price:.2f} — order {order['id']}")
    return order


def place_buy_to_close(symbol, limit_price):
    order = api_post("/orders", {
        "symbol":          symbol,
        "qty":             "1",
        "side":            "buy",
        "type":            "limit",
        "limit_price":     str(round(limit_price + 0.05, 2)),  # slight premium to ensure fill
        "time_in_force":   "day",
        "position_intent": "buy_to_close",
    })
    log(f"Buy-to-close placed: {symbol} @ ${limit_price:.2f} — order {order['id']}")
    return order


def round_to_nearest_5(price):
    return round(price / 5) * 5


def check_early_close(state, current_option_price):
    """Returns True if we should close early (50% profit rule)."""
    entry = state.get("contract_entry_price")
    if entry is None:
        return False
    return current_option_price <= entry * EARLY_CLOSE_PCT


def _resolve_pending_contract(state):
    """When the contract symbol is set but no position exists yet, this disambiguates
    'order still pending fill' from 'contract truly gone (expired/assigned/cancelled)'.

    Returns one of:
      "pending"  — order placed, not yet filled. Skip this cycle.
      "just_filled" — order just filled; contract_entry_price was set as a side effect.
                       Caller should re-fetch position and continue normal flow.
      "gone"     — order is cancelled/rejected/expired, OR no order_id recorded.
                       Caller should treat the contract as gone (assigned/worthless flow).
    """
    order_id = state.get("contract_order_id")
    if not order_id:
        return "gone"
    order = get_order(order_id)
    if order is None:
        return "gone"
    status = order.get("status", "")
    if status in ("new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding"):
        return "pending"
    if status == "filled":
        # Record the entry price so 50%-profit rule can fire on future cycles
        if state.get("contract_entry_price") is None:
            filled_avg = order.get("filled_avg_price")
            if filled_avg:
                state["contract_entry_price"] = float(filled_avg)
                log(f"Wheel order {order_id} filled — recorded entry price ${state['contract_entry_price']:.2f}")
        return "just_filled"
    # canceled, expired, rejected, replaced, etc. — contract is genuinely gone.
    return "gone"


def get_option_last_price(contract_symbol):
    """Get last traded price for an options contract."""
    try:
        resp = requests.get(
            f"{DATA_URL}/options/trades/latest",
            headers=HEADERS,
            params={"symbols": contract_symbol, "feed": "indicative"},
        )
        resp.raise_for_status()
        data = resp.json()
        trades = data.get("trades", {})
        if contract_symbol in trades:
            return float(trades[contract_symbol]["p"])
    except Exception:
        pass
    # Fallback: use position market value / (100 * qty)
    pos = get_option_position(contract_symbol)
    if pos:
        return abs(float(pos.get("market_value", 0))) / 100
    return None


def handle_stage1(state, tsla_price, account):
    """Stage 1: manage the open short put or sell a new one."""
    contract = state.get("current_contract")

    # ── Check if we already have an open put position ─────────────────────
    if contract:
        pos = get_option_position(contract)

        if pos is None:
            # No position exists. Disambiguate: order still pending vs truly gone?
            status = _resolve_pending_contract(state)
            if status == "pending":
                log(f"Wheel Stage 1 — order for {contract} still pending fill. Skipping cycle.")
                state["last_action"] = f"Awaiting fill on {contract}."
                return
            if status == "just_filled":
                log(f"Wheel Stage 1 — order for {contract} just filled. Will track on next cycle.")
                state["last_action"] = f"Order filled on {contract} @ ${state.get('contract_entry_price'):.2f}. Now tracking."
                return
            # status == "gone" → fall through to assigned/expired logic below
            stock_pos = get_stock_position(SYMBOL)
            if stock_pos and int(float(stock_pos["qty"])) >= 100:
                # Assigned — we own shares now
                cost = abs(float(stock_pos["avg_entry_price"]))
                log(f"PUT ASSIGNED — acquired 100 TSLA shares @ ${cost:.2f}")
                send_embed(
                    "tsla", f"Wheel: PUT ASSIGNED — now hold 100 TSLA @ ${cost:.2f}",
                    color=Color.YELLOW,
                    description=f"Contract: {contract}\nMoving to Stage 2 (covered calls).",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "put_assigned",
                          symbol=contract,
                          details={"cost_basis": cost, "qty": 100})
                state["stage"]                = 2
                state["cost_basis_per_share"]  = cost
                state["total_cost"]            = cost * 100
                state["shares_qty"]            = 100
                state["current_contract"]      = None
                state["contract_entry_price"]  = None
                state["last_action"] = f"Assigned on {contract}. Cost basis: ${cost:.2f}"
                # Add to cycle history
                state["cycle_history"].append({
                    "cycle": state["cycle_count"] + 1,
                    "type": "put",
                    "symbol": contract,
                    "outcome": "assigned",
                    "cost_basis": cost,
                })
            else:
                # Expired worthless — collect premium, sell another put
                premium = state.get("contract_entry_price", 0) or 0
                premium_dollars = premium * 100
                state["total_premium_collected"] = round(
                    state["total_premium_collected"] + premium_dollars, 2
                )
                state["total_premium_today"] = round(
                    state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"PUT EXPIRED WORTHLESS — collected ${premium_dollars:.2f}. Total: ${state['total_premium_collected']:.2f}")
                send_embed(
                    "tsla", f"Wheel: Put Expired Worthless — kept ${premium_dollars:.2f}",
                    color=Color.GREEN,
                    description=f"{contract}\nTotal premium collected: ${state['total_premium_collected']:.2f}",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "put_expired_worthless",
                          symbol=contract,
                          details={"premium": premium_dollars, "total_premium": state["total_premium_collected"]})
                state["cycle_count"] += 1
                state["cycle_history"].append({
                    "cycle": state["cycle_count"],
                    "type": "put",
                    "symbol": contract,
                    "outcome": "expired_worthless",
                    "premium": premium_dollars,
                })
                state["current_contract"]     = None
                state["contract_entry_price"] = None
                state["last_action"] = f"Put expired worthless. +${premium_dollars:.2f}. Selling new put."
                _sell_new_put(state, tsla_price, account)
        else:
            # Position still open — check 50% profit rule
            current_price = get_option_last_price(contract)
            if current_price is not None:
                entry = state.get("contract_entry_price")
                if entry and check_early_close(state, current_price):
                    log(f"50% PROFIT RULE: {contract} now ${current_price:.2f} vs entry ${entry:.2f}. Closing early.")
                    place_buy_to_close(contract, current_price)
                    premium_dollars = (entry - current_price) * 100
                    state["total_premium_collected"] = round(
                        state["total_premium_collected"] + premium_dollars, 2
                    )
                    state["total_premium_today"] = round(
                        state.get("total_premium_today", 0) + premium_dollars, 2
                    )
                    send_embed(
                        "tsla", f"Wheel: Early Close at 50% Profit — +${premium_dollars:.2f}",
                        color=Color.GREEN,
                        description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
                        footer="wheel_strategy.py",
                    )
                    log_event("tsla", "wheel_strategy.py", "early_close_50pct",
                              symbol=contract,
                              details={"entry": float(entry), "exit": current_price, "premium": premium_dollars})
                    state["current_contract"]     = None
                    state["contract_entry_price"] = None
                    state["last_action"] = f"Closed early at 50% profit: +${premium_dollars:.2f}. Selling new put."
                    _sell_new_put(state, tsla_price, account)
                else:
                    pnl = ((entry or 0) - current_price) * 100 if entry else 0
                    log(f"Stage 1 — monitoring {contract} @ ${current_price:.2f} (entry ${entry:.2f}, unrealized +${pnl:.2f})")
                    state["last_action"] = f"Monitoring {contract}: ${current_price:.2f} vs entry ${entry:.2f}"
    else:
        # No contract at all — sell a new put
        _sell_new_put(state, tsla_price, account)


def _sell_new_put(state, tsla_price, account):
    """Find and sell the best cash-secured put."""
    target_strike = round_to_nearest_5(tsla_price * (1 - PUT_STRIKE_PCT))
    cash = float(account["cash"])
    cash_required = target_strike * 100

    if cash < cash_required:
        log(f"INSUFFICIENT CASH: need ${cash_required:,.0f}, have ${cash:,.0f}. Cannot sell put.")
        state["last_action"] = "Insufficient cash to sell put."
        send_embed(
            "errors", "Wheel: Insufficient Cash for New Put",
            color=Color.RED,
            description=f"Need ${cash_required:,.0f}, have ${cash:,.0f}",
            footer="wheel_strategy.py",
        )
        log_event("errors", "wheel_strategy.py", "insufficient_cash",
                  result="failure", details={"need": cash_required, "have": cash})
        return

    contract = find_best_contract("put", target_strike, PUT_EXPIRY_DAYS_MIN, PUT_EXPIRY_DAYS_MAX)
    if not contract:
        log("No suitable put contract found.")
        log_event("errors", "wheel_strategy.py", "no_put_contract_found",
                  result="failure", details={"target_strike": target_strike})
        return

    symbol      = contract["symbol"]
    close_price = float(contract.get("close_price") or 0)
    limit_price = round(close_price * 0.98, 2) if close_price > 0 else 1.00

    order = place_sell_to_open(symbol, limit_price)
    state["current_contract"]      = symbol
    state["contract_order_id"]     = order["id"]
    state["contract_entry_price"]  = None  # will update once filled
    state["contract_entry_date"]   = datetime.utcnow().isoformat() + "Z"
    state["contract_expiration"]   = contract["expiration_date"]
    state["contract_type"]         = "put"
    state["contract_strike"]       = float(contract["strike_price"])
    log(f"New put sold: {symbol} — strike ${contract['strike_price']}, exp {contract['expiration_date']}, limit ${limit_price:.2f}")
    send_embed(
        "tsla", f"Wheel: Sold-to-Open Put @ ${contract['strike_price']}",
        color=Color.YELLOW,
        description=f"Contract: {symbol}\nLimit: ${limit_price:.2f}",
        fields=[
            {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
            {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
            {"name": "TSLA price", "value": f"${tsla_price:.2f}", "inline": True},
        ],
        footer="wheel_strategy.py",
    )
    state["last_action"] = f"Sold-to-open {symbol} @ ${limit_price:.2f}. Awaiting fill."
    log_event("tsla", "wheel_strategy.py", "sold_put",
              symbol=symbol,
              details={"strike": float(contract["strike_price"]), "expiry": contract["expiration_date"], "limit_price": limit_price, "tsla_price": tsla_price},
              alpaca_order_id=order["id"])


def handle_stage2(state, tsla_price, account):
    """Stage 2: manage the open short call or sell a new one."""
    contract  = state.get("current_contract")
    cost_basis = state.get("cost_basis_per_share")

    if contract:
        pos = get_option_position(contract)

        if pos is None:
            # No position exists. Disambiguate: order still pending vs truly gone?
            status = _resolve_pending_contract(state)
            if status == "pending":
                log(f"Wheel Stage 2 — order for {contract} still pending fill. Skipping cycle.")
                state["last_action"] = f"Awaiting fill on {contract}."
                return
            if status == "just_filled":
                log(f"Wheel Stage 2 — order for {contract} just filled. Will track on next cycle.")
                state["last_action"] = f"Order filled on {contract} @ ${state.get('contract_entry_price'):.2f}. Now tracking."
                return
            # status == "gone" → fall through to assigned/expired logic below
            stock_pos = get_stock_position(SYMBOL)
            if not stock_pos or int(float(stock_pos.get("qty", 0))) < 100:
                # Shares were called away — go back to Stage 1
                premium = state.get("contract_entry_price", 0) or 0
                premium_dollars = premium * 100
                state["total_premium_collected"] = round(
                    state["total_premium_collected"] + premium_dollars, 2
                )
                state["total_premium_today"] = round(
                    state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"CALL ASSIGNED — shares sold at strike ${state['contract_strike']:.0f}. +${premium_dollars:.2f} premium. Back to Stage 1.")
                send_embed(
                    "tsla", f"Wheel: CALL ASSIGNED — shares sold @ strike ${state['contract_strike']:.0f}",
                    color=Color.GREEN,
                    description=f"+${premium_dollars:.2f} premium kept. Returning to Stage 1.",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "call_assigned",
                          symbol=contract,
                          details={"strike": state["contract_strike"], "premium": premium_dollars})
                state["stage"]                = 1
                state["shares_qty"]           = 0
                state["cost_basis_per_share"] = None
                state["total_cost"]           = None
                state["current_contract"]     = None
                state["contract_entry_price"] = None
                state["cycle_count"]          += 1
                state["cycle_history"].append({
                    "cycle": state["cycle_count"],
                    "type": "call",
                    "symbol": contract,
                    "outcome": "assigned",
                    "premium": premium_dollars,
                })
                state["last_action"] = f"Call assigned, shares sold. +${premium_dollars:.2f}. Restarting Stage 1."
                _sell_new_put(state, tsla_price, account)
            else:
                # Expired worthless — sell another call
                premium = state.get("contract_entry_price", 0) or 0
                premium_dollars = premium * 100
                state["total_premium_collected"] = round(
                    state["total_premium_collected"] + premium_dollars, 2
                )
                state["total_premium_today"] = round(
                    state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"CALL EXPIRED WORTHLESS — +${premium_dollars:.2f}. Total: ${state['total_premium_collected']:.2f}. Selling new call.")
                send_embed(
                    "tsla", f"Wheel: Call Expired Worthless — kept ${premium_dollars:.2f}",
                    color=Color.GREEN,
                    description=f"{contract}\nTotal premium collected: ${state['total_premium_collected']:.2f}",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "call_expired_worthless",
                          symbol=contract,
                          details={"premium": premium_dollars, "total_premium": state["total_premium_collected"]})
                state["current_contract"]     = None
                state["contract_entry_price"] = None
                state["last_action"] = f"Call expired worthless. +${premium_dollars:.2f}. Selling new call."
                _sell_new_call(state, tsla_price, cost_basis)
        else:
            # Position still open — check 50% profit rule
            current_price = get_option_last_price(contract)
            if current_price is not None:
                entry = state.get("contract_entry_price")
                if entry and check_early_close(state, current_price):
                    log(f"50% PROFIT RULE: {contract} now ${current_price:.2f} vs entry ${entry:.2f}. Closing early.")
                    place_buy_to_close(contract, current_price)
                    premium_dollars = (entry - current_price) * 100
                    state["total_premium_collected"] = round(
                        state["total_premium_collected"] + premium_dollars, 2
                    )
                    state["total_premium_today"] = round(
                        state.get("total_premium_today", 0) + premium_dollars, 2
                    )
                    send_embed(
                        "tsla", f"Wheel: Early Close Call at 50% Profit — +${premium_dollars:.2f}",
                        color=Color.GREEN,
                        description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
                        footer="wheel_strategy.py",
                    )
                    log_event("tsla", "wheel_strategy.py", "early_close_call_50pct",
                              symbol=contract,
                              details={"entry": float(entry), "exit": current_price, "premium": premium_dollars})
                    state["current_contract"]     = None
                    state["contract_entry_price"] = None
                    state["last_action"] = f"Closed early at 50% profit: +${premium_dollars:.2f}. Selling new call."
                    _sell_new_call(state, tsla_price, cost_basis)
                else:
                    pnl = ((entry or 0) - current_price) * 100 if entry else 0
                    log(f"Stage 2 — monitoring {contract} @ ${current_price:.2f} (entry ${entry:.2f}, unrealized +${pnl:.2f})")
                    state["last_action"] = f"Monitoring {contract}: ${current_price:.2f} vs entry ${entry:.2f}"
    else:
        _sell_new_call(state, tsla_price, cost_basis)


def _sell_new_call(state, tsla_price, cost_basis):
    """Find and sell the best covered call above cost basis."""
    if cost_basis is None:
        log("No cost basis recorded — cannot sell call.")
        return

    target_strike = round_to_nearest_5(cost_basis * (1 + CALL_STRIKE_PCT))
    # Hard rule: never sell below cost basis
    if target_strike < cost_basis:
        target_strike = round_to_nearest_5(cost_basis) + 5
        log(f"Adjusted call strike to ${target_strike} (cost basis protection)")

    contract = find_best_contract("call", target_strike, CALL_EXPIRY_DAYS_MIN, CALL_EXPIRY_DAYS_MAX)
    if not contract:
        log("No suitable call contract found.")
        return

    # Enforce: strike must be >= cost basis
    if float(contract["strike_price"]) < cost_basis:
        log(f"Refusing to sell call at ${contract['strike_price']} — below cost basis ${cost_basis:.2f}")
        return

    symbol      = contract["symbol"]
    close_price = float(contract.get("close_price") or 0)
    limit_price = round(close_price * 0.98, 2) if close_price > 0 else 1.00

    order = place_sell_to_open(symbol, limit_price)
    state["current_contract"]      = symbol
    state["contract_order_id"]     = order["id"]
    state["contract_entry_price"]  = None
    state["contract_entry_date"]   = datetime.utcnow().isoformat() + "Z"
    state["contract_expiration"]   = contract["expiration_date"]
    state["contract_type"]         = "call"
    state["contract_strike"]       = float(contract["strike_price"])
    log(f"New call sold: {symbol} — strike ${contract['strike_price']}, exp {contract['expiration_date']}, limit ${limit_price:.2f}")
    send_embed(
        "tsla", f"Wheel: Sold-to-Open Call @ ${contract['strike_price']}",
        color=Color.YELLOW,
        description=f"Contract: {symbol}\nLimit: ${limit_price:.2f}",
        fields=[
            {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
            {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
            {"name": "Cost basis", "value": f"${cost_basis:.2f}", "inline": True},
        ],
        footer="wheel_strategy.py",
    )
    state["last_action"] = f"Sold-to-open {symbol} @ ${limit_price:.2f}. Awaiting fill."
    log_event("tsla", "wheel_strategy.py", "sold_call",
              symbol=symbol,
              details={"strike": float(contract["strike_price"]), "expiry": contract["expiration_date"], "limit_price": limit_price, "cost_basis": cost_basis},
              alpaca_order_id=order["id"])


def run_wheel():
    try:
        state = load_state()

        # ── Skip cycle if market is closed ────────────────────────────────
        # Pre-market and after-hours runs would mishandle pending option orders
        # (no position exists yet → bot would interpret as "contract gone").
        # Save the heartbeat to JSONL but exit cleanly without touching state.
        if not is_market_open():
            log(f"Market closed — skipping wheel cycle. Stage {state['stage']}, contract {state.get('current_contract') or 'none'}.")
            log_event("tsla", "wheel_strategy.py", "cycle_skipped_market_closed",
                      result="skipped",
                      details={"stage": state["stage"], "contract": state.get("current_contract")})
            return

        account = get_account()
        price   = get_latest_price(SYMBOL)

        log(f"TSLA ${price:.2f} | Stage {state['stage']} | Total premium: ${state['total_premium_collected']:.2f} | Contract: {state.get('current_contract') or 'none'}")

        if state["stage"] == 1:
            handle_stage1(state, price, account)
        elif state["stage"] == 2:
            handle_stage2(state, price, account)

        log_event("tsla", "wheel_strategy.py", "cycle_complete",
                  result="success",
                  details={"stage": state["stage"], "contract": state.get("current_contract"), "tsla_price": price})

        save_state(state)
    except Exception as e:
        send_embed(
            "errors", "wheel_strategy.py — run_wheel crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer="wheel_strategy.py",
        )
        log_event("errors", "wheel_strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


def run_daily_summary():
    try:
        state   = load_state()
        account = get_account()

        tsla_price = get_latest_price(SYMBOL)
        log("=" * 65)
        log("DAILY WHEEL SUMMARY")
        log(f"  TSLA price       : ${tsla_price:.2f}")
        log(f"  Stage            : {state['stage']} ({'Selling Puts' if state['stage']==1 else 'Selling Calls'})")
        log(f"  Open contract    : {state.get('current_contract') or 'None'}")
        log(f"  Premium today    : ${state.get('total_premium_today', 0):.2f}")
        log(f"  Total premium    : ${state['total_premium_collected']:.2f}")
        log(f"  Cycles completed : {state['cycle_count']}")
        log(f"  Account cash     : ${float(account['cash']):,.2f}")
        log(f"  Portfolio value  : ${float(account['portfolio_value']):,.2f}")
        if state.get("cost_basis_per_share"):
            log(f"  Cost basis       : ${state['cost_basis_per_share']:.2f}/share")
        log("=" * 65)

        send_embed(
            "summary", f"Daily Wheel Summary — {datetime.now().strftime('%Y-%m-%d')}",
            color=Color.BLUE,
            fields=[
                {"name": "TSLA price", "value": f"${tsla_price:.2f}", "inline": True},
                {"name": "Stage", "value": str(state["stage"]), "inline": True},
                {"name": "Open contract", "value": state.get("current_contract") or "None", "inline": False},
                {"name": "Premium today", "value": f"${state.get('total_premium_today', 0):.2f}", "inline": True},
                {"name": "Total premium", "value": f"${state['total_premium_collected']:.2f}", "inline": True},
                {"name": "Cycles", "value": str(state["cycle_count"]), "inline": True},
                {"name": "Account cash", "value": f"${float(account['cash']):,.2f}", "inline": True},
                {"name": "Portfolio value", "value": f"${float(account['portfolio_value']):,.2f}", "inline": True},
            ],
            footer="wheel_strategy.py — daily summary",
        )
        log_event("daily-summary", "wheel_strategy.py", "daily_summary",
                  result="success",
                  details={
                      "tsla_price": tsla_price,
                      "stage": state["stage"],
                      "premium_today": state.get("total_premium_today", 0),
                      "total_premium": state["total_premium_collected"],
                      "cycles": state["cycle_count"],
                      "cash": float(account["cash"]),
                      "portfolio_value": float(account["portfolio_value"]),
                  })

        # Reset daily premium counter
        state["total_premium_today"] = 0.0
        save_state(state)
    except Exception as e:
        send_embed(
            "errors", "wheel_strategy.py — run_daily_summary crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer="wheel_strategy.py",
        )
        log_event("errors", "wheel_strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "loop"
    if mode == "summary":
        run_daily_summary()
    elif mode == "once":
        run_wheel()
    else:
        while True:
            run_wheel()
            time.sleep(POLL_INTERVAL)
