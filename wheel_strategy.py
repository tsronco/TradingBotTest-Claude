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
import screener_core
import earnings
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
SPREAD_MANAGEMENT      = False  # manual mode (Phase 2): manage adopted spreads
SPREAD_EARLY_CLOSE_PCT = 0.50  # populated from config in apply_mode (Task 10)
SPREAD_STOP_LOSS_PCT   = 0.50
SPREAD_DTE_FLOOR       = 2
AUTO_OPEN_SPREADS      = False  # SM modes (Phase 4): autonomous spread opener
SPREAD_OPEN_MIN_LIMIT = 0.01  # floor for the opening mleg limit credit so a
                              # thin/negative natural bid still posts a 1-cent
                              # credit order (stale path cancels it if it never
                              # fills) rather than flipping to a debit.


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
    global SPREAD_MANAGEMENT, SPREAD_EARLY_CLOSE_PCT, SPREAD_STOP_LOSS_PCT, SPREAD_DTE_FLOOR
    global AUTO_OPEN_SPREADS

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

    SPREAD_MANAGEMENT      = cfg.get("spread_management", False)
    SPREAD_EARLY_CLOSE_PCT = cfg.get("spread_early_close_pct", 0.50)
    SPREAD_STOP_LOSS_PCT   = cfg.get("spread_stop_loss_pct", 0.50)
    SPREAD_DTE_FLOOR       = cfg.get("spread_dte_floor", 2)

    AUTO_OPEN_SPREADS      = cfg.get("auto_open_spreads", False)


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
        # Bot-opened spreads only: id of the mleg open order + the credit
        # the marketable limit was placed at. Adopted/hand-opened spreads
        # leave these None so _resolve_pending_spread short-circuits to
        # "gone" and the existing position/orphan path runs unchanged.
        "open_order_id": None,
        "open_limit_credit": None,
        "total_premium_collected": 0.0,
        "cycle_count": 0,
        "cycle_history": [],
        "last_action": "",
    }


# ── Spread management (Phase 2) ──────────────────────────────────────────

def _compute_spread_pnl(sym_state: dict, close_cost: float) -> dict:
    """Compute spread P&L from the EXECUTABLE cost to buy-to-close.

    `close_cost` must be the price the spread can actually be closed at
    right now — for a put credit spread that is `short_ask - long_bid`
    (you pay the short's ask to buy it back, receive the long's bid to
    sell it). Deciding on mids instead overstates profit on illiquid,
    wide-bid/ask options and caused a false "50% profit" close that
    realized a loss (F sm500 2026-05-18).

    Args:
      sym_state: state dict with shape from _empty_spread_state, must have
                 `net_credit` and `max_loss` populated.
      close_cost: executable cost-to-close per share (short_ask - long_bid).

    Returns:
      dict with keys:
        current_value:  executable cost-to-close per share.
        profit_pct:     fraction of credit captured. Positive when winning,
                        negative when losing. 0.50 means half the credit
                        has been captured (50% profit close trigger).
        loss_per_share: current loss in $/share. Positive when losing,
                        negative when winning. Compare against
                        max_loss * stop_loss_pct for stop-out check.
    """
    net_credit = float(sym_state["net_credit"])
    current_value = close_cost
    profit_pct = (net_credit - current_value) / net_credit if net_credit > 0 else 0.0
    loss_per_share = current_value - net_credit
    return {
        "current_value": round(current_value, 4),
        "profit_pct": round(profit_pct, 4),
        "loss_per_share": round(loss_per_share, 4),
    }


def _close_spread_mleg(sym_state: dict) -> bool:
    """Submit an Alpaca multi-leg buy-to-close order for the spread.

    Returns True on success, False on any failure (rejection, network,
    timeout). The caller (_close_spread) decides whether to fall back
    to two individual orders.

    qty is in spread units (number of spreads), not per-leg. ratio_qty
    is the per-spread leg multiplier — always "1" for vertical spreads.
    """
    try:
        short_occ = sym_state["short_leg"]["occ"]
        long_occ  = sym_state["long_leg"]["occ"]
        qty       = sym_state["short_leg"]["qty"]  # short and long match by definition
        order = api_post("/orders", {
            "order_class":   "mleg",
            "qty":           str(qty),
            "type":          "market",
            "time_in_force": "day",
            "legs": [
                {"symbol": short_occ, "side": "buy",  "ratio_qty": "1", "position_intent": "buy_to_close"},
                {"symbol": long_occ,  "side": "sell", "ratio_qty": "1", "position_intent": "sell_to_close"},
            ],
        })
        log(f"Spread mleg close placed: short={short_occ} long={long_occ} qty={qty} — order {order.get('id', '?')}")
        return True
    except Exception as e:
        log(f"_close_spread_mleg failed: {type(e).__name__}: {e}")
        return False


def _close_spread_legs_individually(sym_state: dict) -> bool:
    """Fallback close path: place two separate single-leg orders.

    Order is critical:
      1. Buy-to-close the SHORT leg first (eliminates assignment risk)
      2. Sell-to-close the LONG leg

    If step 1 fails, return False without touching state — next cycle
    retries from handle_spread's top.

    If step 1 succeeds but step 2 fails, the spread is in a half-closed
    state: short is gone, long is orphaned. Mark short_leg.qty=0 so the
    next cycle's _handle_orphan_leg sees "long present, short missing"
    and closes the survivor.

    Limit prices: midpoint from get_option_quote if available, otherwise
    the entry premium as a fallback (better than no order at all).
    """
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]
    short_entry = sym_state["short_leg"]["entry_premium"]
    long_entry  = sym_state["long_leg"]["entry_premium"]

    def _mid_or_entry(occ: str, entry: float) -> float:
        q = get_option_quote(occ)
        if q:
            return round((q["bid"] + q["ask"]) / 2, 2)
        return entry

    short_limit = _mid_or_entry(short_occ, short_entry)
    long_limit  = _mid_or_entry(long_occ,  long_entry)

    # Step 1: close the short leg
    try:
        place_buy_to_close(short_occ, short_limit)
    except Exception as e:
        log(f"_close_spread_legs_individually: BTC failed on {short_occ}: {type(e).__name__}: {e}")
        send_embed(
            ERRORS_CH, f"Spread close failed (short leg) {sym_state.get('spread_type', '?')}",
            color=Color.RED,
            description=(
                f"BTC of short leg `{short_occ}` failed: {e}. "
                f"Spread is intact; next cycle will retry."
            ),
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        return False

    # Step 2: close the long leg
    try:
        place_sell_to_close(long_occ, long_limit)
    except Exception as e:
        log(f"_close_spread_legs_individually: STC failed on {long_occ}: {type(e).__name__}: {e}")
        # Half-closed: mark short as gone so orphan handler picks up the long
        sym_state["short_leg"]["qty"] = 0
        send_embed(
            ERRORS_CH, f"Spread close ORPHANED",
            color=Color.RED,
            description=(
                f"Short leg `{short_occ}` closed successfully, but STC of "
                f"long leg `{long_occ}` failed: {e}. "
                f"Next cycle's orphan handler will retry the long-leg close."
            ),
            footer=f"wheel_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        return False

    return True


def _close_spread(state: dict, ticker: str, reason: str) -> None:
    """Orchestrate a spread close: try mleg first, fall back to two singles.

    On success:
      - Delete state[ticker] entirely (clean removal; not preserved like
        single-leg wheel cycles which keep cycle_history).
      - Fire #trades embed (color depends on reason).
      - Mirror to #actions.
      - JSONL `spread_closed` event with reason and close details.

    On failure of BOTH paths:
      - Leave state intact (next cycle retries).
      - Error embed already surfaced by _close_spread_legs_individually.

    Reasons:
      - "early_close_50pct" → green, "closed spread … at 50% profit"
      - "stop_loss_50pct"   → yellow, "stopped out spread …"
      - "dte_floor_itm"     → yellow, "closed spread … near expiration (ITM risk)"
    """
    sym_state = state[ticker]
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]

    used_fallback = False
    if _close_spread_mleg(sym_state):
        success = True
    else:
        used_fallback = True
        success = _close_spread_legs_individually(sym_state)

    if not success:
        # Error already surfaced by the fallback path; leave state alone.
        return

    # Map reason → presentation
    title_map = {
        "early_close_50pct": f"✅ Spread closed (50% profit) — {ticker}",
        "stop_loss_50pct":   f"🛑 Spread stopped out — {ticker}",
        "dte_floor_itm":     f"⏰ Spread closed (DTE floor, ITM) — {ticker}",
    }
    color_map = {
        "early_close_50pct": Color.GREEN,
        "stop_loss_50pct":   Color.YELLOW,
        "dte_floor_itm":     Color.YELLOW,
    }
    reason_text = {
        "early_close_50pct": "bought to close at 50% of credit captured",
        "stop_loss_50pct":   "bought to close at 50% of max loss (stop)",
        "dte_floor_itm":     "bought to close — ≤2 DTE, short leg ITM",
    }
    title = title_map.get(reason, f"✅ Spread closed — {ticker}")
    color = color_map.get(reason, Color.YELLOW)

    width = sym_state.get("width") or round(
        abs((sym_state["short_leg"]["strike"] or 0)
            - (sym_state["long_leg"]["strike"] or 0)), 4
    )
    footer = f"wheel_strategy.py · {MODE}"
    send_embed(
        TRADES_CH, title, color=color,
        description=(
            f"{sym_state['spread_type'].replace('_', ' ')} · "
            f"{reason_text.get(reason, 'closed')}"
        ),
        fields=_spread_embed_fields(
            sym_state["short_leg"]["strike"], sym_state["long_leg"]["strike"],
            width, sym_state["net_credit"], sym_state["max_loss"],
            sym_state.get("expiration") or "",
        ),
        footer=footer, actions_channel=ACTIONS_CH,
    )

    if used_fallback:
        send_embed(
            ACTIONS_CH, f"Spread close used fallback path ({ticker})",
            color=Color.BLUE,
            description=(
                f"mleg order was rejected; used fallback path and closed "
                f"legs individually. Spread on {ticker} is fully closed."
            ),
            footer=footer,
        )

    log_event(LOG_STREAM, "wheel_strategy.py", "spread_closed",
              symbol=ticker,
              details={
                  "reason": reason,
                  "spread_type": sym_state["spread_type"],
                  "short_occ": short_occ,
                  "long_occ":  long_occ,
                  "net_credit": sym_state["net_credit"],
                  "max_loss": sym_state["max_loss"],
                  "fallback_used": used_fallback,
              })

    del state[ticker]


def _handle_orphan_leg(state: dict, ticker: str, positions: list) -> None:
    """Resolve a spread half-state.

    Called by handle_spread when state[ticker]["stage"] == "spread_active"
    but Alpaca's positions show only one (or neither) leg.

    Behaviors:
      - Short missing, long present → STC the long; delete state.
      - Long missing, short present → BTC the short; delete state.
      - Both missing → delete state; no orders.
      - Both present → no-op (caller should not have called this).
    """
    sym_state = state[ticker]
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]

    occs_present = {p["symbol"] for p in positions
                    if p.get("asset_class") == "us_option"}
    short_present = short_occ in occs_present
    long_present  = long_occ  in occs_present

    if short_present and long_present:
        return  # caller error; nothing to do here

    def _mid_or_entry(occ: str, entry: float) -> float:
        q = get_option_quote(occ)
        if q:
            return round((q["bid"] + q["ask"]) / 2, 2)
        return entry

    if short_present and not long_present:
        # Long leg gone (expired alone, manually closed, etc.) — BTC the short
        try:
            place_buy_to_close(short_occ, _mid_or_entry(short_occ, sym_state["short_leg"]["entry_premium"]))
            description = (
                f"Long leg gone from Alpaca; bought-to-close remaining short "
                f"`{short_occ}` to clean up the orphan."
            )
            send_embed(TRADES_CH, f"🩹 Spread half-state resolved — {ticker}",
                       color=Color.YELLOW, description=description,
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
            log_event(LOG_STREAM, "wheel_strategy.py", "spread_orphan_resolved",
                      symbol=ticker,
                      details={"surviving_leg": "short", "occ": short_occ})
            del state[ticker]
        except Exception as e:
            log(f"_handle_orphan_leg short BTC failed: {type(e).__name__}: {e}")
            send_embed(ERRORS_CH, f"Orphan resolution failed for {ticker}",
                       color=Color.RED,
                       description=f"BTC of {short_occ} failed: {e}. State left intact for retry.",
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
        return

    if long_present and not short_present:
        # Short leg gone (assigned overnight, etc.) — STC the long
        try:
            place_sell_to_close(long_occ, _mid_or_entry(long_occ, sym_state["long_leg"]["entry_premium"]))
            description = (
                f"Short leg gone from Alpaca; sold-to-close remaining long "
                f"`{long_occ}` to clean up the orphan."
            )
            send_embed(TRADES_CH, f"🩹 Spread half-state resolved — {ticker}",
                       color=Color.YELLOW, description=description,
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
            log_event(LOG_STREAM, "wheel_strategy.py", "spread_orphan_resolved",
                      symbol=ticker,
                      details={"surviving_leg": "long", "occ": long_occ})
            del state[ticker]
        except Exception as e:
            log(f"_handle_orphan_leg long STC failed: {type(e).__name__}: {e}")
            send_embed(ERRORS_CH, f"Orphan resolution failed for {ticker}",
                       color=Color.RED,
                       description=f"STC of {long_occ} failed: {e}. State left intact for retry.",
                       footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
        return

    # Both missing — no orders, just clear state
    send_embed(TRADES_CH, f"🏁 Spread fully closed externally — {ticker}",
               color=Color.YELLOW,
               description=(
                   f"Both legs of the spread on {ticker} are gone from Alpaca "
                   f"(fully closed externally). State cleared; no orders placed."
               ),
               footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
    log_event(LOG_STREAM, "wheel_strategy.py", "spread_orphan_resolved",
              symbol=ticker, details={"surviving_leg": "none"})
    del state[ticker]


def handle_spread(state: dict, ticker: str, account: dict) -> None:
    """Per-cycle decision function for an active spread.

    Mirror of handle_stage1 / handle_stage2. Called by run_wheel when
    state[ticker]["stage"] == "spread_active" and SPREAD_MANAGEMENT is True.

    Decision order (first trigger wins):
      1. Both legs gone or only one present → _handle_orphan_leg → return
      2. profit_pct >= early_close_pct       → _close_spread early_close_50pct
      3. loss >= max_loss * stop_loss_pct    → _close_spread stop_loss_50pct
      4. DTE <= dte_floor AND short leg ITM  → _close_spread dte_floor_itm
      5. otherwise                           → log heartbeat, no state change
    """
    sym_state = state[ticker]

    # Pending-fill resolution MUST precede the position-based orphan check.
    # A bot-opened spread whose mleg order has not filled yet has NO leg
    # positions; without this guard the orphan check below misreads
    # "not filled yet" as "closed externally", deletes state, and the
    # opener immediately re-opens (the infinite 10-min loop / stacked
    # orders observed on sm2000 2026-05-18). Adopted/hand-opened spreads
    # carry open_order_id=None and fall straight through unchanged.
    if sym_state.get("open_order_id"):
        pstatus = _resolve_pending_spread(sym_state)
        if pstatus == "pending":
            log(f"[{ticker}] spread open order {sym_state['open_order_id']} "
                f"pending fill — skipping cycle")
            sym_state["last_action"] = (
                f"Awaiting fill on spread open order {sym_state['open_order_id']}.")
            return
        if pstatus == "filled":
            # Reconcile net_credit/max_loss to the ACTUAL fill before the
            # pending marker (and order id) are cleared — profit/stop/embed
            # must key off money actually received, not decision-time mids.
            _reconcile_spread_fill(sym_state)
            log(f"[{ticker}] spread open order filled — clearing pending "
                f"marker, managing from next cycle")
            sym_state["open_order_id"] = None
            sym_state["last_action"] = "Spread open order filled — now managing."
            return
        if pstatus == "stale":
            order_id = sym_state["open_order_id"]
            age_h = _spread_order_age_hours(sym_state)
            log(f"[{ticker}] spread open order {order_id} stale at "
                f"{age_h:.1f}h — cancelling")
            if cancel_order(order_id):
                send_embed(
                    ACTIONS_CH,
                    f"⏳ Spread open order stale — {ticker} ({age_h:.1f}h, cancelled)",
                    color=Color.YELLOW,
                    description=(
                        f"Opening limit `{order_id}` for {ticker} did not fill "
                        f"within {STALE_AFTER_HOURS}h. Cancelled and cleared "
                        f"state so the opener can re-evaluate at a fresh mid."
                    ),
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH, also_to_actions=False,
                )
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "spread_open_stale_cancelled", result="success",
                          symbol=ticker,
                          details={"order_id": order_id,
                                   "age_hours": round(age_h, 1)})
                del state[ticker]
            else:
                log(f"[{ticker}] cancel of stale spread open order "
                    f"{order_id} returned False — retry next cycle")
                sym_state["last_action"] = (
                    "Cancel of stale spread open order FAILED; will retry.")
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "spread_open_stale_cancel_failed", result="failure",
                          symbol=ticker, details={"order_id": order_id})
            return
        # pstatus == "gone": opening order canceled/rejected/expired/404.
        gone_positions = get_positions()
        gone_occs = {p["symbol"] for p in gone_positions
                     if p.get("asset_class") == "us_option"}
        g_short = sym_state["short_leg"]["occ"]
        g_long  = sym_state["long_leg"]["occ"]
        if g_short not in gone_occs and g_long not in gone_occs:
            # Order terminated WITHOUT creating any position — nothing ever
            # opened. This is NOT a spread that closed; emit an accurate
            # embed (not _handle_orphan_leg's "closed externally") + clear.
            gone_order_id = sym_state["open_order_id"]
            send_embed(
                TRADES_CH,
                f"⚠️ Spread open order did not fill — {ticker}",
                color=Color.YELLOW,
                description=(
                    f"Opening order `{gone_order_id}` for {ticker} terminated "
                    f"(rejected / expired / cancelled) with no position "
                    f"created. No spread was opened; state cleared. The "
                    f"opener may re-evaluate {ticker} on a later cycle."
                ),
                footer=f"wheel_strategy.py · {MODE}",
                actions_channel=ACTIONS_CH, also_to_actions=False,
            )
            log_event(LOG_STREAM, "wheel_strategy.py",
                      "spread_open_order_unfilled_cleared", result="skipped",
                      symbol=ticker, details={"order_id": gone_order_id})
            del state[ticker]
            return
        # A leg filled (partial-fill survivor). Clear the marker and let the
        # existing orphan handler close the survivor (its half-state-resolved
        # message is accurate for that case).
        sym_state["open_order_id"] = None
        _handle_orphan_leg(state, ticker, gone_positions)
        return

    positions = get_positions()

    # 1. Orphan detection — before any snapshot fetch
    occs_present = {p["symbol"] for p in positions
                    if p.get("asset_class") == "us_option"}
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]
    if not (short_occ in occs_present and long_occ in occs_present):
        _handle_orphan_leg(state, ticker, positions)
        return

    # 2-4. Fetch current snapshots
    short_q = get_option_quote(short_occ)
    long_q  = get_option_quote(long_occ)
    if not short_q or not long_q:
        log(f"[{ticker}] spread heartbeat — missing quote, skipping cycle")
        return
    # Executable cost to buy-to-close: pay the short leg's ask, receive
    # the long leg's bid. Deciding on mids overstated profit on wide /
    # illiquid quotes and produced a false "50% profit" close that
    # actually realized a loss (F sm500 2026-05-18).
    close_cost = round(short_q["ask"] - long_q["bid"], 4)
    # Crossed/degenerate quote (short_ask <= long_bid) → close_cost <= 0
    # would make profit_pct > 1 and false-trigger an early close on a
    # nonsensical price. Never decide on a degenerate quote — skip the
    # cycle (same posture as a missing quote).
    if close_cost <= 0:
        log(f"[{ticker}] spread heartbeat — degenerate quote "
            f"(close_cost ${close_cost:.4f} <= 0, crossed/illiquid) "
            f"— skipping cycle")
        return

    pnl = _compute_spread_pnl(sym_state, close_cost)
    max_loss = float(sym_state["max_loss"])

    # 2. Profit trigger
    if pnl["profit_pct"] >= SPREAD_EARLY_CLOSE_PCT:
        log(f"[{ticker}] spread profit_pct={pnl['profit_pct']:.2%} >= "
            f"{SPREAD_EARLY_CLOSE_PCT:.0%} — closing at profit")
        _close_spread(state, ticker, reason="early_close_50pct")
        return

    # 3. Stop loss trigger
    if pnl["loss_per_share"] >= max_loss * SPREAD_STOP_LOSS_PCT:
        log(f"[{ticker}] spread loss=${pnl['loss_per_share']:.2f} >= "
            f"{SPREAD_STOP_LOSS_PCT:.0%} of max_loss=${max_loss:.2f} — stopping out")
        _close_spread(state, ticker, reason="stop_loss_50pct")
        return

    # 4. DTE floor with ITM check
    from datetime import date as _date
    expiry = _date.fromisoformat(sym_state["expiration"])
    days_to_expiry = (expiry - _date.today()).days
    if days_to_expiry <= SPREAD_DTE_FLOOR:
        short_strike = float(sym_state["short_leg"]["strike"])
        stock_price = get_latest_price(ticker)
        spread_type = sym_state["spread_type"]
        short_itm = (
            (spread_type == "put_credit"  and stock_price < short_strike) or
            (spread_type == "call_credit" and stock_price > short_strike)
        )
        if short_itm:
            log(f"[{ticker}] spread DTE={days_to_expiry} <= floor AND short leg ITM "
                f"(stock=${stock_price:.2f}, short_strike=${short_strike:.2f}) — closing")
            _close_spread(state, ticker, reason="dte_floor_itm")
            return

    # 5. Hold heartbeat
    log(f"[{ticker}] spread holding — profit {pnl['profit_pct']:.1%}, "
        f"loss ${pnl['loss_per_share']:.2f}, DTE {days_to_expiry}")


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


def _working_spread_order_exists(short_occ: str, long_occ: str) -> bool:
    """True if Alpaca currently has a non-terminal order touching either
    leg. Belt-and-suspenders against the state-loss reopen window: even
    if seeded state is lost before save_state, we won't stack a second
    mleg at the broker. A lookup failure returns False (defensive — a
    transient API error must not freeze the opener forever; the in-state
    concurrency gate is the primary guard).
    """
    try:
        orders = api_get("/orders", params={"status": "open", "nested": "true"})
    except Exception as e:
        log(f"_working_spread_order_exists lookup failed: {type(e).__name__}: {e}")
        return False
    terminal = {"filled", "canceled", "cancelled", "expired",
                "rejected", "done_for_day", "replaced"}
    targets = {short_occ, long_occ}
    for o in orders or []:
        if o.get("status") in terminal:
            continue
        legs = o.get("legs") or []
        for leg in legs:
            if leg.get("symbol") in targets:
                return True
        if o.get("symbol") in targets:
            return True
    return False


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


def place_sell_to_close(option_symbol, limit_price, qty=None):
    """Sell-to-close a long option position.

    Mirror of place_buy_to_close — used to close the long hedge leg of a
    credit spread when the fallback close path runs (mleg rejected or
    orphan-leg recovery).

    qty: number of contracts to close. If None (default), looks up the
    actual long position size on Alpaca and closes ALL of it.

    Limit price is set slightly BELOW mid (subtract 0.05) to ensure a
    quick fill — symmetric to place_buy_to_close's "add 0.05" tactic.
    """
    if qty is None:
        pos = get_option_position(option_symbol)
        if pos is None:
            log(f"place_sell_to_close: no Alpaca position for {option_symbol} — skipping")
            return None
        qty = abs(int(float(pos.get("qty", 0))))
        if qty == 0:
            log(f"place_sell_to_close: position qty=0 for {option_symbol} — skipping")
            return None

    aggressive_limit = round(max(0.01, limit_price - 0.05), 2)
    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             str(qty),
        "side":            "sell",
        "type":            "limit",
        "limit_price":     str(aggressive_limit),
        "time_in_force":   "day",
        "position_intent": "sell_to_close",
    })
    log(f"Sell-to-close placed: {option_symbol} qty={qty} @ ${aggressive_limit:.2f} — order {order['id']}")
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


def _spread_order_age_hours(sym_state) -> float:
    """Hours since a bot-opened spread's opening order was placed.

    Reads `opened_at` (ISO8601, '...Z'). Returns 0.0 on missing or
    unparseable input — defensive: a parse error must never spuriously
    trigger the stale-cancel path. Parallels _order_age_hours.
    """
    opened_at = sym_state.get("opened_at")
    if not opened_at:
        return 0.0
    try:
        dt = datetime.fromisoformat(opened_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    except (ValueError, TypeError):
        return 0.0


def _contract_expired(sym_state) -> bool:
    """True if the tracked contract's expiration date is strictly in the
    past (date.today(), consistent with the rest of this module's date math).

    A bot-opened put/call's opening order stays status=="filled" at the
    broker forever, but its *position* settles at expiry (expires worthless
    or is assigned). Without this check, _resolve_pending_contract reads the
    still-"filled" order and returns "just_filled" every cycle once the
    position is gone, pinning the symbol in Stage 1/2 with a dead contract
    instead of running the Stage 1↔2 / expiry transition (the SMCI/BAC/SOFI
    aggressive bug, 2026-05-19 — manual/live/sm were unaffected because
    adopted positions carry contract_order_id=None and already resolve
    "gone"). Missing/unparseable expiration → False (never force-resolve on
    bad data)."""
    exp = sym_state.get("contract_expiration")
    if not exp:
        return False
    try:
        return date.fromisoformat(exp) < date.today()
    except (ValueError, TypeError):
        return False


def _resolve_pending_contract(sym_state):
    """Disambiguate when contract is set but no position exists yet.

    Returns:
      "pending"     — order placed, not yet filled. Skip this cycle.
      "stale"       — order pending > STALE_AFTER_HOURS. Caller should
                      cancel and re-quote at the fresh mid.
      "just_filled" — order just filled; entry_price was set as a side effect.
      "gone"        — order cancelled/rejected/expired, contract past its
                      expiration date, or no order_id.
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
        # A filled order is only "just filled" for the brief window before
        # the position appears (≈1 cycle). Past the contract's expiry an
        # absent position means it settled (expired worthless / assigned) —
        # resolve "gone" so the caller runs the Stage 1↔2 / expiry path.
        if _contract_expired(sym_state):
            return "gone"
        return "just_filled"
    return "gone"


def _resolve_pending_spread(sym_state):
    """Disambiguate a bot-opened spread whose opening mleg order may not
    have filled yet. Spread-side parallel of _resolve_pending_contract.

    Only meaningful when sym_state['open_order_id'] is set (bot-opened
    spreads). Adopted/hand-opened spreads leave it None → returns "gone"
    and the caller falls through to the existing position/orphan path
    unchanged.

    Returns:
      "pending" — opening order still working; skip this cycle.
      "stale"   — working > STALE_AFTER_HOURS; caller cancels + clears.
      "filled"  — opening order filled; legs are now/imminently positions.
      "gone"    — order canceled/rejected/expired/404/no id.
    """
    order_id = sym_state.get("open_order_id")
    if not order_id:
        return "gone"
    order = get_order(order_id)
    if order is None:
        return "gone"
    status = order.get("status", "")
    if status in ("new", "accepted", "pending_new",
                  "partially_filled", "accepted_for_bidding"):
        if _spread_order_age_hours(sym_state) > STALE_AFTER_HOURS:
            return "stale"
        return "pending"
    if status == "filled":
        return "filled"
    return "gone"


def _reconcile_spread_fill(sym_state: dict) -> None:
    """Replace decision-time net_credit/max_loss with the ACTUAL fill once
    the opening mleg order fills.

    The opener seeds net_credit from decision-time mids; the real fill can
    differ materially (F sm500 2026-05-18: stored 0.075 vs filled 0.0496).
    profit_pct, the stop-loss check, and the close embed all key off
    net_credit, so they must reflect money actually received. No-ops
    (keeps the decision-time values) if the order or its per-leg fills are
    unavailable, or if the true fill nets <= 0 credit — never clobber with
    garbage that would pin profit_pct to 0 forever.
    """
    order_id = sym_state.get("open_order_id")
    if not order_id:
        return
    order = get_order(order_id)
    if not order:
        return
    legs = order.get("legs") or []
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]

    def _leg_fill(occ):
        for lg in legs:
            if lg.get("symbol") == occ:
                try:
                    v = abs(float(lg.get("filled_avg_price")))
                except (TypeError, ValueError):
                    return None
                return v if v > 0 else None
        return None

    short_fill = _leg_fill(short_occ)
    long_fill  = _leg_fill(long_occ)
    if short_fill is None or long_fill is None:
        return
    net_credit = round(short_fill - long_fill, 4)
    if net_credit <= 0:
        log(f"[reconcile] {short_occ}/{long_occ} fill nets "
            f"${net_credit:.4f} <= 0 — keeping decision-time net_credit")
        return
    width = sym_state.get("width")
    if not width or width <= 0:
        width = round(abs(float(sym_state["short_leg"]["strike"])
                          - float(sym_state["long_leg"]["strike"])), 4)
    old = sym_state.get("net_credit")
    sym_state["net_credit"] = net_credit
    sym_state["max_loss"]   = round(width - net_credit, 4)
    log(f"[reconcile] spread net_credit decision=${old} → fill "
        f"${net_credit:.4f} (max_loss ${sym_state['max_loss']:.4f})")


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
    (e.g., a bare CSP plus a real spread at the same expiry), the
    narrowest-width valid pair wins; remaining unpaired legs are
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
        # Enumerate every valid (short, long) candidate pair, then claim
        # narrowest-width first. This handles the case where the user
        # holds a bare CSP and a real spread at the same expiry: the
        # narrower pair is the real spread, and the wider "phantom" pair
        # is rejected so the leftover short falls to single-leg adoption.
        candidates = []
        for s in shorts:
            for l in longs:
                if l["qty"] != s["qty"]:
                    continue
                if opt_type == "put":
                    if not (l["strike"] < s["strike"]):
                        continue
                else:  # call
                    if not (l["strike"] > s["strike"]):
                        continue
                width = abs(s["strike"] - l["strike"])
                candidates.append((width, s, l))

        # Sort by width ascending so narrowest-pair wins
        candidates.sort(key=lambda c: c[0])

        for width, s, l in candidates:
            if s.get("_paired") or l.get("_paired"):
                continue
            spread_type = "put_credit" if opt_type == "put" else "call_credit"
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
            s["_paired"] = True
            l["_paired"] = True
    return pairs


def _adopt_spread(state: dict, sp: SpreadPair) -> bool:
    """Seed state[ticker] for a discovered spread.

    Idempotent: returns False without touching state if the same spread
    is already adopted (matching short_occ AND long_occ), preserving
    cycle_count and cycle_history across cycles. Returns True on first
    adoption so the caller can fire a one-time notification.
    """
    existing = state.get(sp.ticker, {})
    already_adopted = (
        existing.get("stage") == "spread_active"
        and existing.get("short_leg", {}).get("occ") == sp.short_occ
        and existing.get("long_leg",  {}).get("occ") == sp.long_occ
    )
    if already_adopted:
        return False

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
    return True


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

    # ─ Phase 1: spread pairs ─
    # Detect spreads BEFORE single-leg adoption so paired legs aren't
    # double-claimed by Stage 1/Stage 2 logic.
    spread_pairs = _detect_spread_pairs(positions)
    claimed_occs: set = set()
    for ticker, sp_list in spread_pairs.items():
        for sp in sp_list:
            newly_adopted = _adopt_spread(state, sp)
            discovered.add(ticker)
            claimed_occs.add(sp.short_occ)
            claimed_occs.add(sp.long_occ)
            if not newly_adopted:
                # Already adopted on a prior cycle — don't re-announce.
                continue
            send_embed(
                TRADES_CH, f"📥 Spread adopted — {ticker}",
                color=Color.BLUE,
                description=(
                    f"{sp.spread_type.replace('_', ' ')} · user-opened, "
                    f"now bot-managed ({sp.short_qty}× contracts)"
                ),
                fields=_spread_embed_fields(
                    sp.short_strike, sp.long_strike, sp.width,
                    sp.net_credit, sp.max_loss, sp.expiration.isoformat(),
                ),
                footer=f"wheel_strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "wheel_strategy.py", "adopted_spread",
                      symbol=ticker,
                      details={
                          "spread_type": sp.spread_type,
                          "short_occ": sp.short_occ, "long_occ": sp.long_occ,
                          "short_strike": sp.short_strike, "long_strike": sp.long_strike,
                          "expiration": sp.expiration.isoformat(),
                          "qty": sp.short_qty,
                          "net_credit": sp.net_credit, "max_loss": sp.max_loss,
                      })

    # ─ Phase 2: tracked-in-state symbols stay in scope ─
    for sym, ss in state.items():
        if sym.startswith("_"):
            continue
        if ss.get("stage") == "spread_active":
            discovered.add(sym)
            continue
        if ss.get("current_contract") or int(ss.get("shares_qty", 0)) >= 100:
            discovered.add(sym)

    # ─ Phase 3: single-leg adoption (puts/calls not claimed by a spread) ─
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

        # Skip any leg already claimed by a spread.
        if symbol in claimed_occs:
            continue

        # Only short option positions are wheel material for single-leg adoption.
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
        if sym_state.get("current_contract") == symbol:
            continue

        entry_per_share = abs(float(pos.get("avg_entry_price", 0)))
        contracts = abs(qty_int)

        sym_state["current_contract"]     = symbol
        sym_state["contract_order_id"]    = sym_state.get("contract_order_id")
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


# ── Autonomous put-credit-spread opener (Phase 4 — SM modes only) ─────────
# Gated entirely behind AUTO_OPEN_SPREADS (set in apply_mode from
# cfg["auto_open_spreads"], True only on sm500/sm1000/sm2000). For
# conservative/aggressive/manual/live this whole path is inert.

def normalize_scores(raw: dict) -> dict:
    """Percentile-rank raw screener scores to 0-100 within this cycle's set.

    100 = best, 0 = worst. Singleton -> 100. Empty -> {}.
    """
    if not raw:
        return {}
    if len(raw) == 1:
        return {k: 100.0 for k in raw}
    ordered = sorted(raw.items(), key=lambda kv: kv[1])
    n = len(ordered)
    return {sym: round(i / (n - 1) * 100.0, 4) for i, (sym, _) in enumerate(ordered)}


def bp_wants_spread(options_bp: float, threshold: float) -> bool:
    """Below the BP threshold -> open a defined-risk spread instead of a CSP."""
    return options_bp < threshold


def spread_passes_risk(width: float, net_credit: float, equity: float,
                       max_risk_pct: float) -> bool:
    """Net-of-credit max loss ((width - net_credit) * 100) must be ≤ this
    fraction of account equity. Matches the canonical max_loss convention
    used by _adopt_spread / _auto_open_spread state seeding."""
    max_loss = (width - net_credit) * 100.0
    return max_loss <= equity * max_risk_pct


def under_concurrency(open_spreads: int, cap: int) -> bool:
    return open_spreads < cap


def above_account_floor(equity: float, floor: float) -> bool:
    return equity >= floor


def bp_fits(options_bp: float, width: float, buffer: float = 1.0) -> bool:
    return options_bp >= (width * 100.0) * buffer


def eligible_universe(symbols_prices: dict, max_price) -> list:
    """Filter symbols to those at/below max_price; pass all when None."""
    if max_price is None:
        return list(symbols_prices)
    return [s for s, px in symbols_prices.items() if px <= max_price]


def _spread_embed_fields(short_strike: float, long_strike: float,
                         width: float, net_credit: float, max_loss: float,
                         expiration: str) -> list[dict]:
    """Build the structured Discord embed fields for a put credit spread.

    Pure (no I/O) so it is unit-testable. `expiration` is an ISO
    'YYYY-MM-DD' string; DTE is computed against today.
    """
    try:
        dte = (date.fromisoformat(expiration) - date.today()).days
    except ValueError:
        dte = 0
    return [
        {"name": "Short put",  "value": f"${short_strike:.2f}", "inline": True},
        {"name": "Long put",   "value": f"${long_strike:.2f}",  "inline": True},
        {"name": "Width",      "value": f"${width:.2f}",        "inline": True},
        {"name": "Net credit",
         "value": f"${net_credit:.2f}/sh\n(${net_credit * 100:.2f})",
         "inline": True},
        {"name": "Max loss",
         "value": f"${max_loss:.2f}/sh\n(${max_loss * 100:.2f})",
         "inline": True},
        {"name": "Expires",
         "value": f"{expiration}\n({dte}d)",
         "inline": True},
    ]


def _open_spread_mleg(short_occ: str, long_occ: str, qty: int,
                      net_credit: float, limit_credit: float = None):
    """Submit an Alpaca multi-leg sell-to-open put credit spread.

    `net_credit` is the decision-time mid (recorded in state, used for
    P&L). `limit_credit`, when provided, is the *marketable* credit the
    order is actually placed at (short bid − long ask, capped at the
    mid) so the order fills instead of resting at an untradeable mid.
    When None, falls back to the mid (legacy behavior — keeps direct
    callers and the four non-SM modes byte-identical).
    """
    if limit_credit is None:
        eff_credit = abs(net_credit)
    else:
        eff_credit = max(round(limit_credit, 2), SPREAD_OPEN_MIN_LIMIT)
    return api_post("/orders", {
        "order_class":   "mleg",
        "qty":           str(qty),
        "type":          "limit",
        "limit_price":   f"{round(-eff_credit, 2):.2f}",
        "time_in_force": "day",
        "legs": [
            {"symbol": short_occ, "side": "sell", "ratio_qty": "1", "position_intent": "sell_to_open"},
            {"symbol": long_occ,  "side": "buy",  "ratio_qty": "1", "position_intent": "buy_to_open"},
        ],
    })


def _auto_open_spread(state: dict, account: dict, cfg: dict) -> None:
    """Autonomously open ONE risk-defined put credit spread per cycle.

    Highest-risk path in the system — gated entirely behind
    AUTO_OPEN_SPREADS (SM modes only). Order of operations is
    deliberate and must not be reordered:

      1. flag gate (return before ANY external call if disabled)
      2. account-floor gate (skip near-dead accounts)
      3. concurrency gate (count existing spread_active entries)
      4. build universe + price-filter (sm500 cheap-underlying filter)
      5. score every candidate, normalize to 0-100 percentile
      6. iterate best→worst: wheelability gate, earnings gate,
         BP-switch gate, then construct the narrowest spread that
         clears the risk cap AND BP-fit
      7. on the first fully-eligible symbol: place the mleg order,
         seed spread_active state for handle_spread to manage,
         emit a #trades embed, RETURN (max one open per cycle)

    A "no trade within risk budget" outcome is a normal logged event,
    never an exception. Exits reuse the inherited manual handle_spread
    on subsequent cycles — no new exit code here.
    """
    # (1) flag gate — touch nothing if disabled (cons/agg/manual/live)
    if not AUTO_OPEN_SPREADS:
        return

    # (2) account-floor gate
    equity = float(get_account()["equity"])
    floor = cfg["account_floor"]
    if not above_account_floor(equity, floor):
        log(f"[auto-spread] equity ${equity:.2f} < account_floor ${floor} — skipping")
        log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_below_floor",
                  result="skipped",
                  details={"equity": equity, "account_floor": floor})
        return

    # (3) concurrency gate
    open_spreads = sum(
        1 for k, v in state.items()
        if not k.startswith("_") and isinstance(v, dict)
        and v.get("stage") == "spread_active"
    )
    cap = cfg["max_concurrent_spreads"]
    if not under_concurrency(open_spreads, cap):
        log(f"[auto-spread] {open_spreads} open spreads >= cap {cap} — skipping")
        log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_concurrency_cap",
                  result="skipped",
                  details={"open_spreads": open_spreads, "max_concurrent_spreads": cap})
        return

    # (4) build universe + price filter
    already_wheeled = {k for k in state if not k.startswith("_")}
    universe = screener_core.build_universe(cfg.get("screener_universe"), already_wheeled)

    options_bp = float(account.get("options_buying_power") or 0)
    free_bp = options_bp

    # (5) score every candidate (dict has both "score" and "price")
    scored_full = {}
    for sym in universe:
        try:
            r = screener_core.score_candidate(
                sym, free_bp,
                api_get=api_get,
                target_dte_min=cfg["spread_dte_min"],
                target_dte_max=cfg["spread_dte_max"],
                put_strike_discount=cfg["short_put_otm_pct"],
                headers=HEADERS,
            )
        except Exception as e:
            log(f"[auto-spread] score_candidate({sym}) failed: {type(e).__name__}: {e}")
            r = None
        if r:
            scored_full[sym] = r

    # price-filter (sm500 cheap-underlying universe narrowing; None = all)
    prices = {sym: r["price"] for sym, r in scored_full.items()}
    eligible = set(eligible_universe(prices, cfg.get("max_underlying_price")))
    raw = {sym: r["score"] for sym, r in scored_full.items() if sym in eligible}
    norm = normalize_scores(raw)

    if not norm:
        log("[auto-spread] no eligible scored candidates this cycle — no trade")
        log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_no_candidates",
                  result="skipped", details={"universe_size": len(universe)})
        return

    threshold = cfg["wheelability_min"]
    otm_pct   = cfg["short_put_otm_pct"]
    dte_min   = cfg["spread_dte_min"]
    dte_max   = cfg["spread_dte_max"]
    max_risk_pct = cfg["max_risk_pct_equity"]

    # (6) iterate best→worst
    for sym in sorted(norm, key=lambda s: norm[s], reverse=True):
        if norm[sym] < threshold:
            # everything after this scores lower too — stop scanning
            log(f"[auto-spread] best remaining {sym} wheelability "
                f"{norm[sym]:.1f} < {threshold} — no trade")
            break

        if earnings.next_earnings_within(sym, cfg["earnings_exclusion_days"]):
            log(f"[auto-spread] {sym} earnings within "
                f"{cfg['earnings_exclusion_days']}d (or unknown) — skipping")
            continue

        if not bp_wants_spread(options_bp, cfg["bp_switch_threshold"]):
            # BP is above the switch — a CSP would be opened instead, but
            # SM modes keep wheel_skip_new_puts ON, so just skip (SM is
            # always far below this threshold in practice).
            log(f"[auto-spread] {sym} options_bp ${options_bp:.0f} >= "
                f"switch ${cfg['bp_switch_threshold']} — not a spread candidate")
            continue

        price = scored_full[sym]["price"]
        short_target = round_strike(price * (1 - otm_pct), price)
        short_contract = find_best_contract(sym, "put", short_target, dte_min, dte_max)
        if not short_contract:
            log(f"[auto-spread] {sym} no short put contract found — skipping")
            continue
        short_occ    = short_contract["symbol"]
        short_strike = float(short_contract["strike_price"])
        expiration   = short_contract["expiration_date"]

        short_q = get_option_quote(short_occ)
        if not short_q:
            log(f"[auto-spread] {sym} no quote for short {short_occ} — skipping")
            continue
        short_mid = (short_q["bid"] + short_q["ask"]) / 2.0

        inc = strike_increment(price)

        # Search widening long strikes; pick the NARROWEST that clears
        # both the risk cap and BP-fit.
        chosen = None
        max_steps = 10  # bounded — don't scan an unbounded chain
        for step in range(1, max_steps + 1):
            long_target = short_strike - inc * step
            if long_target <= 0:
                break
            long_contract = find_best_contract(sym, "put", long_target,
                                                dte_min, dte_max)
            if not long_contract:
                continue
            long_strike = float(long_contract["strike_price"])
            width = round(short_strike - long_strike, 4)
            if width <= 0:
                continue
            # bp_fits is pure arithmetic — check it before the network I/O
            # below so impossible widths are rejected without an API call.
            if not bp_fits(options_bp, width):
                continue
            # Need the long quote BEFORE the risk check: the gate now uses
            # net-of-credit max loss, so net_credit must be known here.
            long_q = get_option_quote(long_contract["symbol"])
            if not long_q:
                continue
            long_mid = (long_q["bid"] + long_q["ask"]) / 2.0
            cand_net_credit = round(short_mid - long_mid, 4)
            if not spread_passes_risk(width, cand_net_credit, equity,
                                      max_risk_pct):
                continue
            chosen = {
                "long_occ":    long_contract["symbol"],
                "long_strike": long_strike,
                "long_mid":    long_mid,
                "long_bid":    long_q["bid"],
                "long_ask":    long_q["ask"],
                "width":       width,
                "net_credit":  cand_net_credit,
            }
            break  # first hit == narrowest passing width

        if not chosen:
            log(f"[auto-spread] {sym} no long leg fits risk budget "
                f"(equity ${equity:.2f} @ {max_risk_pct:.0%}) — trying next")
            continue

        # (7) fully eligible — place the order
        net_credit = chosen["net_credit"]
        width      = chosen["width"]

        # Minimum net-credit floor. A thin/illiquid chain can produce
        # long_mid >= short_mid, yielding a zero or NEGATIVE credit:
        #   net_credit == 0 → _compute_spread_pnl pins profit_pct to 0.0
        #     forever (`... if net_credit > 0 else 0.0`) → the 50%-profit
        #     close trigger can NEVER fire → un-manageable spread.
        #   net_credit < 0  → it's actually a DEBIT spread placed via the
        #     credit-convention order; max_loss = width - net_credit > width,
        #     blowing past the risk cap that only validated `width`.
        # Reject below the config floor and try the next eligible symbol
        # (continue, NOT return — only the terminal fall-through emits
        # auto_spread_no_trade).
        min_net_credit = cfg.get("min_net_credit", 0.05)
        if net_credit < min_net_credit:
            log(f"[auto-spread] {sym} net_credit ${net_credit:.4f} "
                f"< min ${min_net_credit:.4f} (thin chain — would be a "
                f"non-credit/near-zero spread) — skipping")
            log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_skip",
                      result="skipped", symbol=sym,
                      notes="below_min_net_credit",
                      details={"net_credit": net_credit,
                               "min_net_credit": min_net_credit,
                               "short_mid": round(short_mid, 4),
                               "long_mid": round(chosen["long_mid"], 4)})
            continue

        # Executable-credit floor. The mid-based net_credit can be wildly
        # optimistic on wide/illiquid quotes — F sm500 2026-05-18 stored a
        # mid credit of $0.075 but the spread could only ever transact for
        # ~$0.05 and exited at a loss. Require the CONSERVATIVE executable
        # credit (sell the short at its bid, buy the long at its ask — the
        # price the spread can actually open AND later close near) to clear
        # the same floor, so we only open spreads whose economics are real.
        exec_credit = round(short_q["bid"] - chosen["long_ask"], 4)
        if exec_credit < min_net_credit:
            log(f"[auto-spread] {sym} executable credit ${exec_credit:.4f} "
                f"(short_bid ${short_q['bid']:.4f} - long_ask "
                f"${chosen['long_ask']:.4f}) < min ${min_net_credit:.4f} "
                f"(too wide/illiquid to exit reliably) — skipping")
            log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_skip",
                      result="skipped", symbol=sym,
                      notes="below_exec_net_credit",
                      details={"exec_credit": exec_credit,
                               "mid_net_credit": net_credit,
                               "min_net_credit": min_net_credit,
                               "short_bid": round(short_q["bid"], 4),
                               "long_ask": round(chosen["long_ask"], 4)})
            continue

        if _working_spread_order_exists(short_occ, chosen["long_occ"]):
            log(f"[auto-spread] {sym} already has a working order on a "
                f"spread leg — skipping to avoid a duplicate")
            log_event(LOG_STREAM, "wheel_strategy.py",
                      "auto_spread_skip", result="skipped", symbol=sym,
                      notes="working_order_exists",
                      details={"short_occ": short_occ,
                               "long_occ": chosen["long_occ"]})
            continue

        # Per-share max loss — MUST match _adopt_spread's convention
        # (round(width - net_credit, 4)). handle_spread / _compute_spread_pnl
        # work entirely in per-share units: the stop-loss trigger compares
        # pnl["loss_per_share"] against max_loss * SPREAD_STOP_LOSS_PCT, so a
        # contract-multiplied value (width*100) makes the stop unreachable.
        max_loss   = round(width - net_credit, 4)
        # Marketable opening limit: sell the short at its bid, buy the long
        # at its ask (the price the spread can actually transact at), but
        # never demand MORE credit than the mid, and floor at one cent.
        marketable_credit = max(
            round(short_q["bid"] - chosen["long_ask"], 2),
            SPREAD_OPEN_MIN_LIMIT,
        )
        marketable_credit = min(marketable_credit, net_credit)
        try:
            order = _open_spread_mleg(short_occ, chosen["long_occ"],
                                      1, net_credit,
                                      limit_credit=marketable_credit)
        except Exception as e:
            log(f"[auto-spread] _open_spread_mleg failed for {sym}: "
                f"{type(e).__name__}: {e}")
            send_embed(
                ERRORS_CH, f"Auto-spread open failed {sym}",
                color=Color.RED,
                description=f"`{type(e).__name__}: {str(e)[:400]}`",
                footer=f"wheel_strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_open_failed",
                      result="failure", symbol=sym,
                      notes=f"{type(e).__name__}: {str(e)[:400]}")
            return  # one attempt per cycle either way

        order_id = order.get("id", "?") if isinstance(order, dict) else "?"

        # Seed spread_active state so the inherited manual handle_spread
        # adopts and manages exits on subsequent cycles (no new exit code).
        ss = _empty_spread_state()
        ss["spread_type"] = "put_credit"
        ss["short_leg"] = {"occ": short_occ, "strike": short_strike,
                           "entry_premium": round(short_mid, 4), "qty": 1}
        ss["long_leg"]  = {"occ": chosen["long_occ"], "strike": chosen["long_strike"],
                           "entry_premium": round(chosen["long_mid"], 4), "qty": 1}
        ss["expiration"] = expiration
        ss["net_credit"] = net_credit
        ss["max_loss"]   = max_loss
        ss["width"]      = width
        ss["opened_at"]  = datetime.utcnow().isoformat() + "Z"
        ss["open_order_id"] = order_id if order_id != "?" else None
        ss["open_limit_credit"] = marketable_credit
        ss["last_action"] = (
            f"Auto-opened put credit spread short=${short_strike:.2f} "
            f"long=${chosen['long_strike']:.2f} credit=${net_credit:.2f}"
        )
        state[sym] = ss

        send_embed(
            TRADES_CH, f"🎯 Put credit spread opened — {sym}",
            color=Color.GREEN,
            description=f"Screener-driven · wheelability {norm[sym]:.0f}",
            fields=_spread_embed_fields(
                short_strike, chosen["long_strike"], width,
                net_credit, max_loss, expiration,
            ),
            footer=f"wheel_strategy.py · {MODE} · order {str(order_id)[:8]}…",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_opened",
                  result="success", symbol=sym,
                  alpaca_order_id=order_id if order_id != "?" else None,
                  details={
                      "wheelability": norm[sym],
                      "short_occ": short_occ, "long_occ": chosen["long_occ"],
                      "short_strike": short_strike,
                      "long_strike": chosen["long_strike"],
                      "width": width, "net_credit": net_credit,
                      "max_loss": max_loss, "expiration": expiration,
                  })
        return  # max_opens_per_cycle = 1 — stop after one open

    # Fell through the whole eligible list with no order — a normal,
    # expected outcome (especially for sm500). Logged, not an error.
    log("[auto-spread] no symbol cleared the full gauntlet this cycle — no trade")
    log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_no_trade",
              result="skipped",
              details={"candidates_considered": len(norm),
                       "equity": equity})


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
                # AUTO_OPEN_SPREADS modes (SM) discover zero symbols on a
                # brand-new empty account. Without this branch, run_wheel
                # would return here BEFORE the auto-open hook below, so the
                # opener could never place its first trade (chicken-and-egg:
                # no position to discover until the opener opens one). Run
                # the opener on the cold-start path too, wrapped identically
                # to the normal hook, and persist any newly-seeded spread so
                # the NEXT cycle's _discover_wheel_state finds the position
                # and handle_spread manages it. For non-AUTO_OPEN modes this
                # whole block is byte-identical to before (the guard is
                # False → falls straight through to the original
                # log/save_state/log_event/return).
                if AUTO_OPEN_SPREADS and is_market_open():
                    account = get_account()
                    try:
                        _auto_open_spread(state, account, config.get_mode(MODE))
                    except Exception as e:
                        log(f"[auto-spread] _auto_open_spread crashed: {type(e).__name__}: {e}")
                        send_embed(
                            ERRORS_CH, "wheel_strategy.py — _auto_open_spread crashed",
                            color=Color.RED,
                            description=f"`{type(e).__name__}: {str(e)[:500]}`",
                            footer=f"wheel_strategy.py · {MODE}",
                            actions_channel=ACTIONS_CH,
                        )
                        log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_exception",
                                  result="failure",
                                  notes=f"{type(e).__name__}: {str(e)[:500]}")
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

                if sym_state.get("stage") == "spread_active":
                    if not SPREAD_MANAGEMENT:
                        log(f"[{symbol}] spread_active but SPREAD_MANAGEMENT=False — skipping")
                        continue
                    handle_spread(state, symbol, account)
                    continue
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

        # ── Autonomous spread opener (SM modes only) ──
        # Runs AFTER the discover + manage-hand-opened + handle_spread
        # passes above, BEFORE cycle end. Gated by AUTO_OPEN_SPREADS
        # (False on cons/agg/manual/live → fully inert there). Wrapped
        # so an opener failure can't lose this cycle's state writeback.
        # MARKET-HOURS GATING: this warm hook has NO explicit is_market_open()
        # check — it relies on the upstream `if not is_market_open(): return`
        # (~line 2346) having already exited the cycle when the market is
        # closed. Do NOT reorder this hook above that early-return, or it
        # would place spreads after hours. (The cold-start branch ~line 2324
        # carries its own explicit is_market_open() gate by contrast.)
        if AUTO_OPEN_SPREADS:
            try:
                _auto_open_spread(state, account, config.get_mode(MODE))
            except Exception as e:
                log(f"[auto-spread] _auto_open_spread crashed: {type(e).__name__}: {e}")
                send_embed(
                    ERRORS_CH, "wheel_strategy.py — _auto_open_spread crashed",
                    color=Color.RED,
                    description=f"`{type(e).__name__}: {str(e)[:500]}`",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_exception",
                          result="failure",
                          notes=f"{type(e).__name__}: {str(e)[:500]}")

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
