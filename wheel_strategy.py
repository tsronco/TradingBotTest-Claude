#!/usr/bin/env python3
"""
Multi-Stock Wheel Strategy

Runs the wheel on every symbol in SYMBOLS independently, with isolated state
per symbol. Each symbol's lifecycle:

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

State file layout (multi-stock):
  {
    "_meta": {"last_checked": "..."},
    "TSLA": {stage, current_contract, ...},
    "BAC":  {...},
    ...
  }

Legacy single-stock state files are auto-migrated under the "TSLA" key.
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

# ── Stocks the wheel runs on ──────────────────────────────────────────────
# Each gets its own isolated state. Adding/removing here is the entire
# config — `_empty_symbol_state` initializes any missing entry on next load.
SYMBOLS = ["TSLA", "BAC", "XOM", "KO", "PLTR", "SOFI"]

# ── Strategy parameters (apply uniformly to all symbols for now) ──────────
PUT_STRIKE_PCT       = 0.10   # sell put 10% below current price
CALL_STRIKE_PCT      = 0.10   # sell call 10% above cost basis
PUT_EXPIRY_DAYS_MIN  = 14
PUT_EXPIRY_DAYS_MAX  = 35
CALL_EXPIRY_DAYS_MIN = 7
CALL_EXPIRY_DAYS_MAX = 21
EARLY_CLOSE_PCT      = 0.50   # buy to close when contract loses 50% of its value
POLL_INTERVAL        = 60     # seconds — only used in legacy loop mode


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ── State management ──────────────────────────────────────────────────────

def _empty_symbol_state() -> dict:
    """Fresh state for a symbol that has never had a wheel run."""
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


def _migrate_state(state: dict) -> dict:
    """Migrate legacy single-stock state to multi-stock format.

    Legacy format had `stage` at top level. New format has every symbol's
    state nested under its ticker key, plus a `_meta` key for cross-symbol
    metadata.
    """
    if "stage" in state:
        # Old single-stock format → wrap under TSLA, preserve last_checked
        old_last_checked = state.pop("last_checked", "")
        return {
            "_meta": {"last_checked": old_last_checked},
            "TSLA": state,
        }
    return state


def load_state() -> dict:
    """Load state, migrate if needed, ensure all SYMBOLS have entries."""
    if not os.path.exists(STATE_FILE):
        state = {"_meta": {}}
    else:
        with open(STATE_FILE) as f:
            state = json.load(f)
        state = _migrate_state(state)
    state.setdefault("_meta", {})
    for sym in SYMBOLS:
        if sym not in state:
            state[sym] = _empty_symbol_state()
    return state


def save_state(state: dict) -> None:
    state.setdefault("_meta", {})["last_checked"] = datetime.utcnow().isoformat() + "Z"
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ── Alpaca API wrappers ───────────────────────────────────────────────────

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


def find_best_contract(underlying_symbol, option_type, target_strike,
                        exp_min_days, exp_max_days):
    """Find the contract closest to target_strike within the expiry window."""
    today = date.today()
    exp_min = (today + timedelta(days=exp_min_days)).isoformat()
    exp_max = (today + timedelta(days=exp_max_days)).isoformat()
    strike_low  = target_strike - 15
    strike_high = target_strike + 15

    data = api_get("/options/contracts", params={
        "underlying_symbols": underlying_symbol,
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

    target_exp = today + timedelta(days=(exp_min_days + exp_max_days) // 2)

    def score(c):
        strike_diff = abs(float(c["strike_price"]) - target_strike)
        exp_date    = date.fromisoformat(c["expiration_date"])
        exp_diff    = abs((exp_date - target_exp).days)
        return strike_diff * 2 + exp_diff  # weight strike match more heavily

    return min(contracts, key=score)


def place_sell_to_open(option_symbol, limit_price):
    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             "1",
        "side":            "sell",
        "type":            "limit",
        "limit_price":     str(round(limit_price, 2)),
        "time_in_force":   "gtc",
        "position_intent": "sell_to_open",
    })
    log(f"Sell-to-open placed: {option_symbol} @ ${limit_price:.2f} — order {order['id']}")
    return order


def place_buy_to_close(option_symbol, limit_price):
    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             "1",
        "side":            "buy",
        "type":            "limit",
        "limit_price":     str(round(limit_price + 0.05, 2)),  # slight premium to ensure fill
        "time_in_force":   "day",
        "position_intent": "buy_to_close",
    })
    log(f"Buy-to-close placed: {option_symbol} @ ${limit_price:.2f} — order {order['id']}")
    return order


def round_to_nearest_5(price):
    return round(price / 5) * 5


def check_early_close(sym_state, current_option_price):
    """Returns True if we should close early (50% profit rule)."""
    entry = sym_state.get("contract_entry_price")
    if entry is None:
        return False
    return current_option_price <= entry * EARLY_CLOSE_PCT


def _resolve_pending_contract(sym_state):
    """Disambiguate when contract is set but no position exists yet.

    Returns:
      "pending"     — order placed, not yet filled. Skip this cycle.
      "just_filled" — order just filled; entry_price was set as a side effect.
      "gone"        — order is cancelled/rejected/expired or no order_id.
    """
    order_id = sym_state.get("contract_order_id")
    if not order_id:
        return "gone"
    order = get_order(order_id)
    if order is None:
        return "gone"
    status = order.get("status", "")
    if status in ("new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding"):
        return "pending"
    if status == "filled":
        if sym_state.get("contract_entry_price") is None:
            filled_avg = order.get("filled_avg_price")
            if filled_avg:
                sym_state["contract_entry_price"] = float(filled_avg)
                log(f"Wheel order {order_id} filled — recorded entry price ${sym_state['contract_entry_price']:.2f}")
        return "just_filled"
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
    pos = get_option_position(contract_symbol)
    if pos:
        return abs(float(pos.get("market_value", 0))) / 100
    return None


# ── Stage handlers ────────────────────────────────────────────────────────

def handle_stage1(symbol, sym_state, stock_price, account):
    """Stage 1: manage the open short put or sell a new one for `symbol`."""
    contract = sym_state.get("current_contract")

    if contract:
        pos = get_option_position(contract)

        if pos is None:
            # No position. Pending fill, just filled, or contract gone?
            status = _resolve_pending_contract(sym_state)
            if status == "pending":
                log(f"[{symbol}] Stage 1 — order for {contract} still pending fill.")
                sym_state["last_action"] = f"Awaiting fill on {contract}."
                return
            if status == "just_filled":
                log(f"[{symbol}] Stage 1 — order for {contract} just filled. Tracking next cycle.")
                sym_state["last_action"] = f"Order filled on {contract} @ ${sym_state.get('contract_entry_price'):.2f}. Now tracking."
                return

            # status == "gone" → assignment or expired
            stock_pos = get_stock_position(symbol)
            if stock_pos and int(float(stock_pos["qty"])) >= 100:
                cost = abs(float(stock_pos["avg_entry_price"]))
                log(f"[{symbol}] PUT ASSIGNED — acquired 100 shares @ ${cost:.2f}")
                send_embed(
                    "tsla", f"Wheel: PUT ASSIGNED — now hold 100 {symbol} @ ${cost:.2f}",
                    color=Color.YELLOW,
                    description=f"Contract: {contract}\nMoving to Stage 2 (covered calls).",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "put_assigned",
                          symbol=contract,
                          details={"underlying": symbol, "cost_basis": cost, "qty": 100})
                sym_state["stage"]                = 2
                sym_state["cost_basis_per_share"] = cost
                sym_state["total_cost"]           = cost * 100
                sym_state["shares_qty"]           = 100
                sym_state["current_contract"]     = None
                sym_state["contract_entry_price"] = None
                sym_state["last_action"] = f"Assigned on {contract}. Cost basis: ${cost:.2f}"
                sym_state["cycle_history"].append({
                    "cycle": sym_state["cycle_count"] + 1,
                    "type": "put",
                    "symbol": contract,
                    "outcome": "assigned",
                    "cost_basis": cost,
                })
            else:
                # Expired worthless — collect premium, sell another put
                premium = sym_state.get("contract_entry_price", 0) or 0
                premium_dollars = premium * 100
                sym_state["total_premium_collected"] = round(
                    sym_state["total_premium_collected"] + premium_dollars, 2
                )
                sym_state["total_premium_today"] = round(
                    sym_state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"[{symbol}] PUT EXPIRED WORTHLESS — collected ${premium_dollars:.2f}.")
                send_embed(
                    "tsla", f"Wheel: {symbol} Put Expired Worthless — kept ${premium_dollars:.2f}",
                    color=Color.GREEN,
                    description=f"{contract}\nTotal {symbol} premium: ${sym_state['total_premium_collected']:.2f}",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "put_expired_worthless",
                          symbol=contract,
                          details={"underlying": symbol, "premium": premium_dollars,
                                   "total_premium": sym_state["total_premium_collected"]})
                sym_state["cycle_count"] += 1
                sym_state["cycle_history"].append({
                    "cycle": sym_state["cycle_count"],
                    "type": "put",
                    "symbol": contract,
                    "outcome": "expired_worthless",
                    "premium": premium_dollars,
                })
                sym_state["current_contract"]     = None
                sym_state["contract_entry_price"] = None
                sym_state["last_action"] = f"Put expired worthless. +${premium_dollars:.2f}. Selling new put."
                _sell_new_put(symbol, sym_state, stock_price, account)
        else:
            # Position exists. Recover entry_price if missing (e.g., order filled
            # between cycles), then check 50% profit rule.
            if sym_state.get("contract_entry_price") is None:
                order_id = sym_state.get("contract_order_id")
                if order_id:
                    order = get_order(order_id)
                    filled_avg = order.get("filled_avg_price") if order else None
                    if filled_avg:
                        sym_state["contract_entry_price"] = float(filled_avg)
                        log(f"[{symbol}] Recovered entry price ${sym_state['contract_entry_price']:.2f} from filled order {order_id}")

            current_price = get_option_last_price(contract)
            if current_price is not None:
                entry = sym_state.get("contract_entry_price")
                if entry and check_early_close(sym_state, current_price):
                    log(f"[{symbol}] 50% PROFIT RULE: {contract} @ ${current_price:.2f} vs entry ${entry:.2f}. Closing.")
                    place_buy_to_close(contract, current_price)
                    premium_dollars = (entry - current_price) * 100
                    sym_state["total_premium_collected"] = round(
                        sym_state["total_premium_collected"] + premium_dollars, 2
                    )
                    sym_state["total_premium_today"] = round(
                        sym_state.get("total_premium_today", 0) + premium_dollars, 2
                    )
                    send_embed(
                        "tsla", f"Wheel: {symbol} Early Close at 50% Profit — +${premium_dollars:.2f}",
                        color=Color.GREEN,
                        description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
                        footer="wheel_strategy.py",
                    )
                    log_event("tsla", "wheel_strategy.py", "early_close_50pct",
                              symbol=contract,
                              details={"underlying": symbol, "entry": float(entry),
                                       "exit": current_price, "premium": premium_dollars})
                    sym_state["current_contract"]     = None
                    sym_state["contract_entry_price"] = None
                    sym_state["last_action"] = f"Closed early: +${premium_dollars:.2f}. Selling new put."
                    _sell_new_put(symbol, sym_state, stock_price, account)
                else:
                    entry_str = f"${entry:.2f}" if entry is not None else "(unknown)"
                    pnl = (entry - current_price) * 100 if entry is not None else 0
                    log(f"[{symbol}] Stage 1 — monitoring {contract} @ ${current_price:.2f} (entry {entry_str}, unrealized +${pnl:.2f})")
                    sym_state["last_action"] = f"Monitoring {contract}: ${current_price:.2f} vs entry {entry_str}"
    else:
        _sell_new_put(symbol, sym_state, stock_price, account)


def _sell_new_put(symbol, sym_state, stock_price, account):
    """Find and sell the best cash-secured put for `symbol`."""
    target_strike = round_to_nearest_5(stock_price * (1 - PUT_STRIKE_PCT))
    cash = float(account["cash"])
    cash_required = target_strike * 100

    if cash < cash_required:
        log(f"[{symbol}] INSUFFICIENT CASH: need ${cash_required:,.0f}, have ${cash:,.0f}.")
        sym_state["last_action"] = "Insufficient cash to sell put."
        send_embed(
            "errors", f"Wheel: Insufficient Cash for {symbol} Put",
            color=Color.RED,
            description=f"Need ${cash_required:,.0f}, have ${cash:,.0f}",
            footer="wheel_strategy.py",
        )
        log_event("errors", "wheel_strategy.py", "insufficient_cash",
                  result="failure",
                  details={"underlying": symbol, "need": cash_required, "have": cash})
        return

    contract = find_best_contract(symbol, "put", target_strike,
                                   PUT_EXPIRY_DAYS_MIN, PUT_EXPIRY_DAYS_MAX)
    if not contract:
        log(f"[{symbol}] No suitable put contract found.")
        sym_state["last_action"] = "No suitable put contract found."
        log_event("errors", "wheel_strategy.py", "no_put_contract_found",
                  result="failure",
                  details={"underlying": symbol, "target_strike": target_strike})
        return

    option_symbol = contract["symbol"]
    close_price   = float(contract.get("close_price") or 0)
    limit_price   = round(close_price * 0.98, 2) if close_price > 0 else 1.00

    order = place_sell_to_open(option_symbol, limit_price)
    sym_state["current_contract"]      = option_symbol
    sym_state["contract_order_id"]     = order["id"]
    sym_state["contract_entry_price"]  = None  # will update once filled
    sym_state["contract_entry_date"]   = datetime.utcnow().isoformat() + "Z"
    sym_state["contract_expiration"]   = contract["expiration_date"]
    sym_state["contract_type"]         = "put"
    sym_state["contract_strike"]       = float(contract["strike_price"])
    log(f"[{symbol}] New put sold: {option_symbol} — strike ${contract['strike_price']}, exp {contract['expiration_date']}, limit ${limit_price:.2f}")
    send_embed(
        "tsla", f"Wheel: Sold-to-Open {symbol} Put @ ${contract['strike_price']}",
        color=Color.YELLOW,
        description=f"Contract: {option_symbol}\nLimit: ${limit_price:.2f}",
        fields=[
            {"name": "Underlying", "value": symbol, "inline": True},
            {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
            {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
            {"name": f"{symbol} price", "value": f"${stock_price:.2f}", "inline": True},
        ],
        footer="wheel_strategy.py",
    )
    sym_state["last_action"] = f"Sold-to-open {option_symbol} @ ${limit_price:.2f}. Awaiting fill."
    log_event("tsla", "wheel_strategy.py", "sold_put",
              symbol=option_symbol,
              details={"underlying": symbol, "strike": float(contract["strike_price"]),
                       "expiry": contract["expiration_date"], "limit_price": limit_price,
                       "stock_price": stock_price},
              alpaca_order_id=order["id"])


def handle_stage2(symbol, sym_state, stock_price, account):
    """Stage 2: manage the open short call or sell a new one for `symbol`."""
    contract   = sym_state.get("current_contract")
    cost_basis = sym_state.get("cost_basis_per_share")

    if contract:
        pos = get_option_position(contract)

        if pos is None:
            status = _resolve_pending_contract(sym_state)
            if status == "pending":
                log(f"[{symbol}] Stage 2 — order for {contract} still pending fill.")
                sym_state["last_action"] = f"Awaiting fill on {contract}."
                return
            if status == "just_filled":
                log(f"[{symbol}] Stage 2 — order for {contract} just filled.")
                sym_state["last_action"] = f"Order filled on {contract} @ ${sym_state.get('contract_entry_price'):.2f}. Now tracking."
                return

            stock_pos = get_stock_position(symbol)
            if not stock_pos or int(float(stock_pos.get("qty", 0))) < 100:
                # Shares called away — back to Stage 1
                premium = sym_state.get("contract_entry_price", 0) or 0
                premium_dollars = premium * 100
                sym_state["total_premium_collected"] = round(
                    sym_state["total_premium_collected"] + premium_dollars, 2
                )
                sym_state["total_premium_today"] = round(
                    sym_state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"[{symbol}] CALL ASSIGNED — shares sold @ ${sym_state['contract_strike']:.0f}. +${premium_dollars:.2f}")
                send_embed(
                    "tsla", f"Wheel: {symbol} CALL ASSIGNED — shares sold @ ${sym_state['contract_strike']:.0f}",
                    color=Color.GREEN,
                    description=f"+${premium_dollars:.2f} premium kept. Returning to Stage 1.",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "call_assigned",
                          symbol=contract,
                          details={"underlying": symbol, "strike": sym_state["contract_strike"],
                                   "premium": premium_dollars})
                sym_state["stage"]                = 1
                sym_state["shares_qty"]           = 0
                sym_state["cost_basis_per_share"] = None
                sym_state["total_cost"]           = None
                sym_state["current_contract"]     = None
                sym_state["contract_entry_price"] = None
                sym_state["cycle_count"]          += 1
                sym_state["cycle_history"].append({
                    "cycle": sym_state["cycle_count"],
                    "type": "call",
                    "symbol": contract,
                    "outcome": "assigned",
                    "premium": premium_dollars,
                })
                sym_state["last_action"] = f"Call assigned. +${premium_dollars:.2f}. Restarting Stage 1."
                _sell_new_put(symbol, sym_state, stock_price, account)
            else:
                # Call expired worthless — sell another call
                premium = sym_state.get("contract_entry_price", 0) or 0
                premium_dollars = premium * 100
                sym_state["total_premium_collected"] = round(
                    sym_state["total_premium_collected"] + premium_dollars, 2
                )
                sym_state["total_premium_today"] = round(
                    sym_state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"[{symbol}] CALL EXPIRED WORTHLESS — +${premium_dollars:.2f}.")
                send_embed(
                    "tsla", f"Wheel: {symbol} Call Expired Worthless — kept ${premium_dollars:.2f}",
                    color=Color.GREEN,
                    description=f"{contract}\nTotal {symbol} premium: ${sym_state['total_premium_collected']:.2f}",
                    footer="wheel_strategy.py",
                )
                log_event("tsla", "wheel_strategy.py", "call_expired_worthless",
                          symbol=contract,
                          details={"underlying": symbol, "premium": premium_dollars,
                                   "total_premium": sym_state["total_premium_collected"]})
                sym_state["current_contract"]     = None
                sym_state["contract_entry_price"] = None
                sym_state["last_action"] = f"Call expired worthless. +${premium_dollars:.2f}. Selling new call."
                _sell_new_call(symbol, sym_state, stock_price, cost_basis)
        else:
            if sym_state.get("contract_entry_price") is None:
                order_id = sym_state.get("contract_order_id")
                if order_id:
                    order = get_order(order_id)
                    filled_avg = order.get("filled_avg_price") if order else None
                    if filled_avg:
                        sym_state["contract_entry_price"] = float(filled_avg)
                        log(f"[{symbol}] Recovered entry price ${sym_state['contract_entry_price']:.2f}")

            current_price = get_option_last_price(contract)
            if current_price is not None:
                entry = sym_state.get("contract_entry_price")
                if entry and check_early_close(sym_state, current_price):
                    log(f"[{symbol}] 50% PROFIT RULE on call: closing.")
                    place_buy_to_close(contract, current_price)
                    premium_dollars = (entry - current_price) * 100
                    sym_state["total_premium_collected"] = round(
                        sym_state["total_premium_collected"] + premium_dollars, 2
                    )
                    sym_state["total_premium_today"] = round(
                        sym_state.get("total_premium_today", 0) + premium_dollars, 2
                    )
                    send_embed(
                        "tsla", f"Wheel: {symbol} Early Close Call at 50% Profit — +${premium_dollars:.2f}",
                        color=Color.GREEN,
                        description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
                        footer="wheel_strategy.py",
                    )
                    log_event("tsla", "wheel_strategy.py", "early_close_call_50pct",
                              symbol=contract,
                              details={"underlying": symbol, "entry": float(entry),
                                       "exit": current_price, "premium": premium_dollars})
                    sym_state["current_contract"]     = None
                    sym_state["contract_entry_price"] = None
                    sym_state["last_action"] = f"Closed early: +${premium_dollars:.2f}. Selling new call."
                    _sell_new_call(symbol, sym_state, stock_price, cost_basis)
                else:
                    entry_str = f"${entry:.2f}" if entry is not None else "(unknown)"
                    pnl = (entry - current_price) * 100 if entry is not None else 0
                    log(f"[{symbol}] Stage 2 — monitoring {contract} @ ${current_price:.2f} (entry {entry_str}, unrealized +${pnl:.2f})")
                    sym_state["last_action"] = f"Monitoring {contract}: ${current_price:.2f} vs entry {entry_str}"
    else:
        _sell_new_call(symbol, sym_state, stock_price, cost_basis)


def _sell_new_call(symbol, sym_state, stock_price, cost_basis):
    """Find and sell the best covered call (above cost basis) for `symbol`."""
    if cost_basis is None:
        log(f"[{symbol}] No cost basis recorded — cannot sell call.")
        return

    target_strike = round_to_nearest_5(cost_basis * (1 + CALL_STRIKE_PCT))
    if target_strike < cost_basis:
        target_strike = round_to_nearest_5(cost_basis) + 5
        log(f"[{symbol}] Adjusted call strike to ${target_strike} (cost basis protection)")

    contract = find_best_contract(symbol, "call", target_strike,
                                   CALL_EXPIRY_DAYS_MIN, CALL_EXPIRY_DAYS_MAX)
    if not contract:
        log(f"[{symbol}] No suitable call contract found.")
        return

    if float(contract["strike_price"]) < cost_basis:
        log(f"[{symbol}] Refusing call at ${contract['strike_price']} — below cost basis ${cost_basis:.2f}")
        return

    option_symbol = contract["symbol"]
    close_price   = float(contract.get("close_price") or 0)
    limit_price   = round(close_price * 0.98, 2) if close_price > 0 else 1.00

    order = place_sell_to_open(option_symbol, limit_price)
    sym_state["current_contract"]      = option_symbol
    sym_state["contract_order_id"]     = order["id"]
    sym_state["contract_entry_price"]  = None
    sym_state["contract_entry_date"]   = datetime.utcnow().isoformat() + "Z"
    sym_state["contract_expiration"]   = contract["expiration_date"]
    sym_state["contract_type"]         = "call"
    sym_state["contract_strike"]       = float(contract["strike_price"])
    log(f"[{symbol}] New call sold: {option_symbol} — strike ${contract['strike_price']}, exp {contract['expiration_date']}, limit ${limit_price:.2f}")
    send_embed(
        "tsla", f"Wheel: Sold-to-Open {symbol} Call @ ${contract['strike_price']}",
        color=Color.YELLOW,
        description=f"Contract: {option_symbol}\nLimit: ${limit_price:.2f}",
        fields=[
            {"name": "Underlying", "value": symbol, "inline": True},
            {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
            {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
            {"name": "Cost basis", "value": f"${cost_basis:.2f}", "inline": True},
        ],
        footer="wheel_strategy.py",
    )
    sym_state["last_action"] = f"Sold-to-open {option_symbol} @ ${limit_price:.2f}. Awaiting fill."
    log_event("tsla", "wheel_strategy.py", "sold_call",
              symbol=option_symbol,
              details={"underlying": symbol, "strike": float(contract["strike_price"]),
                       "expiry": contract["expiration_date"], "limit_price": limit_price,
                       "cost_basis": cost_basis},
              alpaca_order_id=order["id"])


# ── Top-level orchestration ───────────────────────────────────────────────

def run_wheel():
    """One cycle: iterate every symbol in SYMBOLS, handle independently."""
    try:
        state = load_state()

        if not is_market_open():
            log(f"Market closed — skipping wheel cycle for all {len(SYMBOLS)} symbols.")
            log_event("tsla", "wheel_strategy.py", "cycle_skipped_market_closed",
                      result="skipped",
                      details={"symbols": SYMBOLS})
            return

        account = get_account()

        for symbol in SYMBOLS:
            sym_state = state.setdefault(symbol, _empty_symbol_state())
            try:
                stock_price = get_latest_price(symbol)
                log(f"[{symbol}] ${stock_price:.2f} | Stage {sym_state['stage']} | premium ${sym_state['total_premium_collected']:.2f} | contract {sym_state.get('current_contract') or 'none'}")

                if sym_state["stage"] == 1:
                    handle_stage1(symbol, sym_state, stock_price, account)
                elif sym_state["stage"] == 2:
                    handle_stage2(symbol, sym_state, stock_price, account)

                log_event("tsla", "wheel_strategy.py", "symbol_cycle_complete",
                          result="success",
                          details={"underlying": symbol, "stage": sym_state["stage"],
                                   "contract": sym_state.get("current_contract"),
                                   "stock_price": stock_price})
            except Exception as e:
                # Per-symbol error isolation: one bad symbol doesn't kill others.
                log(f"[{symbol}] error in wheel cycle: {type(e).__name__}: {e}")
                send_embed(
                    "errors", f"wheel_strategy.py — {symbol} cycle crashed",
                    color=Color.RED,
                    description=f"`{type(e).__name__}: {str(e)[:500]}`",
                    footer="wheel_strategy.py",
                )
                log_event("errors", "wheel_strategy.py", "symbol_exception",
                          result="failure",
                          notes=f"{symbol}: {type(e).__name__}: {str(e)[:500]}")

        save_state(state)
        log_event("tsla", "wheel_strategy.py", "cycle_complete",
                  result="success",
                  details={"symbols": SYMBOLS})
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
    """Aggregate summary across every symbol, post one combined embed."""
    try:
        state   = load_state()
        account = get_account()

        log("=" * 65)
        log("DAILY WHEEL SUMMARY (multi-stock)")

        # Aggregate metrics across symbols
        total_premium = sum(state[s].get("total_premium_collected", 0) for s in SYMBOLS)
        total_today   = sum(state[s].get("total_premium_today", 0) for s in SYMBOLS)
        total_cycles  = sum(state[s].get("cycle_count", 0) for s in SYMBOLS)

        per_symbol_lines = []
        for s in SYMBOLS:
            ss = state[s]
            try:
                price = get_latest_price(s)
                price_str = f"${price:.2f}"
            except Exception:
                price_str = "—"
            stage = ss.get("stage", 1)
            contract = ss.get("current_contract") or "—"
            line = f"  {s:5} ${ss.get('total_premium_collected', 0):>7.2f}  stage {stage}  {contract}  ({price_str})"
            log(line)
            per_symbol_lines.append(line.strip())

        log(f"  Total premium  : ${total_premium:.2f} (today ${total_today:.2f})")
        log(f"  Total cycles   : {total_cycles}")
        log(f"  Account cash   : ${float(account['cash']):,.2f}")
        log(f"  Portfolio val  : ${float(account['portfolio_value']):,.2f}")
        log("=" * 65)

        send_embed(
            "summary", f"Daily Wheel Summary — {datetime.now().strftime('%Y-%m-%d')}",
            color=Color.BLUE,
            fields=[
                {"name": "Premium today (all symbols)", "value": f"${total_today:.2f}", "inline": True},
                {"name": "Total premium", "value": f"${total_premium:.2f}", "inline": True},
                {"name": "Total cycles", "value": str(total_cycles), "inline": True},
                {"name": "Account cash", "value": f"${float(account['cash']):,.2f}", "inline": True},
                {"name": "Portfolio value", "value": f"${float(account['portfolio_value']):,.2f}", "inline": True},
                {"name": "By symbol", "value": "```\n" + "\n".join(per_symbol_lines) + "\n```", "inline": False},
            ],
            footer="wheel_strategy.py — daily summary",
        )
        log_event("daily-summary", "wheel_strategy.py", "daily_summary",
                  result="success",
                  details={
                      "total_premium": total_premium,
                      "total_today": total_today,
                      "total_cycles": total_cycles,
                      "cash": float(account["cash"]),
                      "portfolio_value": float(account["portfolio_value"]),
                      "per_symbol": {s: state[s] for s in SYMBOLS},
                  })

        # Reset daily counters across all symbols
        for s in SYMBOLS:
            state[s]["total_premium_today"] = 0.0
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
