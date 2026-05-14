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
from dataclasses import dataclass
from datetime import datetime, timedelta, date, timezone
from dotenv import load_dotenv

import config
from notifications import send_embed, log_event, Color

load_dotenv()

# Stock data and options data endpoints don't vary by mode.
DATA_URL          = "https://data.alpaca.markets/v2"          # stock data
OPTIONS_DATA_URL  = "https://data.alpaca.markets/v1beta1"     # options data (different version!)

POLL_INTERVAL     = 60     # seconds — only used in legacy loop mode

# ── Mode-aware globals ───────────────────────────────────────────────────
# All assigned by apply_mode(). Default at import time is "conservative" so
# scripts that import SYMBOLS (like wheel_screener.py) keep their existing
# behavior unless an aggressive entry-point explicitly switches modes.

API_KEY            = None
API_SECRET         = None
BASE_URL           = None
HEADERS            = None
STATE_FILE         = None
SYMBOLS            = None
PUT_STRIKE_PCT     = None
CALL_STRIKE_PCT    = None
PUT_EXPIRY_DAYS_MIN  = None
PUT_EXPIRY_DAYS_MAX  = None
CALL_EXPIRY_DAYS_MIN = None
CALL_EXPIRY_DAYS_MAX = None
EARLY_CLOSE_PCT    = None
TRADES_CH          = None
ERRORS_CH          = None
SUMMARY_CH         = None
ACTIONS_CH         = None
LOG_STREAM         = None
MODE               = None
WHEEL_SKIP_NEW_PUTS  = False  # manual mode: never open Stage 1 puts
AUTO_DISCOVER_SYMBOLS = False  # manual mode: build SYMBOLS from Alpaca positions


def apply_mode(mode_name: str) -> None:
    """Switch this module's globals to the named mode (conservative|aggressive).

    Called once at script entry, before any wheel function runs. Mutates
    module-level globals so existing function bodies don't need to know
    about the mode argument.
    """
    global API_KEY, API_SECRET, BASE_URL, HEADERS, STATE_FILE, SYMBOLS
    global PUT_STRIKE_PCT, CALL_STRIKE_PCT
    global PUT_EXPIRY_DAYS_MIN, PUT_EXPIRY_DAYS_MAX
    global CALL_EXPIRY_DAYS_MIN, CALL_EXPIRY_DAYS_MAX
    global EARLY_CLOSE_PCT, STALE_AFTER_HOURS
    global TRADES_CH, ERRORS_CH, SUMMARY_CH, ACTIONS_CH, LOG_STREAM, MODE
    global WHEEL_SKIP_NEW_PUTS, AUTO_DISCOVER_SYMBOLS

    cfg = config.get_mode(mode_name)
    MODE = mode_name

    API_KEY    = os.getenv(cfg["alpaca_key_env"])
    API_SECRET = os.getenv(cfg["alpaca_secret_env"])
    BASE_URL   = os.getenv(cfg["alpaca_url_env"], "https://paper-api.alpaca.markets/v2")
    HEADERS    = {
        "APCA-API-KEY-ID":     API_KEY,
        "APCA-API-SECRET-KEY": API_SECRET,
        "accept":              "application/json",
    }
    STATE_FILE = os.path.join(os.path.dirname(__file__), cfg["wheel_state_file"])

    SYMBOLS              = cfg["wheel_symbols"]
    PUT_STRIKE_PCT       = cfg["put_strike_pct"]
    CALL_STRIKE_PCT      = cfg["call_strike_pct"]
    PUT_EXPIRY_DAYS_MIN  = cfg["put_dte_min"]
    PUT_EXPIRY_DAYS_MAX  = cfg["put_dte_max"]
    CALL_EXPIRY_DAYS_MIN = cfg["call_dte_min"]
    CALL_EXPIRY_DAYS_MAX = cfg["call_dte_max"]
    EARLY_CLOSE_PCT      = cfg["early_close_pct"]
    STALE_AFTER_HOURS    = cfg["stale_after_hours"]

    TRADES_CH  = cfg["trades_channel"]
    ERRORS_CH  = cfg["errors_channel"]
    SUMMARY_CH = cfg["summary_channel"]
    ACTIONS_CH = cfg["actions_channel"]
    LOG_STREAM = cfg["log_stream"]

    WHEEL_SKIP_NEW_PUTS   = cfg.get("wheel_skip_new_puts", False)
    AUTO_DISCOVER_SYMBOLS = cfg.get("auto_discover_symbols", False)


# Initialize at import time to conservative defaults so importers (e.g.,
# wheel_screener.py importing SYMBOLS) work without first calling apply_mode().
apply_mode(config.DEFAULT_MODE)


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
        "contract_qty": 1,  # number of contracts on this OCC symbol; almost
                            # always 1 for puts (wheel sells one per cycle),
                            # equals shares_qty // 100 for covered calls
                            # (one call covers 100 shares so we sell N).
        "cost_basis_per_share": None,
        "shares_qty": 0,
        "total_cost": None,
        "total_premium_collected": 0.0,
        "total_premium_today": 0.0,
        "cycle_count": 0,
        "cycle_history": [],
        "last_action": "",
    }


# ── Spread support (Phase 1: detection + state schema only) ────────────
# Future work: handle_spread() management logic, daily summary section,
# dashboard order form, live-mode wiring. See
# docs/superpowers/plans/2026-05-14-spread-detection-foundation.md.

@dataclass(frozen=True)
class SpreadPair:
    """Two paired option legs identified at discovery time.

    Identified by: same ticker, same expiration, same option type
    (both puts or both calls), opposite sides (one short one long).
    Strike geometry determines spread direction:
      - put_credit:  short_strike > long_strike  (bullish)
      - call_credit: short_strike < long_strike  (bearish)

    Debit spreads (long strike inside short strike) are NOT detected here —
    they're a different strategy and out of scope for this plan.
    """
    ticker: str
    spread_type: str
    short_occ: str
    long_occ: str
    short_strike: float
    long_strike: float
    expiration: date
    short_qty: int
    long_qty: int
    short_entry: float
    long_entry: float
    width: float
    net_credit: float
    max_loss: float


def _empty_spread_state() -> dict:
    """Fresh state for a symbol whose wheel position is a spread, not single-leg."""
    return {
        # Intentional string sentinel — spread state is a separate FSM from
        # single-leg wheel stages (1=CSP, 2=CC). Comparisons against 1 or 2
        # naturally won't match.
        "stage": "spread_active",
        "spread_type": None,
        "short_leg": {"occ": None, "strike": None, "entry_premium": None, "qty": 0},
        "long_leg":  {"occ": None, "strike": None, "entry_premium": None, "qty": 0},
        "expiration": None,
        "net_credit": None,
        "max_loss": None,
        "width": None,
        "opened_at": None,
        "total_premium_collected": 0.0,
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
#
# Retry policy mirrors notifications/discord._post: transient network failures
# from a flaky third-party endpoint shouldn't crash a single symbol's cycle.
# We retry on:
#   - 429 (rate-limit)
#   - 500/502/503/504 (Alpaca's edge or upstream having a moment)
#   - ConnectionError / Timeout (TCP reset, DNS hiccup, timeout)
# We do NOT retry on:
#   - 4xx other than 429 (real request errors — bad auth, bad path, etc.)
#   - 403 specifically (the wheel uses 403 as its BP-exhaustion short-circuit
#     signal; retrying would just delay the inevitable)

_ALPACA_RETRY_STATUS = {429, 500, 502, 503, 504}
_ALPACA_RETRY_BACKOFFS = (2, 8)   # seconds between attempts
_ALPACA_MAX_ATTEMPTS = 3


def _alpaca_request(method: str, url: str, **kwargs) -> requests.Response:
    """HTTP request to Alpaca with bounded retry on transient failures.

    Returns the final Response. Does NOT call raise_for_status — caller
    decides what status codes are errors (cancel_order treats 404/422 as
    success, for instance). If all attempts hit ConnectionError/Timeout,
    the underlying exception propagates so the existing per-symbol
    exception handler can log + isolate the failure.
    """
    for attempt in range(_ALPACA_MAX_ATTEMPTS):
        try:
            resp = requests.request(method, url, **kwargs)
            if (resp.status_code in _ALPACA_RETRY_STATUS
                    and attempt + 1 < _ALPACA_MAX_ATTEMPTS):
                wait = _ALPACA_RETRY_BACKOFFS[attempt]
                log(f"alpaca {method} {resp.status_code} (attempt "
                    f"{attempt+1}/{_ALPACA_MAX_ATTEMPTS}); retrying in {wait}s")
                time.sleep(wait)
                continue
            return resp
        except (requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            if attempt + 1 < _ALPACA_MAX_ATTEMPTS:
                wait = _ALPACA_RETRY_BACKOFFS[attempt]
                log(f"alpaca {method} {type(e).__name__} (attempt "
                    f"{attempt+1}/{_ALPACA_MAX_ATTEMPTS}); retrying in {wait}s")
                time.sleep(wait)
                continue
            raise  # exhausted — let caller's exception handler take over


def api_get(path, params=None):
    resp = _alpaca_request("GET", f"{BASE_URL}{path}", headers=HEADERS, params=params)
    resp.raise_for_status()
    return resp.json()


def api_post(path, body):
    resp = _alpaca_request("POST", f"{BASE_URL}{path}", headers=HEADERS, json=body)
    resp.raise_for_status()
    return resp.json()


def api_delete(path):
    resp = _alpaca_request("DELETE", f"{BASE_URL}{path}", headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


def get_latest_price(symbol):
    resp = _alpaca_request(
        "GET",
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


def place_sell_to_open(option_symbol, limit_price, qty=1):
    """Sell-to-open a short option position.

    qty defaults to 1 so put-selling stays unchanged (the wheel always
    sells one cash-secured put per cycle). Stage 2 covered-call sales
    pass qty equal to (shares_held // 100) so we sell ONE call per
    100 shares — e.g., assigned 400 shares → sell 4 covered calls.
    """
    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             str(qty),
        "side":            "sell",
        "type":            "limit",
        "limit_price":     str(round(limit_price, 2)),
        "time_in_force":   "gtc",
        "position_intent": "sell_to_open",
    })
    log(f"Sell-to-open placed: {option_symbol} qty={qty} @ ${limit_price:.2f} — order {order['id']}")
    return order


def cancel_order(order_id: str) -> bool:
    """Cancel an open Alpaca order. Idempotent — returns True if the order
    is no longer open after this call (whether we cancelled it or it was
    already gone), False if the cancel API actually failed.

    Status code handling:
      204 — cancelled successfully.
      404 — order doesn't exist (already cancelled externally). Treat as success.
      422 — order can't be cancelled (already filled). Treat as success — the
            caller's intent ("this order should not be open") is satisfied
            because the order is no longer open.
      5xx / network — real failure. Returns False so caller knows not to
            attempt a replacement (the old order might still be live).
    """
    try:
        resp = _alpaca_request(
            "DELETE",
            f"{BASE_URL}/orders/{order_id}",
            headers=HEADERS,
            timeout=15,
        )
        if resp.status_code in (204, 404, 422):
            return True
        resp.raise_for_status()
        return True
    except Exception as e:
        log(f"cancel_order({order_id}) failed: {type(e).__name__}: {e}")
        return False


def place_buy_to_close(option_symbol, limit_price, qty=None):
    """Buy-to-close a short option position.

    qty: number of contracts to close. If None (default), looks up the
    actual short position size on Alpaca and closes ALL of it. Pass an
    explicit qty only when you want a deliberate partial close.

    Why default to "look up": before this fix the function hardcoded
    qty="1", which broke when a state-persistence bug let the wheel sell
    duplicate puts on the same symbol (MARA went to qty=-4 on 2026-04-30).
    The 50%-profit close fired but only bought back 1 of the 4, leaving
    3 orphan contracts the wheel didn't track. With auto-lookup, an
    early-close now correctly closes every contract on that symbol in a
    single order, no matter how the position got there.
    """
    if qty is None:
        pos = get_option_position(option_symbol)
        if pos is None:
            log(f"place_buy_to_close: no Alpaca position for {option_symbol} — skipping")
            return None
        qty = abs(int(float(pos.get("qty", 0))))
        if qty == 0:
            log(f"place_buy_to_close: position qty=0 for {option_symbol} — skipping")
            return None

    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             str(qty),
        "side":            "buy",
        "type":            "limit",
        "limit_price":     str(round(limit_price + 0.05, 2)),  # slight premium to ensure fill
        "time_in_force":   "day",
        "position_intent": "buy_to_close",
    })
    log(f"Buy-to-close placed: {option_symbol} qty={qty} @ ${limit_price:.2f} — order {order['id']}")
    return order


def strike_increment(reference_price: float) -> float:
    """Standard option-chain strike spacing for a given stock price level.

    Stocks under $25 typically have $1 strike spacing in the chain.
    Stocks $25 and above typically have $5 strike spacing.
    (Some high-volume names also have $2.50 or $0.50 strikes — we don't
    target those; a $1 or $5 round always lands on a real strike.)
    """
    return 1.0 if reference_price < 25 else 5.0


def round_strike(target_strike: float, reference_price: float) -> float:
    """Round target_strike to the standard strike increment for this price level."""
    inc = strike_increment(reference_price)
    return round(target_strike / inc) * inc


# Kept as alias for any external callers; new code should use round_strike.
def round_to_nearest_5(price):
    return round(price / 5) * 5


def get_option_quote(contract_symbol):
    """Fetch the current bid/ask for an option contract.

    Returns dict {"bid": float, "ask": float} or None if unavailable.
    Note: Alpaca options data lives under v1beta1, NOT v2 (stock data uses v2).
    """
    try:
        resp = _alpaca_request(
            "GET",
            f"{OPTIONS_DATA_URL}/options/quotes/latest",
            headers=HEADERS,
            params={"symbols": contract_symbol, "feed": "indicative"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        quotes = data.get("quotes", {})
        if contract_symbol in quotes:
            q = quotes[contract_symbol]
            bid = float(q.get("bp") or 0)
            ask = float(q.get("ap") or 0)
            if bid > 0 and ask > 0:
                return {"bid": bid, "ask": ask}
    except Exception as e:
        log(f"get_option_quote({contract_symbol}) failed: {e}")
    return None


def compute_limit_price(option_symbol: str, contract: dict) -> float:
    """Pick a limit price for a sell-to-open order.

    Preferred: midpoint of the live bid-ask spread (current "fair value").
    Fallback: 98% of yesterday's closing price (legacy behavior, used when
    the live quote endpoint is unavailable or returns no quote).
    Last resort: $1.00 (when neither live quote nor close_price is available).
    """
    quote = get_option_quote(option_symbol)
    if quote:
        mid = (quote["bid"] + quote["ask"]) / 2
        return round(mid, 2)
    close_price = float(contract.get("close_price") or 0)
    if close_price > 0:
        return round(close_price * 0.98, 2)
    return 1.00


def check_early_close(sym_state, current_option_price):
    """Returns True if we should close early (50% profit rule)."""
    entry = sym_state.get("contract_entry_price")
    if entry is None:
        return False
    return current_option_price <= entry * EARLY_CLOSE_PCT


def _order_age_hours(sym_state) -> float:
    """How many hours has the current contract's order been pending?
    Returns 0.0 if contract_entry_date is missing or unparseable — never
    triggers the stale path on a parse error (defensive default)."""
    entry_date_str = sym_state.get("contract_entry_date")
    if not entry_date_str:
        return 0.0
    try:
        entry_dt = datetime.fromisoformat(entry_date_str.replace("Z", "+00:00"))
        # Older state files may have stored naive datetimes; treat naive as UTC.
        if entry_dt.tzinfo is None:
            entry_dt = entry_dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - entry_dt).total_seconds() / 3600
    except (ValueError, TypeError):
        return 0.0


def _resolve_pending_contract(sym_state):
    """Disambiguate when contract is set but no position exists yet.

    Returns:
      "pending"     — order placed, not yet filled. Skip this cycle.
      "stale"       — order pending > STALE_AFTER_HOURS. Caller should
                      cancel and re-quote at the fresh mid.
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
        # Check staleness BEFORE returning "pending". Filled/gone statuses
        # below take precedence over stale because they're terminal.
        if _order_age_hours(sym_state) > STALE_AFTER_HOURS:
            return "stale"
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
    """Get last traded price for an options contract.

    Same v1beta1 path as get_option_quote (options data is NOT under v2).
    """
    try:
        resp = _alpaca_request(
            "GET",
            f"{OPTIONS_DATA_URL}/options/trades/latest",
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
            # No position. Pending fill, just filled, stale, or contract gone?
            status = _resolve_pending_contract(sym_state)
            if status == "pending":
                log(f"[{symbol}] Stage 1 — order for {contract} still pending fill.")
                sym_state["last_action"] = f"Awaiting fill on {contract}."
                return
            if status == "just_filled":
                log(f"[{symbol}] Stage 1 — order for {contract} just filled. Tracking next cycle.")
                sym_state["last_action"] = f"Order filled on {contract} @ ${sym_state.get('contract_entry_price'):.2f}. Now tracking."
                return
            if status == "stale":
                # Pending > STALE_AFTER_HOURS — cancel and re-quote at fresh mid.
                # If cancel fails, leave state untouched (old order may still be live).
                order_id = sym_state["contract_order_id"]
                age_hours = _order_age_hours(sym_state)
                log(f"[{symbol}] Stage 1 — order {contract} stale at {age_hours:.1f}h, cancelling.")
                if cancel_order(order_id):
                    sym_state["current_contract"]      = None
                    sym_state["contract_order_id"]     = None
                    sym_state["contract_entry_date"]   = None
                    sym_state["last_action"] = f"Cancelled stale put {contract} ({age_hours:.1f}h), placing fresh."
                    send_embed(
                        ACTIONS_CH,
                        f"Wheel: {symbol} put stale at {age_hours:.1f}h — cancelled, refilling",
                        color=Color.YELLOW,
                        description=f"Old: {contract}\nReplacing with fresh limit at current mid",
                        footer=f"wheel_strategy.py · {MODE}",
                        actions_channel=ACTIONS_CH,
                        also_to_actions=False,
                    )
                    log_event(LOG_STREAM, "wheel_strategy.py", "stale_order_cancelled",
                              result="success",
                              details={"underlying": symbol, "contract": contract,
                                       "age_hours": round(age_hours, 1), "stage": 1})
                    # Same-cycle replacement: BP just freed up.
                    _sell_new_put(symbol, sym_state, stock_price, account)
                else:
                    log(f"[{symbol}] cancel_order({order_id}) returned False — leaving state, will retry next cycle.")
                    sym_state["last_action"] = f"Cancel of stale {contract} FAILED; will retry."
                    log_event(LOG_STREAM, "wheel_strategy.py", "stale_order_cancel_failed",
                              result="failure",
                              details={"underlying": symbol, "contract": contract,
                                       "age_hours": round(age_hours, 1), "stage": 1})
                return

            # status == "gone" → assignment or expired
            stock_pos = get_stock_position(symbol)
            if stock_pos and int(float(stock_pos["qty"])) >= 100:
                # Capture the ACTUAL number of shares Alpaca shows. With a single
                # qty=-1 put that's exactly 100. With qty=-N puts (e.g., the
                # MARA qty=-4 case from the duplicate-sell incident, or any
                # future scenario that legitimately holds multiple short puts
                # on the same OCC symbol), it's 100 × N. Reading from Alpaca
                # is the single source of truth — never assume 100.
                actual_shares = int(float(stock_pos["qty"]))
                cost = abs(float(stock_pos["avg_entry_price"]))
                log(f"[{symbol}] PUT ASSIGNED — acquired {actual_shares} shares @ ${cost:.2f}")
                send_embed(
                    TRADES_CH, f"Wheel: PUT ASSIGNED — now hold {actual_shares} {symbol} @ ${cost:.2f}",
                    color=Color.YELLOW,
                    description=f"Contract: {contract}\nMoving to Stage 2 (covered calls × {actual_shares // 100}).",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "put_assigned",
                          symbol=contract,
                          details={"underlying": symbol, "cost_basis": cost, "qty": actual_shares})
                sym_state["stage"]                = 2
                sym_state["cost_basis_per_share"] = cost
                sym_state["total_cost"]           = cost * actual_shares
                sym_state["shares_qty"]           = actual_shares
                sym_state["current_contract"]     = None
                sym_state["contract_entry_price"] = None
                sym_state["last_action"] = f"Assigned on {contract}. {actual_shares} shares, cost basis ${cost:.2f}."
                sym_state["cycle_history"].append({
                    "cycle": sym_state["cycle_count"] + 1,
                    "type": "put",
                    "symbol": contract,
                    "outcome": "assigned",
                    "cost_basis": cost,
                    "shares": actual_shares,
                })
            else:
                # Expired worthless — collect premium, sell another put.
                # Multi-contract math: if we somehow had qty=-N short puts on
                # the same OCC symbol (e.g., the MARA qty=-4 from the state-
                # persistence bug), all N expire together → premium = entry
                # × 100 × N. Normal case is qty=1 so this collapses to the
                # original formula.
                contract_qty    = sym_state.get("contract_qty") or 1
                premium_per_unit = sym_state.get("contract_entry_price", 0) or 0
                premium_dollars  = premium_per_unit * 100 * contract_qty
                sym_state["total_premium_collected"] = round(
                    sym_state["total_premium_collected"] + premium_dollars, 2
                )
                sym_state["total_premium_today"] = round(
                    sym_state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"[{symbol}] PUT EXPIRED WORTHLESS — {contract_qty}× contracts, collected ${premium_dollars:.2f}.")
                send_embed(
                    TRADES_CH, f"Wheel: {symbol} Put Expired Worthless — kept ${premium_dollars:.2f} ({contract_qty}× contracts)",
                    color=Color.GREEN,
                    description=f"{contract}\nTotal {symbol} premium: ${sym_state['total_premium_collected']:.2f}",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "put_expired_worthless",
                          symbol=contract,
                          details={"underlying": symbol, "premium": premium_dollars,
                                   "total_premium": sym_state["total_premium_collected"],
                                   "contracts": contract_qty})
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
                    # place_buy_to_close auto-detects qty and closes ALL
                    # contracts on this OCC symbol in one order.
                    place_buy_to_close(contract, current_price)
                    contract_qty    = sym_state.get("contract_qty") or 1
                    premium_dollars = (entry - current_price) * 100 * contract_qty
                    sym_state["total_premium_collected"] = round(
                        sym_state["total_premium_collected"] + premium_dollars, 2
                    )
                    sym_state["total_premium_today"] = round(
                        sym_state.get("total_premium_today", 0) + premium_dollars, 2
                    )
                    send_embed(
                        TRADES_CH, f"Wheel: {symbol} Early Close at 50% Profit — +${premium_dollars:.2f} ({contract_qty}× contracts)",
                        color=Color.GREEN,
                        description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
                        footer=f"wheel_strategy.py · {MODE}",
                        actions_channel=ACTIONS_CH,
                    )
                    log_event(LOG_STREAM, "wheel_strategy.py", "early_close_50pct",
                              symbol=contract,
                              details={"underlying": symbol, "entry": float(entry),
                                       "exit": current_price, "premium": premium_dollars,
                                       "contracts": contract_qty})
                    sym_state["current_contract"]     = None
                    sym_state["contract_entry_price"] = None
                    sym_state["last_action"] = f"Closed early: +${premium_dollars:.2f} ({contract_qty}× contracts). Selling new put."
                    _sell_new_put(symbol, sym_state, stock_price, account)
                else:
                    entry_str = f"${entry:.2f}" if entry is not None else "(unknown)"
                    pnl = (entry - current_price) * 100 if entry is not None else 0
                    log(f"[{symbol}] Stage 1 — monitoring {contract} @ ${current_price:.2f} (entry {entry_str}, unrealized +${pnl:.2f})")
                    sym_state["last_action"] = f"Monitoring {contract}: ${current_price:.2f} vs entry {entry_str}"
    else:
        _sell_new_put(symbol, sym_state, stock_price, account)


def _sell_new_put(symbol, sym_state, stock_price, account):
    """Find and sell the best cash-secured put for `symbol`.

    In modes with WHEEL_SKIP_NEW_PUTS (manual), this is a no-op — the bot
    only manages existing puts the user opened by hand, never opens new ones.
    """
    if WHEEL_SKIP_NEW_PUTS:
        log(f"[{symbol}] Manual mode — skipping new put entry (WHEEL_SKIP_NEW_PUTS).")
        sym_state["last_action"] = "Manual mode: not opening new puts (user-driven)."
        send_embed(
            ACTIONS_CH, f"Wheel: {symbol} — skipping new put (manual mode)",
            color=Color.BLUE,
            description="Stage 1 entry skipped; user opens puts manually. Bot will manage existing positions.",
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
            also_to_actions=False,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "manual_skip_new_put",
                  result="skipped",
                  details={"underlying": symbol, "stock_price": stock_price})
        return

    target_strike = round_strike(stock_price * (1 - PUT_STRIKE_PCT), stock_price)
    # Re-fetch options BP from Alpaca on every check rather than trusting
    # the cycle-start snapshot. Alpaca reserves MORE than `strike × 100`
    # for pending CSP orders (verified 2026-05-01: SOFI/PFE 403'd with
    # local snapshot showing $6,022 free but Alpaca actual was $0 after
    # BAC + XOM placed). Local-decrement-only kept drifting optimistic.
    # GET /v2/account is cheap (~50ms) and runs at most once per symbol.
    fresh = get_account()
    account.update(fresh)  # keep parent dict synced so callers see truth
    options_bp = float(fresh.get("options_buying_power", fresh.get("cash", 0)))
    cash_required = target_strike * 100

    if options_bp < cash_required:
        log(f"[{symbol}] INSUFFICIENT BP: need ${cash_required:,.0f}, have ${options_bp:,.0f}.")
        sym_state["last_action"] = "Insufficient options BP to sell put."
        # Insufficient BP is EXPECTED behavior — earlier symbols may have
        # consumed all available collateral (especially in aggressive mode
        # where the priority tier deliberately drains BP before fallback).
        # Route to the muted actions firehose so the event is still visible
        # but doesn't trip phone push. Result is "skipped" not "failure".
        send_embed(
            ACTIONS_CH, f"Wheel: Insufficient BP for {symbol} Put — skipped",
            color=Color.YELLOW,
            description=f"Need ${cash_required:,.0f}, have ${options_bp:,.0f}",
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
            also_to_actions=False,  # we ARE the actions channel — no double-post
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "insufficient_bp",
                  result="skipped",
                  details={"underlying": symbol, "need": cash_required, "have": options_bp})
        return

    contract = find_best_contract(symbol, "put", target_strike,
                                   PUT_EXPIRY_DAYS_MIN, PUT_EXPIRY_DAYS_MAX)
    if not contract:
        log(f"[{symbol}] No suitable put contract found.")
        sym_state["last_action"] = "No suitable put contract found."
        log_event(LOG_STREAM, "wheel_strategy.py", "no_put_contract_found",
                  result="failure",
                  details={"underlying": symbol, "target_strike": target_strike})
        return

    option_symbol = contract["symbol"]
    limit_price   = compute_limit_price(option_symbol, contract)

    order = place_sell_to_open(option_symbol, limit_price)
    # Decrement the local options_buying_power snapshot so the next symbol's
    # BP gate uses accurate data. Without this, a successful sell here leaves
    # the account dict showing the original BP, the next symbol's check
    # passes on stale data, and Alpaca rejects the order with HTTP 403.
    # (Bug observed 2026-04-30 16:09 UTC: 3 spurious 403 pings on aggressive.)
    # Alpaca reserves the full cash-secured collateral the moment the order is
    # accepted (well before fill), so subtracting cash_required here matches
    # what Alpaca's BP calculation does. Self-corrects every 10 min when the
    # next cron fire fetches fresh account state.
    account["options_buying_power"] = str(
        float(account.get("options_buying_power", account.get("cash", 0))) - cash_required
    )
    sym_state["current_contract"]      = option_symbol
    sym_state["contract_order_id"]     = order["id"]
    sym_state["contract_entry_price"]  = None  # will update once filled
    sym_state["contract_entry_date"]   = datetime.utcnow().isoformat() + "Z"
    sym_state["contract_expiration"]   = contract["expiration_date"]
    sym_state["contract_qty"]          = 1  # wheel always sells 1 put per cycle
    sym_state["contract_type"]         = "put"
    sym_state["contract_strike"]       = float(contract["strike_price"])
    log(f"[{symbol}] New put sold: {option_symbol} — strike ${contract['strike_price']}, exp {contract['expiration_date']}, limit ${limit_price:.2f}")
    send_embed(
        TRADES_CH, f"Wheel: Sold-to-Open {symbol} Put @ ${contract['strike_price']}",
        color=Color.YELLOW,
        description=f"Contract: {option_symbol}\nLimit: ${limit_price:.2f} (premium ≥ ${limit_price*100:.2f} if filled)",
        fields=[
            {"name": "Underlying", "value": symbol, "inline": True},
            {"name": "Strike", "value": f"${contract['strike_price']}", "inline": True},
            {"name": "Expiry", "value": contract["expiration_date"], "inline": True},
            {"name": f"{symbol} price", "value": f"${stock_price:.2f}", "inline": True},
            {"name": "Premium (if filled)", "value": f"${limit_price*100:.2f}", "inline": True},
            {"name": "Collateral held", "value": f"${float(contract['strike_price'])*100:,.0f}", "inline": True},
        ],
        footer=f"wheel_strategy.py · {MODE}",
        actions_channel=ACTIONS_CH,
    )
    sym_state["last_action"] = f"Sold-to-open {option_symbol} @ ${limit_price:.2f}. Awaiting fill."
    log_event(LOG_STREAM, "wheel_strategy.py", "sold_put",
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
            if status == "stale":
                # Pending CC > STALE_AFTER_HOURS — cancel and re-quote at fresh mid.
                # Same pattern as handle_stage1; we still hold the shares so
                # _sell_new_call can re-attempt against the existing cost basis.
                order_id = sym_state["contract_order_id"]
                age_hours = _order_age_hours(sym_state)
                log(f"[{symbol}] Stage 2 — call {contract} stale at {age_hours:.1f}h, cancelling.")
                if cancel_order(order_id):
                    sym_state["current_contract"]      = None
                    sym_state["contract_order_id"]     = None
                    sym_state["contract_entry_date"]   = None
                    sym_state["last_action"] = f"Cancelled stale call {contract} ({age_hours:.1f}h), placing fresh."
                    send_embed(
                        ACTIONS_CH,
                        f"Wheel: {symbol} call stale at {age_hours:.1f}h — cancelled, refilling",
                        color=Color.YELLOW,
                        description=f"Old: {contract}\nReplacing with fresh limit at current mid",
                        footer=f"wheel_strategy.py · {MODE}",
                        actions_channel=ACTIONS_CH,
                        also_to_actions=False,
                    )
                    log_event(LOG_STREAM, "wheel_strategy.py", "stale_order_cancelled",
                              result="success",
                              details={"underlying": symbol, "contract": contract,
                                       "age_hours": round(age_hours, 1), "stage": 2})
                    # Same-cycle replacement: re-sell against the same shares
                    _sell_new_call(symbol, sym_state, stock_price, cost_basis)
                else:
                    log(f"[{symbol}] cancel_order({order_id}) returned False — leaving state, will retry next cycle.")
                    sym_state["last_action"] = f"Cancel of stale {contract} FAILED; will retry."
                    log_event(LOG_STREAM, "wheel_strategy.py", "stale_order_cancel_failed",
                              result="failure",
                              details={"underlying": symbol, "contract": contract,
                                       "age_hours": round(age_hours, 1), "stage": 2})
                return

            stock_pos = get_stock_position(symbol)
            if not stock_pos or int(float(stock_pos.get("qty", 0))) < 100:
                # Shares called away — back to Stage 1.
                # Premium accounts for ALL contracts that were assigned (with
                # multi-contract sales we sold N calls; all N got assigned
                # together since they share an OCC symbol). state.shares_qty
                # captured during put assignment is the truth for "how many
                # contracts we had" — divide by 100 to get contract count.
                contracts_held   = max(1, (sym_state.get("shares_qty") or 100) // 100)
                premium_per_unit = sym_state.get("contract_entry_price", 0) or 0
                premium_dollars  = premium_per_unit * 100 * contracts_held
                sym_state["total_premium_collected"] = round(
                    sym_state["total_premium_collected"] + premium_dollars, 2
                )
                sym_state["total_premium_today"] = round(
                    sym_state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"[{symbol}] CALL ASSIGNED — {contracts_held}× contracts, shares sold @ ${sym_state['contract_strike']:.0f}. +${premium_dollars:.2f}")
                send_embed(
                    TRADES_CH, f"Wheel: {symbol} CALL ASSIGNED — {contracts_held}× contracts @ ${sym_state['contract_strike']:.0f}",
                    color=Color.GREEN,
                    description=f"+${premium_dollars:.2f} premium kept. Returning to Stage 1.",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "call_assigned",
                          symbol=contract,
                          details={"underlying": symbol, "strike": sym_state["contract_strike"],
                                   "premium": premium_dollars, "contracts": contracts_held})
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
                    "contracts": contracts_held,
                })
                sym_state["last_action"] = f"Call assigned ({contracts_held}× contracts). +${premium_dollars:.2f}. Restarting Stage 1."
                _sell_new_put(symbol, sym_state, stock_price, account)
            else:
                # Call expired worthless — sell another call.
                # Same multi-contract math: premium = entry × 100 × contracts.
                contracts_held   = max(1, (sym_state.get("shares_qty") or 100) // 100)
                premium_per_unit = sym_state.get("contract_entry_price", 0) or 0
                premium_dollars  = premium_per_unit * 100 * contracts_held
                sym_state["total_premium_collected"] = round(
                    sym_state["total_premium_collected"] + premium_dollars, 2
                )
                sym_state["total_premium_today"] = round(
                    sym_state.get("total_premium_today", 0) + premium_dollars, 2
                )
                log(f"[{symbol}] CALL EXPIRED WORTHLESS — {contracts_held}× contracts, +${premium_dollars:.2f}.")
                send_embed(
                    TRADES_CH, f"Wheel: {symbol} Call Expired Worthless — kept ${premium_dollars:.2f} ({contracts_held}× contracts)",
                    color=Color.GREEN,
                    description=f"{contract}\nTotal {symbol} premium: ${sym_state['total_premium_collected']:.2f}",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "call_expired_worthless",
                          symbol=contract,
                          details={"underlying": symbol, "premium": premium_dollars,
                                   "total_premium": sym_state["total_premium_collected"],
                                   "contracts": contracts_held})
                sym_state["current_contract"]     = None
                sym_state["contract_entry_price"] = None
                sym_state["last_action"] = f"Call expired worthless ({contracts_held}× contracts). +${premium_dollars:.2f}. Selling new call."
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
                    # place_buy_to_close auto-detects qty so it'll close all
                    # contracts on this OCC symbol regardless of how many.
                    place_buy_to_close(contract, current_price)
                    contracts_held  = max(1, (sym_state.get("shares_qty") or 100) // 100)
                    premium_dollars = (entry - current_price) * 100 * contracts_held
                    sym_state["total_premium_collected"] = round(
                        sym_state["total_premium_collected"] + premium_dollars, 2
                    )
                    sym_state["total_premium_today"] = round(
                        sym_state.get("total_premium_today", 0) + premium_dollars, 2
                    )
                    send_embed(
                        TRADES_CH, f"Wheel: {symbol} Early Close Call at 50% Profit — +${premium_dollars:.2f} ({contracts_held}× contracts)",
                        color=Color.GREEN,
                        description=f"{contract}\nClosed @ ${current_price:.2f} (entry ${entry:.2f})",
                        footer=f"wheel_strategy.py · {MODE}",
                        actions_channel=ACTIONS_CH,
                    )
                    log_event(LOG_STREAM, "wheel_strategy.py", "early_close_call_50pct",
                              symbol=contract,
                              details={"underlying": symbol, "entry": float(entry),
                                       "exit": current_price, "premium": premium_dollars,
                                       "contracts": contracts_held})
                    sym_state["current_contract"]     = None
                    sym_state["contract_entry_price"] = None
                    sym_state["last_action"] = f"Closed early: +${premium_dollars:.2f} ({contracts_held}× contracts). Selling new call."
                    _sell_new_call(symbol, sym_state, stock_price, cost_basis)
                else:
                    entry_str = f"${entry:.2f}" if entry is not None else "(unknown)"
                    pnl = (entry - current_price) * 100 if entry is not None else 0
                    log(f"[{symbol}] Stage 2 — monitoring {contract} @ ${current_price:.2f} (entry {entry_str}, unrealized +${pnl:.2f})")
                    sym_state["last_action"] = f"Monitoring {contract}: ${current_price:.2f} vs entry {entry_str}"
    else:
        _sell_new_call(symbol, sym_state, stock_price, cost_basis)


def _sell_new_call(symbol, sym_state, stock_price, cost_basis):
    """Find and sell covered calls — one contract per 100 shares held.

    If the wheel is sitting on 100 shares, sells 1 call. With 400 shares
    (the MARA quad-assignment scenario), sells 4 calls of the same OCC
    symbol so every share is covered. Pulls the actual share count from
    state.shares_qty (which was captured fresh from Alpaca on assignment).
    """
    if cost_basis is None:
        log(f"[{symbol}] No cost basis recorded — cannot sell call.")
        return

    shares_qty = sym_state.get("shares_qty", 0) or 0
    contracts_to_sell = shares_qty // 100  # 1 call covers 100 shares
    if contracts_to_sell < 1:
        log(f"[{symbol}] Only {shares_qty} shares — need 100+ to sell a covered call. Skipping.")
        sym_state["last_action"] = f"Cannot sell call: {shares_qty} shares < 100"
        return

    target_strike = round_strike(cost_basis * (1 + CALL_STRIKE_PCT), cost_basis)
    if target_strike < cost_basis:
        target_strike = round_strike(cost_basis, cost_basis) + strike_increment(cost_basis)
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
    limit_price   = compute_limit_price(option_symbol, contract)

    order = place_sell_to_open(option_symbol, limit_price, qty=contracts_to_sell)
    sym_state["current_contract"]      = option_symbol
    sym_state["contract_order_id"]     = order["id"]
    sym_state["contract_entry_price"]  = None
    sym_state["contract_entry_date"]   = datetime.utcnow().isoformat() + "Z"
    sym_state["contract_expiration"]   = contract["expiration_date"]
    sym_state["contract_type"]         = "call"
    sym_state["contract_strike"]       = float(contract["strike_price"])
    sym_state["contract_qty"]          = contracts_to_sell  # 1 call per 100 shares
    log(f"[{symbol}] New call sold: {contracts_to_sell}× {option_symbol} — strike ${contract['strike_price']}, exp {contract['expiration_date']}, limit ${limit_price:.2f}")
    send_embed(
        TRADES_CH, f"Wheel: Sold-to-Open {contracts_to_sell}× {symbol} Call @ ${contract['strike_price']}",
        color=Color.YELLOW,
        description=f"Contract: {option_symbol}\nLimit: ${limit_price:.2f} per contract (total premium ≥ ${limit_price*100*contracts_to_sell:.2f} if filled)",
        fields=[
            {"name": "Underlying",        "value": symbol,                                    "inline": True},
            {"name": "Strike",            "value": f"${contract['strike_price']}",            "inline": True},
            {"name": "Expiry",            "value": contract["expiration_date"],               "inline": True},
            {"name": "Cost basis",        "value": f"${cost_basis:.2f}",                      "inline": True},
            {"name": "Contracts",         "value": f"{contracts_to_sell} (covering {shares_qty} shares)", "inline": True},
            {"name": "Premium (if filled)", "value": f"${limit_price*100*contracts_to_sell:.2f}", "inline": True},
        ],
        footer=f"wheel_strategy.py · {MODE}",
        actions_channel=ACTIONS_CH,
    )
    sym_state["last_action"] = f"Sold-to-open {contracts_to_sell}× {option_symbol} @ ${limit_price:.2f}. Awaiting fill."
    log_event(LOG_STREAM, "wheel_strategy.py", "sold_call",
              symbol=option_symbol,
              details={"underlying": symbol, "strike": float(contract["strike_price"]),
                       "expiry": contract["expiration_date"], "limit_price": limit_price,
                       "cost_basis": cost_basis, "qty": contracts_to_sell,
                       "shares_covered": shares_qty},
              alpaca_order_id=order["id"])


# ── Top-level orchestration ───────────────────────────────────────────────

def _parse_occ(occ: str):
    """Parse OCC option symbol → (ticker, side, strike, expiry_date) or None."""
    for i, c in enumerate(occ):
        if c.isdigit():
            ticker, rest = occ[:i], occ[i:]
            break
    else:
        return None
    if len(rest) != 15:
        return None
    try:
        from datetime import date as _date
        yy = int(rest[0:2]); mm = int(rest[2:4]); dd = int(rest[4:6])
        side = rest[6]
        strike = int(rest[7:15]) / 1000.0
        expiry = _date(2000 + yy, mm, dd)
    except (ValueError, ImportError):
        return None
    if side not in ("C", "P"):
        return None
    return ticker, "put" if side == "P" else "call", strike, expiry


def _detect_spread_pairs(positions) -> dict:
    """Group short+long option legs into SpreadPair records.

    Returns dict[ticker] -> list[SpreadPair]. Only credit spreads are
    detected:
      - put_credit:  short put strike > long put strike
      - call_credit: short call strike < long call strike

    Legs are paired when they share underlying, expiration, and option
    type (both P or both C), have opposite sides, and strike geometry
    matches a credit-spread shape.

    If multiple shorts or longs exist on the same underlying/expiry/type
    (e.g., a butterfly or a stack of two spreads), only the first
    short+long pair with matching qty is consumed; remaining legs are
    returned to single-leg adoption by _discover_wheel_state.
    """
    by_key: dict = {}
    for pos in positions:
        if pos.get("asset_class") != "us_option":
            continue
        try:
            symbol = pos["symbol"]
            qty = int(float(pos["qty"]))
        except (KeyError, ValueError, TypeError):
            continue
        parsed = _parse_occ(symbol)
        if not parsed:
            continue
        ticker, opt_type, strike, expiry = parsed
        if qty == 0:
            continue
        key = (ticker, opt_type, expiry)
        bucket = by_key.setdefault(key, {"shorts": [], "longs": []})
        leg = {
            "occ": symbol,
            "strike": strike,
            "qty": abs(qty),
            "entry": abs(float(pos.get("avg_entry_price", 0))),
        }
        if qty < 0:
            bucket["shorts"].append(leg)
        else:
            bucket["longs"].append(leg)

    pairs: dict = {}
    for (ticker, opt_type, expiry), bucket in by_key.items():
        shorts = bucket["shorts"]
        longs  = bucket["longs"]
        if not shorts or not longs:
            continue
        # Greedy pair: match each short with the long whose strike forms
        # a credit spread (long below short strike for puts, above for calls)
        # and whose qty matches. First match wins per short.
        for s in shorts:
            for l in longs:
                if l.get("_paired"):
                    continue
                if l["qty"] != s["qty"]:
                    continue
                if opt_type == "put":
                    if not (l["strike"] < s["strike"]):
                        continue
                    spread_type = "put_credit"
                else:  # call
                    if not (l["strike"] > s["strike"]):
                        continue
                    spread_type = "call_credit"
                width = abs(s["strike"] - l["strike"])
                net_credit = round(s["entry"] - l["entry"], 4)
                max_loss = round(width - net_credit, 4)
                sp = SpreadPair(
                    ticker=ticker,
                    spread_type=spread_type,
                    short_occ=s["occ"],
                    long_occ=l["occ"],
                    short_strike=s["strike"],
                    long_strike=l["strike"],
                    expiration=expiry,
                    short_qty=s["qty"],
                    long_qty=l["qty"],
                    short_entry=s["entry"],
                    long_entry=l["entry"],
                    width=width,
                    net_credit=net_credit,
                    max_loss=max_loss,
                )
                pairs.setdefault(ticker, []).append(sp)
                l["_paired"] = True
                s["_paired"] = True
                break
    return pairs


def _adopt_spread(state: dict, sp: SpreadPair) -> None:
    """Seed state[ticker] for a discovered spread.

    Idempotent: returns without touching state if the same spread is
    already adopted (matching short_occ AND long_occ), preserving
    cycle_count and cycle_history across cycles.
    """
    existing = state.get(sp.ticker, {})
    already_adopted = (
        existing.get("stage") == "spread_active"
        and existing.get("short_leg", {}).get("occ") == sp.short_occ
        and existing.get("long_leg",  {}).get("occ") == sp.long_occ
    )
    if already_adopted:
        return

    state[sp.ticker] = _empty_spread_state()
    sym = state[sp.ticker]
    sym["spread_type"] = sp.spread_type
    sym["short_leg"] = {
        "occ": sp.short_occ, "strike": sp.short_strike,
        "entry_premium": round(sp.short_entry, 4), "qty": sp.short_qty,
    }
    sym["long_leg"] = {
        "occ": sp.long_occ, "strike": sp.long_strike,
        "entry_premium": round(sp.long_entry, 4), "qty": sp.long_qty,
    }
    sym["expiration"] = sp.expiration.isoformat()
    sym["net_credit"] = sp.net_credit
    sym["max_loss"] = sp.max_loss
    sym["width"] = sp.width
    sym["opened_at"] = datetime.utcnow().isoformat() + "Z"
    sym["last_action"] = (
        f"Adopted spread short=${sp.short_strike:.2f} "
        f"long=${sp.long_strike:.2f} credit=${sp.net_credit:.2f}"
    )


def _discover_wheel_state(state: dict) -> set:
    """Build the set of underlyings the wheel should manage this cycle.

    Returns the union of:
      - underlyings of every short option position (puts → Stage 1 mgmt;
        calls → user pre-sold a CC, treat as Stage 2)
      - underlyings the user holds ≥100 shares of (Stage 2 candidates)
      - any symbol already tracked in state with a current contract
        (don't lose track of in-flight positions mid-cycle)

    Side effect: for any newly-discovered position, populates state[symbol]
    with adopted contract metadata so handle_stage1/handle_stage2 can run.
    """
    discovered: set = set()
    positions = get_positions()

    # Tracked-in-state symbols stay in scope so we don't drop a symbol
    # mid-cycle just because Alpaca hasn't synced yet.
    for sym, ss in state.items():
        if sym.startswith("_"):
            continue
        if ss.get("current_contract") or int(ss.get("shares_qty", 0)) >= 100:
            discovered.add(sym)

    for pos in positions:
        asset_class = pos.get("asset_class")
        symbol = pos["symbol"]

        if asset_class == "us_equity":
            qty = int(float(pos["qty"]))
            if qty >= 100:
                discovered.add(symbol)
            continue

        if asset_class != "us_option":
            continue

        # Only short option positions are wheel material
        qty_int = int(float(pos["qty"]))
        if qty_int >= 0:
            continue

        parsed = _parse_occ(symbol)
        if not parsed:
            log(f"[wheel-discover] could not parse OCC symbol {symbol} — skipping")
            continue
        ticker, opt_type, strike, expiry = parsed
        discovered.add(ticker)

        sym_state = state.setdefault(ticker, _empty_symbol_state())
        # If we've already adopted this OCC symbol, leave state alone.
        if sym_state.get("current_contract") == symbol:
            continue

        # Adopt: seed state from the position so existing handlers can run.
        # Premium received per share = abs(avg_entry_price). For options,
        # Alpaca's avg_entry_price is the per-share fill (negative for shorts).
        entry_per_share = abs(float(pos.get("avg_entry_price", 0)))
        contracts = abs(qty_int)

        sym_state["current_contract"]     = symbol
        sym_state["contract_order_id"]    = sym_state.get("contract_order_id")  # unknown for adopted
        sym_state["contract_entry_price"] = round(entry_per_share, 4)
        sym_state["contract_entry_date"]  = sym_state.get("contract_entry_date") or datetime.utcnow().isoformat() + "Z"
        sym_state["contract_expiration"]  = expiry.isoformat()
        sym_state["contract_type"]        = opt_type
        sym_state["contract_strike"]      = strike
        sym_state["contract_qty"]         = contracts

        if opt_type == "put":
            sym_state["stage"] = 1
            sym_state["last_action"] = f"Adopted manual put {symbol} @ ${entry_per_share:.2f} ({contracts}× contracts)"
        else:
            # User pre-sold a covered call. Move to Stage 2 and capture cost basis.
            sym_state["stage"] = 2
            stock_pos = get_stock_position(ticker)
            if stock_pos:
                sym_state["shares_qty"]           = int(float(stock_pos["qty"]))
                sym_state["cost_basis_per_share"] = abs(float(stock_pos["avg_entry_price"]))
                sym_state["total_cost"]           = sym_state["cost_basis_per_share"] * sym_state["shares_qty"]
            sym_state["last_action"] = f"Adopted manual covered call {symbol} @ ${entry_per_share:.2f} ({contracts}× contracts)"

        send_embed(
            TRADES_CH, f"Wheel: adopted manual {opt_type} {ticker}",
            color=Color.BLUE,
            description=(
                f"Now managing {contracts}× {symbol} @ ${entry_per_share:.2f}/share. "
                f"Stage {sym_state['stage']}."
            ),
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "adopted_manual_position",
                  symbol=symbol,
                  details={"underlying": ticker, "type": opt_type, "strike": strike,
                           "expiry": expiry.isoformat(), "contracts": contracts,
                           "entry_premium": entry_per_share})

    return discovered


def run_wheel():
    """One cycle: iterate every symbol in SYMBOLS, handle independently."""
    global SYMBOLS
    try:
        state = load_state()

        # Manual mode: build SYMBOLS from live Alpaca positions instead of
        # the static list. Adopts any user-opened option/share positions
        # the wheel hasn't seen yet so handle_stage1/handle_stage2 work
        # without modification.
        if AUTO_DISCOVER_SYMBOLS:
            discovered = _discover_wheel_state(state)
            SYMBOLS = sorted(discovered)
            log(f"Auto-discovered {len(SYMBOLS)} wheel symbols: {', '.join(SYMBOLS) if SYMBOLS else '(none)'}")
            if not SYMBOLS:
                log("No wheel-relevant positions held — manual wheel cycle is a no-op.")
                save_state(state)
                log_event(LOG_STREAM, "wheel_strategy.py", "no_positions",
                          result="skipped", details={"mode": MODE})
                return

        if not is_market_open():
            log(f"Market closed — skipping wheel cycle for all {len(SYMBOLS)} symbols.")
            log_event(LOG_STREAM, "wheel_strategy.py", "cycle_skipped_market_closed",
                      result="skipped",
                      details={"symbols": SYMBOLS})
            return

        account = get_account()

        # NOTE — symbol order is fill priority. The wheel iterates SYMBOLS
        # sequentially and consumes BP as it places put orders, so symbols
        # listed earlier in the list get first claim on the account's cash.
        # In aggressive mode the order intentionally puts the high-IV tier
        # (COIN/MARA/RIOT/SMCI/NVDA/AMD/MU) before the baseline fallback
        # tier (TSLA/BAC/XOM/etc.). To change the order, edit
        # CONSERVATIVE_SYMBOLS or AGGRESSIVE_SYMBOLS in config.py.
        for symbol in SYMBOLS:
            sym_state = state.setdefault(symbol, _empty_symbol_state())
            try:
                stock_price = get_latest_price(symbol)
                log(f"[{symbol}] ${stock_price:.2f} | Stage {sym_state['stage']} | premium ${sym_state['total_premium_collected']:.2f} | contract {sym_state.get('current_contract') or 'none'}")

                if sym_state["stage"] == 1:
                    handle_stage1(symbol, sym_state, stock_price, account)
                elif sym_state["stage"] == 2:
                    handle_stage2(symbol, sym_state, stock_price, account)

                log_event(LOG_STREAM, "wheel_strategy.py", "symbol_cycle_complete",
                          result="success",
                          details={"underlying": symbol, "stage": sym_state["stage"],
                                   "contract": sym_state.get("current_contract"),
                                   "stock_price": stock_price})
            except Exception as e:
                # Per-symbol error isolation: one bad symbol doesn't kill others.
                log(f"[{symbol}] error in wheel cycle: {type(e).__name__}: {e}")

                # Special case: Alpaca returns HTTP 403 on POST /orders when
                # the account doesn't have enough buying power for the option
                # order. Their real-time check reserves more than our local
                # `strike × 100` formula, so we can pass our BP gate and still
                # get rejected. Belt-and-suspenders: with fix A the local
                # check is now BP-fresh per symbol, so this should be rare —
                # but if it does fire, treat it as "BP exhausted, stop trying
                # remaining symbols this cycle" instead of spamming #errors
                # with one ping per leftover symbol.
                is_bp_exhaustion = (
                    isinstance(e, requests.exceptions.HTTPError)
                    and getattr(e.response, "status_code", None) == 403
                )
                if is_bp_exhaustion:
                    send_embed(
                        ACTIONS_CH, f"Wheel: BP exhausted at {symbol} — skipping remaining symbols this cycle",
                        color=Color.YELLOW,
                        description=(
                            "Alpaca rejected the order with HTTP 403 — its real-time "
                            "BP check is more conservative than our local snapshot. "
                            "Stopping cycle here; next cron fire will retry with fresh state."
                        ),
                        footer=f"wheel_strategy.py · {MODE}",
                        actions_channel=ACTIONS_CH,
                        also_to_actions=False,
                    )
                    log_event(LOG_STREAM, "wheel_strategy.py", "bp_exhausted_short_circuit",
                              result="skipped",
                              notes=f"{symbol}: 403 from Alpaca; remaining symbols skipped this cycle")
                    break  # short-circuit the for-loop over SYMBOLS

                send_embed(
                    ERRORS_CH, f"wheel_strategy.py — {symbol} cycle crashed",
                    color=Color.RED,
                    description=f"`{type(e).__name__}: {str(e)[:500]}`",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "symbol_exception",
                          result="failure",
                          notes=f"{symbol}: {type(e).__name__}: {str(e)[:500]}")

        save_state(state)
        log_event(LOG_STREAM, "wheel_strategy.py", "cycle_complete",
                  result="success",
                  details={"symbols": SYMBOLS})
    except Exception as e:
        send_embed(
            ERRORS_CH, "wheel_strategy.py — run_wheel crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "exception",
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
            SUMMARY_CH, f"Daily Wheel Summary — {datetime.now().strftime('%Y-%m-%d')}",
            color=Color.BLUE,
            fields=[
                {"name": "Premium today (all symbols)", "value": f"${total_today:.2f}", "inline": True},
                {"name": "Total premium", "value": f"${total_premium:.2f}", "inline": True},
                {"name": "Total cycles", "value": str(total_cycles), "inline": True},
                {"name": "Account cash", "value": f"${float(account['cash']):,.2f}", "inline": True},
                {"name": "Portfolio value", "value": f"${float(account['portfolio_value']):,.2f}", "inline": True},
                {"name": "By symbol", "value": "```\n" + "\n".join(per_symbol_lines) + "\n```", "inline": False},
            ],
            footer=f"wheel_strategy.py — daily summary · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "daily_summary",
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
            ERRORS_CH, "wheel_strategy.py — run_daily_summary crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


if __name__ == "__main__":
    import sys
    # Parse --mode and switch globals BEFORE running anything.
    selected_mode, remaining = config.parse_mode_arg(sys.argv[1:])
    apply_mode(selected_mode)

    cmd = remaining[0] if remaining else "loop"
    if cmd == "summary":
        run_daily_summary()
    elif cmd == "once":
        run_wheel()
    else:
        while True:
            run_wheel()
            time.sleep(POLL_INTERVAL)
