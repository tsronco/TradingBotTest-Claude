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
import uuid
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
SPREAD_STOP_CREDIT_MULT: float | None = None  # SM modes: hardened stop trigger (Task 6–8)
AUTO_OPEN_SPREADS      = False  # SM modes (Phase 4): autonomous spread opener
SPREAD_OPEN_MIN_LIMIT = 0.01  # floor for the opening mleg limit credit so a
                              # thin/negative natural bid still posts a 1-cent
                              # credit order (stale path cancels it if it never
                              # fills) rather than flipping to a debit.
# Opening-price posture (2026-05-30 spread-loss fix). The opener used to place
# the mleg at the FULL marketable cross (short_bid - long_ask), giving away the
# entire bid/ask width on entry — MU 2026-05-29 opened at $1.50 when the mid was
# $3.65. We now rest the order between the mid and the marketable cross, giving
# up at most CONCESSION_PCT of that gap and never accepting less than
# MIN_CREDIT_PCT_OF_MID of the mid. The pending-order machinery (open_order_id /
# _resolve_pending_spread / stale-cancel) safely handles a resting unfilled
# order, so we no longer need the full cross to avoid the old reopen loop.
SPREAD_OPEN_CONCESSION_PCT      = 0.0   # 0 = rest at mid; 1 = full marketable cross
SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID = 0.0 # floor as a fraction of the mid
# Management hardening (2026-05-30). The stop used to evaluate on the WORST-case
# executable close (short_ask - long_bid); on a wide chain that trips a "50% of
# max loss" stop on the bid/ask spread itself the moment the order fills (MU
# stopped out 20 min after opening). The underlying-price tripwire (stock vs
# short strike) and a mid-based stop are robust to that. SM modes already get
# the tripwire via spread_stop_credit_mult; these flags extend the protection to
# manual and make the stop quote-noise-resistant on every auto-managed mode.
SPREAD_UNDERLYING_TRIPWIRE = False  # close when the stock crosses the short strike
SPREAD_SETTLE_MINUTES      = 0      # suppress the loss-stop for N min after open


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
    global WHEEL_SKIP_NEW_PUTS, AUTO_DISCOVER_SYMBOLS, EXCLUDED_SYMBOLS
    global SPREAD_MANAGEMENT, SPREAD_EARLY_CLOSE_PCT, SPREAD_STOP_LOSS_PCT, SPREAD_DTE_FLOOR
    global SPREAD_STOP_CREDIT_MULT
    global AUTO_OPEN_SPREADS
    global SPREAD_OPEN_CONCESSION_PCT, SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID
    global SPREAD_UNDERLYING_TRIPWIRE, SPREAD_SETTLE_MINUTES
    global SPREAD_TRIPWIRE_DTE, SPREAD_TRIPWIRE_CONFIRM_MINUTES

    cfg = config.get_mode(mode_name)
    MODE = mode_name

    API_KEY    = os.getenv(cfg["alpaca_key_env"])
    API_SECRET = os.getenv(cfg["alpaca_secret_env"])
    # Validate scheme — a missing or malformed (e.g. literal "-" placeholder)
    # GitHub Actions secret would otherwise produce URLs like "-/positions"
    # that requests rejects with MissingSchema before the call even leaves
    # the runner. Fall back to the paper default if the env value isn't a
    # proper http(s) URL. Same default the script previously used when the
    # env var was unset, just extended to malformed values too.
    _raw_url = (os.getenv(cfg["alpaca_url_env"]) or "").strip()
    if _raw_url.startswith(("http://", "https://")):
        BASE_URL = _raw_url
    else:
        BASE_URL = "https://paper-api.alpaca.markets/v2"
    # R33: real-money mode must NEVER run against the paper endpoint. A missing
    # or malformed ALPACA_LIVE_BASE_URL would otherwise silently route live
    # orders to paper and leave the real account unmanaged. Fail loudly.
    if mode_name == "live" and "paper-api.alpaca.markets" in BASE_URL:
        raise RuntimeError(
            f"live mode resolved to the PAPER endpoint ({BASE_URL}) — refusing "
            f"to run. Set ALPACA_LIVE_BASE_URL to https://api.alpaca.markets/v2.")
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
    # Symbols the wheel must not touch (no covered-call sale, no put mgmt),
    # even though they show up in auto-discovery. Empty for every mode that
    # doesn't opt in via config.excluded_symbols.
    EXCLUDED_SYMBOLS      = config.excluded_symbols(mode_name)

    SPREAD_MANAGEMENT       = cfg.get("spread_management", False)
    SPREAD_EARLY_CLOSE_PCT  = cfg.get("spread_early_close_pct", 0.50)
    SPREAD_STOP_LOSS_PCT    = cfg.get("spread_stop_loss_pct", 0.50)
    SPREAD_DTE_FLOOR        = cfg.get("spread_dte_floor", 2)
    # Hardened-engine: when set (SM modes only), replaces SPREAD_STOP_LOSS_PCT
    # as the stop trigger in handle_spread. None for cons/agg/manual/live —
    # those modes keep the old 50%-of-max-loss behavior unchanged.
    SPREAD_STOP_CREDIT_MULT = cfg.get("spread_stop_credit_mult", None)

    AUTO_OPEN_SPREADS      = cfg.get("auto_open_spreads", False)

    # Opening-price posture + management hardening (2026-05-30 spread-loss fix).
    # Defaults keep non-spread modes byte-identical (concession 1.0 reproduces
    # the legacy full-marketable cross only where a mode opts in via config).
    SPREAD_OPEN_CONCESSION_PCT        = cfg.get("spread_open_concession_pct", 1.0)
    SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID = cfg.get("spread_open_min_credit_pct_of_mid", 0.0)
    # Tripwire is implied wherever the SM credit-multiple stop is set, and can be
    # turned on explicitly (manual) via config.
    SPREAD_UNDERLYING_TRIPWIRE = bool(
        cfg.get("spread_underlying_tripwire", SPREAD_STOP_CREDIT_MULT is not None)
    )
    SPREAD_SETTLE_MINUTES = cfg.get("spread_settle_minutes", 0)
    # Underlying-tripwire noise-tolerance (2026-06-16, manual). A put credit
    # spread is defined-risk: its loss is capped at the width whether the stock
    # wicks through the short strike for a minute or sits there for a week. The
    # original tripwire closed on the FIRST touch at ANY DTE, which realized a
    # near-max loss on pure intraday noise and forfeited recovery (MU 2-DTE and
    # QQQ 9-DTE 2026-06-16 both recovered above the strike within ~1-2h). Two
    # gates narrow it to where an ITM short leg actually means something:
    #   * SPREAD_TRIPWIRE_DTE — only arm at/under this many days to expiry
    #     (None = arm at all DTEs, the legacy/SM behavior).
    #   * SPREAD_TRIPWIRE_CONFIRM_MINUTES — require the stock to stay through
    #     the short strike for this long of *continuous* breach before closing
    #     (0 = close on first touch, the legacy/SM behavior). Time-based so the
    #     10-min cron's gaps don't matter; waiting costs nothing structurally
    #     because the loss is already capped at the width.
    SPREAD_TRIPWIRE_DTE = cfg.get("spread_tripwire_dte", None)
    SPREAD_TRIPWIRE_CONFIRM_MINUTES = cfg.get("spread_tripwire_confirm_minutes", 0)


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
        # Set to an ISO8601 '...Z' timestamp on the cycle the stock first trades
        # through the short strike (underlying tripwire); cleared the moment it
        # recovers above. Drives the confirmation window in handle_spread.
        "tripwire_breach_since": None,
        # Bot-opened spreads only: id of the mleg open order + the credit
        # the marketable limit was placed at. Adopted/hand-opened spreads
        # leave these None so _resolve_pending_spread short-circuits to
        # "gone" and the existing position/orphan path runs unchanged.
        "open_order_id": None,
        # R13: the client_order_id we stamped on the opening mleg (R1). Alpaca
        # echoes it; we keep it so a lost/None numeric order id doesn't make
        # _resolve_pending_spread misread a still-working open as "gone".
        "open_client_order_id": None,
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
    timeout, missing quote, or an order that comes back in a terminal
    non-filled state). The caller (_close_spread) decides whether to fall
    back to two individual orders.

    qty is in spread units (number of spreads), not per-leg. ratio_qty
    is the per-spread leg multiplier — always "1" for vertical spreads.
    """
    try:
        short_occ = sym_state["short_leg"]["occ"]
        long_occ  = sym_state["long_leg"]["occ"]
        qty       = sym_state["short_leg"]["qty"]  # short and long match by definition
        # R5 (2026-06-16): price a MARKETABLE LIMIT, not a market order. A
        # market mleg on an illiquid chain fills at short_ask − long_bid (the
        # full width crossed) with NO ceiling — undoing the careful near-mid
        # OPEN discipline. Bound the net debit at the executable cross so a
        # degenerate quote can't fill arbitrarily badly, while staying
        # marketable enough to fill. Positive limit_price = net DEBIT we pay
        # (mirrors the open's negative = credit received). No usable quote →
        # return False and let the fallback path price each leg marketable.
        sq = get_option_quote(short_occ)
        lq = get_option_quote(long_occ)
        if not sq or not lq:
            log(f"_close_spread_mleg: missing quote (short={bool(sq)} "
                f"long={bool(lq)}) — deferring to the individual-leg fallback")
            return False
        net_debit   = sq["ask"] - lq["bid"]
        limit_price = round(max(net_debit, SPREAD_OPEN_MIN_LIMIT), 2)
        order = api_post("/orders", {
            "order_class":   "mleg",
            "qty":           str(qty),
            "type":          "limit",
            "limit_price":   f"{limit_price:.2f}",
            "time_in_force": "day",
            "legs": [
                {"symbol": short_occ, "side": "buy",  "ratio_qty": "1", "position_intent": "buy_to_close"},
                {"symbol": long_occ,  "side": "sell", "ratio_qty": "1", "position_intent": "sell_to_close"},
            ],
        })
        # R7 (2026-06-16): a 200 response means "accepted", not "filled". An
        # mleg that immediately comes back rejected/canceled/expired must NOT
        # be treated as a successful close — the caller deletes state on True,
        # which would drop a still-open spread out of tracking. Treat terminal
        # non-filled statuses as failure so the fallback / next cycle retries.
        # (On manual + SM, both of which auto-discover positions, a spread that
        # does slip through still gets re-adopted next cycle — but we catch the
        # obvious rejections here rather than relying on that safety net.)
        status = (order or {}).get("status", "")
        if status in {"rejected", "canceled", "cancelled", "expired",
                      "done_for_day", "suspended"}:
            log(f"_close_spread_mleg: order came back '{status}' — treating as failure")
            return False
        log(f"Spread mleg close placed (limit ${limit_price:.2f} debit): short={short_occ} long={long_occ} qty={qty} — order {order.get('id', '?')} [{status or 'accepted'}]")
        return True
    except Exception as e:
        log(f"_close_spread_mleg failed: {alpaca_err_detail(e)}")
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

    Limit prices: MARKETABLE (R6, 2026-06-16) — pay the short leg's ask to
    buy it back, hit the long leg's bid to sell it. The old midpoint pricing
    rested below the ask on the wide/illiquid chains these closes hit and never
    filled, leaving the short leg open (assignment risk) or — if the short
    filled but the long didn't — a naked survivor. Falls back to the entry
    premium only when no quote is available. Mirrors _handle_orphan_leg.
    """
    short_occ = sym_state["short_leg"]["occ"]
    long_occ  = sym_state["long_leg"]["occ"]
    short_entry = sym_state["short_leg"]["entry_premium"]
    long_entry  = sym_state["long_leg"]["entry_premium"]

    def _marketable_or_entry(occ: str, side: str, entry: float) -> float:
        q = get_option_quote(occ)
        if not q:
            return entry
        if side == "buy":   # BTC the short — pay the ask to get filled
            return round(max(q["ask"], SPREAD_OPEN_MIN_LIMIT), 2)
        return round(max(q["bid"], SPREAD_OPEN_MIN_LIMIT), 2)  # STC the long — hit the bid

    short_limit = _marketable_or_entry(short_occ, "buy",  short_entry)
    long_limit  = _marketable_or_entry(long_occ,  "sell", long_entry)

    # Step 1: close the short leg
    try:
        place_buy_to_close(short_occ, short_limit)
    except Exception as e:
        detail = alpaca_err_detail(e)
        log(f"_close_spread_legs_individually: BTC failed on {short_occ}: {detail}")
        _parsed = _parse_occ(short_occ)
        _sym = _parsed[0] if _parsed else short_occ
        # PDT blocks are not a fixable per-cycle error — retrying re-trips the
        # same denial. Route to the actions firehose instead of pinging
        # #errors every cycle. The position is intact; it can only clear once
        # the PDT restriction lifts (equity ≥ $25k / account reset).
        if is_pdt_denied(detail):
            log_event(LOG_STREAM, "wheel_strategy.py", "spread_close_pdt_blocked",
                      result="skipped", symbol=_sym,
                      details={"leg": "short", "occ": short_occ, "error": detail})
            send_embed(
                ACTIONS_CH, f"⏸️ Spread close blocked by PDT — {_sym}",
                color=Color.YELLOW,
                description=(
                    f"BTC of short leg `{short_occ}` denied by Alpaca Pattern "
                    f"Day Trading protection (account < $25k, day-trade limit "
                    f"hit). Spread is intact; the close can't go through until "
                    f"the PDT restriction clears. Not retrying as an error."
                ),
                footer=f"wheel_strategy.py · {MODE}",
                also_to_actions=False,
            )
            return False
        log_event(LOG_STREAM, "wheel_strategy.py", "spread_close_failed",
                  result="failure", symbol=_sym,
                  details={"leg": "short", "occ": short_occ, "error": detail})
        send_embed(
            ERRORS_CH, f"Spread close failed (short leg) {sym_state.get('spread_type', '?')}",
            color=Color.RED,
            description=(
                f"BTC of short leg `{short_occ}` failed: {detail}. "
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
        detail = alpaca_err_detail(e)
        log(f"_close_spread_legs_individually: STC failed on {long_occ}: {detail}")
        # Half-closed: mark short as gone so orphan handler picks up the long
        sym_state["short_leg"]["qty"] = 0
        _parsed_s = _parse_occ(long_occ)
        _sym_s = _parsed_s[0] if _parsed_s else long_occ
        if not report_pdt_quietly(_sym_s, detail, "Spread STC (orphaned long)"):
            send_embed(
                ERRORS_CH, f"Spread close ORPHANED",
                color=Color.RED,
                description=(
                    f"Short leg `{short_occ}` closed successfully, but STC of "
                    f"long leg `{long_occ}` failed: {detail}. "
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
    _profit_pct_txt = f"{SPREAD_EARLY_CLOSE_PCT:.0%}"
    _stop_pct_txt   = f"{SPREAD_STOP_LOSS_PCT:.0%}"
    title_map = {
        "early_close_50pct":   f"✅ Spread closed ({_profit_pct_txt} profit) — {ticker}",
        "stop_loss_pct":       f"🛑 Spread stopped out — {ticker}",
        "stop_loss_50pct":     f"🛑 Spread stopped out — {ticker}",
        "stop_loss_2x_credit": f"🛑 Spread stopped out — {ticker}",
        "underlying_tripwire": f"🛑 Spread closed (stock crossed short strike) — {ticker}",
        "dte_floor_itm":       f"⏰ Spread closed (DTE floor, ITM) — {ticker}",
    }
    color_map = {
        "early_close_50pct":   Color.GREEN,
        "stop_loss_pct":       Color.YELLOW,
        "stop_loss_50pct":     Color.YELLOW,
        "stop_loss_2x_credit": Color.YELLOW,
        "underlying_tripwire": Color.RED,
        "dte_floor_itm":       Color.YELLOW,
    }
    reason_text = {
        "early_close_50pct":   f"bought to close at {_profit_pct_txt} of credit captured",
        "stop_loss_pct":       f"bought to close at {_stop_pct_txt} of max loss (stop)",
        "stop_loss_50pct":     f"bought to close at {_stop_pct_txt} of max loss (stop)",
        "stop_loss_2x_credit": (
            f"bought to close — cost reached "
            f"{(SPREAD_STOP_CREDIT_MULT or 2.0):.1f}× the credit received (stop)"
        ),
        "underlying_tripwire": "bought to close — stock traded through the short strike",
        "dte_floor_itm":       "bought to close — ≤2 DTE, short leg ITM",
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

    # Marketable close price (2026-05-30 spread-loss fix). The orphan close used
    # to rest at the MID, which never fills on the illiquid dying options these
    # orphans usually are — yet state was deleted immediately, dropping the
    # surviving leg out of spread tracking and into long_options_strategy, where
    # it churned a stuck stop-loss for days (AAL 06/12 $12.50 put). Price to
    # actually transact: pay the ask to buy back a short, hit the bid to sell a
    # long. Falls back to the entry premium only when no quote is available.
    def _marketable_or_entry(occ: str, side: str, entry: float) -> float:
        q = get_option_quote(occ)
        if not q:
            return entry
        if side == "buy":   # BTC the short — pay the ask to get filled
            return round(max(q["ask"], SPREAD_OPEN_MIN_LIMIT), 2)
        # STC the long — hit the bid to get filled
        return round(max(q["bid"], SPREAD_OPEN_MIN_LIMIT), 2)

    if short_present and not long_present:
        # Long leg gone (expired alone, manually closed, etc.) — BTC the short
        try:
            place_buy_to_close(short_occ, _marketable_or_entry(short_occ, "buy", sym_state["short_leg"]["entry_premium"]))
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
            detail = alpaca_err_detail(e)
            log(f"_handle_orphan_leg short BTC failed: {detail}")
            if not report_pdt_quietly(ticker, detail, "Orphan BTC"):
                send_embed(ERRORS_CH, f"Orphan resolution failed for {ticker}",
                           color=Color.RED,
                           description=f"BTC of {short_occ} failed: {detail}. State left intact for retry.",
                           footer=f"wheel_strategy.py · {MODE}", actions_channel=ACTIONS_CH)
        return

    if long_present and not short_present:
        # Short leg gone (assigned overnight, etc.) — STC the long
        try:
            place_sell_to_close(long_occ, _marketable_or_entry(long_occ, "sell", sym_state["long_leg"]["entry_premium"]))
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
            detail = alpaca_err_detail(e)
            log(f"_handle_orphan_leg long STC failed: {detail}")
            if not report_pdt_quietly(ticker, detail, "Orphan STC"):
                send_embed(ERRORS_CH, f"Orphan resolution failed for {ticker}",
                           color=Color.RED,
                           description=f"STC of {long_occ} failed: {detail}. State left intact for retry.",
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

    # R10 (2026-06-16): a corrupted/half-written state with net_credit or
    # max_loss == None (or non-numeric) would crash the float() conversions
    # below (in _compute_spread_pnl and here) and leave the spread UNMANAGED.
    # Skip the cycle with a warning rather than raise — a bot-opened spread
    # reconciles net_credit from the fill and an adopted one derives it from the
    # legs, so both should be set, but defend against a bad state file.
    try:
        float(sym_state["net_credit"])
        float(sym_state["max_loss"])
    except (TypeError, ValueError, KeyError):
        log(f"[{ticker}] spread heartbeat — net_credit/max_loss missing or "
            f"non-numeric (net_credit={sym_state.get('net_credit')!r}, "
            f"max_loss={sym_state.get('max_loss')!r}) — skipping cycle")
        log_event(LOG_STREAM, "wheel_strategy.py", "spread_state_invalid",
                  result="skipped", symbol=ticker,
                  details={"net_credit": sym_state.get("net_credit"),
                           "max_loss": sym_state.get("max_loss")})
        return

    pnl = _compute_spread_pnl(sym_state, close_cost)
    max_loss = float(sym_state["max_loss"])

    # Mid-based close cost for the STOP only (2026-05-30 spread-loss fix). The
    # PROFIT trigger keeps using the worst-case executable cost above (so we
    # never claim a false 50% win), but evaluating the STOP on that same
    # worst-case price trips a "loss" on the bid/ask width itself — MU stopped
    # out 20 min after opening purely because short_ask - long_bid was already
    # wide. The mid (short_mid - long_mid) is the symmetric, quote-noise-robust
    # value to judge a real loss against; the underlying tripwire below is the
    # backstop for genuine adverse moves.
    short_mid = (short_q["bid"] + short_q["ask"]) / 2.0
    long_mid  = (long_q["bid"] + long_q["ask"]) / 2.0
    close_cost_mid = round(short_mid - long_mid, 4)
    loss_per_share_mid = round(close_cost_mid - float(sym_state["net_credit"]), 4)

    # 2a. Underlying-price tripwire. If the stock has traded through the short
    # strike, close immediately — robust to degenerate/illiquid option quotes
    # where the option-quote stop could otherwise miss the trigger by reading a
    # stale mid. Runs BEFORE the profit trigger because position-based risk
    # takes precedence over price-based gains; the spec is explicit about this
    # ordering. SM modes enable this via spread_stop_credit_mult; manual enables
    # it via spread_underlying_tripwire (2026-05-30).
    # tripwire_pending (R8, 2026-06-16): set when the stock is through the short
    # strike but the confirmation window hasn't elapsed. While pending we defer
    # ONLY the noise-prone loss-stop — the profit trigger and the DTE-floor close
    # still run (both are legitimate "get out" signals; blocking a 50%-profit
    # close for up to an hour because of a strike wick let winners reverse).
    tripwire_pending = False
    if SPREAD_UNDERLYING_TRIPWIRE:
        short_strike = float(sym_state["short_leg"]["strike"])
        spread_type = sym_state["spread_type"]
        # DTE gate (2026-06-16). The tripwire is only a meaningful risk signal
        # near expiration, where an ITM short leg means real pin/assignment risk.
        # Far from expiry a strike touch on a defined-risk spread is noise — the
        # loss is capped at the width — so don't even arm. SPREAD_TRIPWIRE_DTE is
        # None for SM/legacy modes (armed at all DTEs, original behavior).
        from datetime import date as _date
        _tw_dte = (_date.fromisoformat(sym_state["expiration"]) - _date.today()).days
        tripwire_armed = (SPREAD_TRIPWIRE_DTE is None) or (_tw_dte <= SPREAD_TRIPWIRE_DTE)
        # get_latest_price raises on HTTP/network failure; wrap so the
        # tripwire degrades to a heartbeat skip rather than crashing the
        # whole symbol's cycle. The None-guard below then handles cleanly.
        try:
            stock_price = get_latest_price(ticker)
        except Exception:
            stock_price = None
        if not tripwire_armed:
            # Outside the arm window — if a stale breach timestamp lingers (e.g.
            # the gate tightened mid-trade), clear it so it can't confirm later.
            if sym_state.get("tripwire_breach_since") is not None:
                sym_state["tripwire_breach_since"] = None
        elif stock_price is not None:
            tripped = (
                (spread_type == "put_credit"  and stock_price <= short_strike) or
                (spread_type == "call_credit" and stock_price >= short_strike)
            )
            if tripped:
                # Persistence/confirmation (2026-06-16). Don't close on the first
                # touch — record the breach time and only close once the stock
                # has stayed through the strike for SPREAD_TRIPWIRE_CONFIRM_MINUTES
                # of *continuous* breach. A recovery above the strike (else branch
                # below) resets the clock. CONFIRM_MINUTES == 0 (SM/legacy) closes
                # on the first touch, since the freshly-set timestamp reads ~0m.
                if sym_state.get("tripwire_breach_since") is None:
                    sym_state["tripwire_breach_since"] = (
                        datetime.utcnow().isoformat() + "Z"
                    )
                breach_min = _tripwire_breach_minutes(sym_state)
                if breach_min >= SPREAD_TRIPWIRE_CONFIRM_MINUTES:
                    log(f"[{ticker}] spread underlying tripwire — stock "
                        f"${stock_price:.2f} through short strike ${short_strike:.2f} "
                        f"({spread_type}) for {breach_min:.0f}m >= "
                        f"{SPREAD_TRIPWIRE_CONFIRM_MINUTES}m — closing")
                    _close_spread(state, ticker, reason="underlying_tripwire")
                    return
                # Still inside the confirmation window — defer ONLY the loss-stop
                # (R8). The profit trigger and DTE-floor close below still run so
                # a 50%-profit close or a 2-DTE-ITM exit isn't blocked by a strike
                # wick. The loss can't exceed the width while we wait on the stop.
                tripwire_pending = True
                log(f"[{ticker}] spread underlying tripwire pending — stock "
                    f"${stock_price:.2f} through short strike ${short_strike:.2f}, "
                    f"breached {breach_min:.0f}m of "
                    f"{SPREAD_TRIPWIRE_CONFIRM_MINUTES}m — deferring loss-stop only")
                log_event(LOG_STREAM, "wheel_strategy.py", "spread_tripwire_pending",
                          result="skipped", symbol=ticker,
                          details={"stock_price": stock_price,
                                   "short_strike": short_strike,
                                   "breach_minutes": round(breach_min, 1),
                                   "confirm_minutes": SPREAD_TRIPWIRE_CONFIRM_MINUTES,
                                   "dte": _tw_dte})
            else:
                # Stock recovered above the short strike — reset any pending
                # breach so the confirmation clock restarts on the next breach.
                if sym_state.get("tripwire_breach_since") is not None:
                    log(f"[{ticker}] spread underlying tripwire reset — stock "
                        f"${stock_price:.2f} recovered above short strike "
                        f"${short_strike:.2f}")
                    sym_state["tripwire_breach_since"] = None

    # 2. Profit trigger
    if pnl["profit_pct"] >= SPREAD_EARLY_CLOSE_PCT:
        log(f"[{ticker}] spread profit_pct={pnl['profit_pct']:.2%} >= "
            f"{SPREAD_EARLY_CLOSE_PCT:.0%} — closing at profit")
        _close_spread(state, ticker, reason="early_close_50pct")
        return

    # 3. Stop loss trigger — evaluated on the MID (close_cost_mid), not the
    # worst-case executable cost, so the bid/ask width can't fake a loss.
    # Suppressed for SPREAD_SETTLE_MINUTES after open so a freshly-filled spread
    # on a wide chain can't insta-stop on quote noise before it settles (the
    # underlying tripwire above still fires on a real adverse move during the
    # settling window).
    if tripwire_pending:
        log(f"[{ticker}] tripwire breach pending — deferring the loss-stop this "
            f"cycle (profit + DTE-floor still active)")
    elif _within_settling_window(sym_state):
        log(f"[{ticker}] spread within {SPREAD_SETTLE_MINUTES}m settling window "
            f"— skipping loss-stop check this cycle")
    elif SPREAD_STOP_CREDIT_MULT is not None:
        # SM modes: fire when the mid buy-back cost reaches N x the credit
        # received — a small, bounded dollar loss the 10-min cron can catch.
        net_credit = float(sym_state["net_credit"])
        stop_price = net_credit * SPREAD_STOP_CREDIT_MULT
        if close_cost_mid >= stop_price:
            log(f"[{ticker}] spread close_cost_mid=${close_cost_mid:.2f} >= "
                f"{SPREAD_STOP_CREDIT_MULT:.1f}x credit ${net_credit:.2f} "
                f"(${stop_price:.2f}) — stopping out")
            _close_spread(state, ticker, reason="stop_loss_2x_credit")
            return
    else:
        # Other modes: % of max loss, judged on the mid loss.
        if loss_per_share_mid >= max_loss * SPREAD_STOP_LOSS_PCT:
            log(f"[{ticker}] spread loss(mid)=${loss_per_share_mid:.2f} >= "
                f"{SPREAD_STOP_LOSS_PCT:.0%} of max_loss=${max_loss:.2f} — stopping out")
            _close_spread(state, ticker, reason="stop_loss_pct")
            return

    # 4. DTE floor with ITM check
    from datetime import date as _date
    expiry = _date.fromisoformat(sym_state["expiration"])
    days_to_expiry = (expiry - _date.today()).days
    if days_to_expiry <= SPREAD_DTE_FLOOR and not tripwire_pending:
        # tripwire_pending guard (R8): at ≤2 DTE the DTE-floor and the tripwire
        # are the SAME signal, and the tripwire's confirmation window exists
        # precisely to let a ≤2-DTE strike wick recover (the MU case) before
        # closing. Running the DTE-floor here would nullify that window, so it's
        # deferred while a breach is pending; the tripwire's own 60-min
        # confirmation is the backstop for a sustained ITM move. The PROFIT
        # trigger above still runs during pending (that was the real R8 bug).
        short_strike = float(sym_state["short_leg"]["strike"])
        # R9 (2026-06-16): guard the price fetch like the tripwire above. An
        # unhandled network/HTTP error here used to abort the whole symbol cycle
        # and skip the DTE-floor close — risking assignment on an ITM short near
        # expiry. On failure, skip this check for the cycle (the next 10-min cron
        # retries) rather than crash.
        try:
            stock_price = get_latest_price(ticker)
        except Exception:
            stock_price = None
        spread_type = sym_state["spread_type"]
        short_itm = stock_price is not None and (
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


def _gen_client_order_id() -> str:
    """A unique client_order_id for an order POST (R1 — idempotent retries).

    Stamped once per `api_post('/orders')` call and reused verbatim on every
    transport-level retry of that same call (the body is built before
    `_alpaca_request`'s retry loop), so a lost response that triggers a retry
    re-sends the SAME id. Alpaca rejects a duplicate client_order_id (422),
    which `api_post` treats as success — the original attempt already created
    the order — making POST /orders retries idempotent and closing the
    double-place hazard. A genuinely new order gets a fresh id, so distinct
    orders are never falsely rejected. Mode-prefixed for traceability; well
    under Alpaca's 128-char limit.
    """
    return f"{MODE or 'bot'}-{uuid.uuid4().hex}"


def _get_order_by_client_id(client_order_id):
    """Fetch an order by its client_order_id, or None if it can't be resolved.

    Used to recover the already-created order when a retried POST /orders is
    rejected as a duplicate. Never raises — a failure to resolve returns None
    so the caller can surface the original error rather than silently no-op.
    """
    if not client_order_id:
        return None
    try:
        resp = _alpaca_request(
            "GET", f"{BASE_URL}/orders:by_client_order_id",
            headers=HEADERS, params={"client_order_id": client_order_id})
        if resp.status_code == 200:
            return resp.json()
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        pass
    return None


def api_post(path, body):
    # R1 — idempotent order placement. Every POST /orders carries a
    # client_order_id so a transport-level retry after a lost response can't
    # double-place: the retry re-sends the identical body (same id), Alpaca
    # rejects the duplicate (422), and we resolve to the already-created order
    # instead of raising. Non-order POSTs are unaffected.
    if path == "/orders" and isinstance(body, dict) and "client_order_id" not in body:
        body = {**body, "client_order_id": _gen_client_order_id()}
    resp = _alpaca_request("POST", f"{BASE_URL}{path}", headers=HEADERS, json=body)
    if (path == "/orders" and resp.status_code == 422
            and isinstance(body, dict)
            and "client_order_id" in (resp.text or "").lower()):
        coid = body.get("client_order_id")
        log(f"order client_order_id={coid} already exists — a retry reached "
            f"Alpaca after the original POST already created the order; "
            f"resolving to the existing order instead of failing")
        existing = _get_order_by_client_id(coid)
        if existing is not None:
            return existing
        # Couldn't fetch it back — fall through to raise so the caller sees a
        # failure rather than a silent no-op.
    resp.raise_for_status()
    return resp.json()


def api_delete(path):
    resp = _alpaca_request("DELETE", f"{BASE_URL}{path}", headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


def alpaca_err_detail(e) -> str:
    """Render an Alpaca exception WITH the response body.

    `requests`' raise_for_status() raises an HTTPError whose str() is only
    the status line ("403 Client Error: Forbidden for url: ..."). Alpaca's
    actual reason (e.g. {"code":40310000,"message":"insufficient buying
    power"} or a wash-trade message) lives in the response BODY, which the
    bare exception drops. Order rejections were surfacing as opaque 403s
    with no reason (NVDA spread close 403-looping 2026-06-02). This appends
    the body so #errors states WHY the order failed.
    """
    msg = f"{type(e).__name__}: {e}"
    resp = getattr(e, "response", None)
    if resp is not None:
        body = (getattr(resp, "text", "") or "").strip()
        if body:
            msg = f"{msg} — {body[:400]}"
    return msg


def is_pdt_denied(detail: str) -> bool:
    """True if an Alpaca order failure is a Pattern Day Trading block.

    Alpaca denies orders on a sub-$25k margin account that has exceeded the
    day-trade limit with HTTP 403 + body {"code":40310100,"message":"trade
    denied due to pattern day trading protection"}. This is NOT a fixable
    per-cycle error — retrying just re-trips it — so callers route it to the
    actions firehose (a quiet "can't close today, will retry" notice) rather
    than pinging the errors channel every 10 minutes (NVDA spread close loop
    on manual, 2026-06-03).
    """
    d = (detail or "").lower()
    return "40310100" in d or "pattern day trading" in d


def report_pdt_quietly(symbol: str, detail: str, context: str) -> bool:
    """Centralized PDT-block policy for every wheel close boundary.

    If `detail` is a PDT denial, post a quiet notice to the actions channel,
    log it as `pdt_blocked` (skipped), and return True so the caller treats
    the action as handled rather than a hard error. Otherwise return False so
    the caller emits its normal #errors embed. A PDT block is an account-state
    condition (sub-$25k margin account over the day-trade limit), not a
    fixable per-cycle bug — quieting it everywhere keeps #errors meaningful
    while the position stays intact until the restriction clears (2026-06-03).
    """
    if not is_pdt_denied(detail):
        return False
    send_embed(
        ACTIONS_CH, f"⏸️ {context} blocked by PDT — {symbol}",
        color=Color.YELLOW,
        description=(
            f"{context} for {symbol} was denied by Alpaca Pattern Day Trading "
            f"protection (account < $25k, day-trade limit hit). Position is "
            f"intact; can't act until the PDT restriction clears."
        ),
        footer=f"wheel_strategy.py · {MODE}",
        also_to_actions=False,
    )
    log_event(LOG_STREAM, "wheel_strategy.py", "pdt_blocked",
              result="skipped", symbol=symbol, notes=(detail or "")[:400])
    return True


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


def get_recent_daily_closes(symbol: str, n: int = 20) -> list:
    """Return the last `n` daily close prices for `symbol`, oldest first.

    Returns [] on any failure (HTTP error, bad payload, exception).
    Used by the SM auto-spread engine's trend gate; callers expect
    empty-list-means-don't-trade.
    """
    try:
        from datetime import date, timedelta
        end = date.today()
        start = end - timedelta(days=n * 2 + 7)  # weekends + holiday cushion
        url = (
            f"https://data.alpaca.markets/v2/stocks/{symbol}/bars"
            f"?timeframe=1Day&start={start.isoformat()}&end={end.isoformat()}"
            f"&limit={n + 10}&feed=iex&adjustment=raw"
        )
        resp = _alpaca_request("GET", url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            return []
        bars = resp.json().get("bars") or []
        closes = [float(b["c"]) for b in bars if "c" in b]
        return closes[-n:]
    except Exception:
        return []


def find_contract_by_delta(underlying_symbol, option_type, target_delta,
                            exp_min_days, exp_max_days):
    """Find the contract whose Δ is closest to target_delta within the expiry
    window. Returns a contract-shaped dict ({symbol, strike_price,
    expiration_date}) matching `find_best_contract` so callers can swap.

    Uses the chain-snapshot endpoint (returns greeks + quotes in one shot)
    rather than the contracts endpoint (no greeks). Falls back to None if
    no snapshot has a delta — production-time chain data sometimes lags
    greek computation; we'd rather skip the symbol that cycle than commit
    to a strike we couldn't price.

    target_delta is signed — pass −0.40 for the short put leg, NOT 0.40.
    """
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    exp_min = (today + _td(days=exp_min_days)).isoformat()
    exp_max = (today + _td(days=exp_max_days)).isoformat()

    try:
        resp = _alpaca_request(
            "GET",
            f"{OPTIONS_DATA_URL}/options/snapshots/{underlying_symbol}",
            headers=HEADERS,
            params={
                "feed":               "indicative",
                "type":               option_type,
                "expiration_date_gte": exp_min,
                "expiration_date_lte": exp_max,
                "limit":              1000,
            },
            timeout=10,
        )
        resp.raise_for_status()
        snapshots = resp.json().get("snapshots", {})
    except Exception as e:
        log(f"find_contract_by_delta({underlying_symbol}) snapshot fetch failed: "
            f"{type(e).__name__}: {e}")
        return None

    if not snapshots:
        return None

    # Pick the closest-delta entry. OCC symbol encodes strike + expiry so we
    # can hand back the same shape `find_best_contract` returns.
    best = None
    best_diff = float("inf")
    for occ, snap in snapshots.items():
        greeks = snap.get("greeks") or {}
        d = greeks.get("delta")
        if d is None:
            continue
        diff = abs(float(d) - target_delta)
        if diff < best_diff:
            best_diff = diff
            best = (occ, snap)

    if best is None:
        return None

    occ, snap = best
    strike, expiration = _parse_occ_strike_expiry(occ)
    if strike is None or expiration is None:
        return None
    return {
        "symbol":           occ,
        "strike_price":     str(strike),
        "expiration_date":  expiration,
    }


def _parse_occ_strike_expiry(occ: str) -> tuple[float | None, str | None]:
    """Pull strike (float) and expiration (YYYY-MM-DD) out of an OCC symbol.

    OCC format: <UNDERLYING><YYMMDD><C|P><strike*1000 padded to 8 digits>
    e.g. QQQ260618P00702000 -> strike 702.0, expiration 2026-06-18.
    """
    import re
    m = re.match(r"^[A-Z]+(\d{6})[CP](\d{8})$", occ)
    if not m:
        return None, None
    yymmdd, strike_str = m.group(1), m.group(2)
    try:
        year  = 2000 + int(yymmdd[0:2])
        month = int(yymmdd[2:4])
        day   = int(yymmdd[4:6])
        strike = int(strike_str) / 1000.0
        return strike, f"{year:04d}-{month:02d}-{day:02d}"
    except (ValueError, IndexError):
        return None, None


def find_best_contract(underlying_symbol, option_type, target_strike,
                        exp_min_days, exp_max_days, exp_date=None):
    """Find the contract closest to target_strike within the expiry window.

    When `exp_date` is provided (YYYY-MM-DD string), restricts the search to
    that exact expiration — used by the auto-spread long-leg picker to force
    the long to the same expiration as the already-chosen short (otherwise
    the strike-distance × expiration-distance scoring can produce a diagonal
    instead of a vertical). Existing callers that don't pass exp_date keep
    the original behaviour byte-for-byte.
    """
    today = date.today()
    if exp_date is not None:
        # Hard-constrain the API query to a single expiration. Bound the
        # DTE window check on top so we don't bypass the caller's intent.
        exp_min = exp_date
        exp_max = exp_date
    else:
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
        exp_date_c  = date.fromisoformat(c["expiration_date"])
        exp_diff    = abs((exp_date_c - target_exp).days)
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


def place_buy_to_close(option_symbol, limit_price, qty=None, max_qty=None):
    """Buy-to-close a short option position.

    qty: number of contracts to close. If None (default), looks up the
    actual short position size on Alpaca and closes ALL of it (capped at
    max_qty when provided). Pass an explicit qty only when you want a
    deliberate partial close.

    Why default to "look up": before this fix the function hardcoded
    qty="1", which broke when a state-persistence bug let the wheel sell
    duplicate puts on the same symbol (MARA went to qty=-4 on 2026-04-30).

    max_qty (R19, 2026-06-16): cap the auto-lookup close at the bot's TRACKED
    contract count so we never buy back MORE than the bot is responsible for.
    If the live position is larger than tracked — e.g. the user hand-sold extra
    contracts on the same OCC — close only the tracked amount and leave the
    user's extra alone. The bot-duplicate case that motivated the full
    auto-lookup is now prevented at the source by client_order_id idempotency
    (R1), so capping is safe.
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
        if max_qty is not None:
            try:
                cap = abs(int(max_qty))
            except (ValueError, TypeError):
                cap = qty
            if 0 < cap < qty:
                log(f"place_buy_to_close: capping close of {option_symbol} at "
                    f"tracked {cap} (live position {qty}) — leaving user's extra")
                qty = cap

    # R34 (2026-06-16): nudge the limit up to ensure a fill, but by a PERCENTAGE
    # (≈5%, floored at 1¢) rather than a flat $0.05. On a cheap option ($0.05) a
    # flat $0.05 DOUBLED the buy-back cost; the % keeps the concession small.
    concession = max(0.01, round(limit_price * 0.05, 2))
    order = api_post("/orders", {
        "symbol":          option_symbol,
        "qty":             str(qty),
        "side":            "buy",
        "type":            "limit",
        "limit_price":     str(round(limit_price + concession, 2)),
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


def get_option_quote(contract_symbol, require_bid=True):
    """Fetch the current bid/ask for an option contract.

    Returns dict {"bid": float, "ask": float} or None if unavailable.
    Note: Alpaca options data lives under v1beta1, NOT v2 (stock data uses v2).

    require_bid=False (R15): accept a $0 bid as long as the ask > 0. Used ONLY
    for a LONG spread leg — we BUY it, so a positive ask is all that's needed,
    and a far-OTM long hedge legitimately shows bid $0.00 / ask $0.05. The
    default True keeps every other caller strict: a SHORT leg we must be able to
    sell needs a real two-sided market.
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
            if ask > 0 and (bid > 0 or not require_bid):
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


def _close_mark_and_limit(contract):
    """(mark, btc_limit) for closing a SHORT option at the 50%-profit rule (R4).

    mark      = live quote MID — used for the close DECISION (check_early_close).
                Robust to a stale last trade, which on an illiquid contract can
                read far from the real market and either miss the trigger or
                fire on a phantom price.
    btc_limit = MARKETABLE buy-to-close price (the ASK), so the order actually
                fills instead of resting unfilled at a stale-derived limit. The
                old code priced the BTC off the last trade (+$0.05); when that
                sat below the ask the order never filled, yet state was cleared
                to "closed" and (on cons/agg) a new put was sold → false state /
                double short. Falls back to the last trade when no two-sided
                quote exists. Returns (None, None) if no price is available.
    """
    q = get_option_quote(contract)
    if q and q.get("bid") is not None and q.get("ask") is not None:
        bid, ask = float(q["bid"]), float(q["ask"])
        mid = round((bid + ask) / 2.0, 2)
        if mid > 0 and ask > 0:
            return mid, round(ask, 2)
    last = get_option_last_price(contract)
    if last is None or last <= 0:
        return None, None
    return last, last


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


def _tripwire_breach_minutes(sym_state) -> float:
    """Minutes of continuous breach since the underlying tripwire first armed.

    Reads `tripwire_breach_since` (ISO8601, '...Z'), set on the cycle the stock
    first traded through the short strike and cleared the moment it recovers
    above it. Returns 0.0 on missing/unparseable input — defensive, mirrors
    _spread_order_age_hours: a parse error must never spuriously confirm a close.
    """
    since = sym_state.get("tripwire_breach_since")
    if not since:
        return 0.0
    try:
        dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 60.0
    except (ValueError, TypeError):
        return 0.0


def _within_settling_window(sym_state) -> bool:
    """True if the spread opened/was adopted less than SPREAD_SETTLE_MINUTES ago.

    Used to suppress the loss-stop on a freshly-filled spread so a wide bid/ask
    on an illiquid chain can't insta-trip a "loss" before the quote settles
    (MU 2026-05-29 stopped out 20 min after opening on pure quote noise). The
    underlying-price tripwire is intentionally NOT gated by this — a genuine
    adverse move should always close, settling window or not. Returns False
    when SPREAD_SETTLE_MINUTES is 0 (feature off) or opened_at is missing.
    """
    if not SPREAD_SETTLE_MINUTES:
        return False
    # R22 (2026-06-16): the settling window only makes sense for a freshly-FILLED
    # BOT-opened spread (suppress an insta-stop on a fresh fill's quote noise).
    # An ADOPTED / hand-opened spread has no open_order_id — its `opened_at` is
    # just the adoption timestamp, and the position may be old — so its loss-stop
    # must NOT be suppressed for 20 minutes after we happen to discover it.
    if not sym_state.get("open_order_id"):
        return False
    # Unknown open time must NOT suppress the stop — _spread_order_age_hours
    # returns 0.0 on a missing/unparseable opened_at, which would otherwise read
    # as "just opened" forever and disable the stop entirely. Only a genuinely
    # recent, parseable open counts as settling.
    if not sym_state.get("opened_at"):
        return False
    age_h = _spread_order_age_hours(sym_state)
    return (age_h * 60.0) < SPREAD_SETTLE_MINUTES


def _short_put_has_live_hedge(symbol: str, sym_state: dict, positions: list) -> bool:
    """True if this Stage-1 short PUT still has an un-paired long PUT hedge.

    A short put with a long put at a LOWER strike and the SAME expiration is the
    short leg of a put credit spread. When _detect_spread_pairs fails to pair
    them (e.g. a split-fill qty mismatch), the short falls through to single-leg
    Stage-1 adoption — and handle_stage1 would buy it back at 50% profit while
    the long hedge is abandoned to long_options_strategy, which rots it to a
    loss. That is exactly the "short closes at 50% gain, long closes at full
    loss" bleed the user reported on AAL. When this returns True the caller
    holds the position instead of managing it naked.
    """
    if sym_state.get("stage") != 1 or sym_state.get("contract_type") != "put":
        return False
    short_strike = sym_state.get("contract_strike")
    short_exp = sym_state.get("contract_expiration")
    if short_strike is None or not short_exp:
        return False
    short_exp_date = str(short_exp)[:10]  # ISO date prefix
    for pos in positions:
        if pos.get("asset_class") != "us_option":
            continue
        try:
            qty = int(float(pos["qty"]))
        except (KeyError, ValueError, TypeError):
            continue
        if qty <= 0:  # hedge leg is LONG (positive qty)
            continue
        parsed = _parse_occ(pos.get("symbol", ""))
        if not parsed:
            continue
        t, opt_type, strike, expiry = parsed
        if t != symbol or opt_type != "put":
            continue
        if expiry.isoformat() != short_exp_date:
            continue
        if strike < float(short_strike):
            return True
    return False


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
    order_id   = sym_state.get("open_order_id")
    client_oid = sym_state.get("open_client_order_id")
    if not order_id and not client_oid:
        # Adopted/hand-opened spread (neither id) → existing position/orphan path.
        return "gone"
    # R13: if the numeric id was lost/None from the open response but we kept the
    # client_order_id (R1 stamps it on every order POST; Alpaca echoes it),
    # resolve the pending order by that instead of misreading a still-working
    # open as "gone" — which would prematurely delete state and fire a
    # misleading "did not fill" embed.
    order = get_order(order_id) if order_id else _get_order_by_client_id(client_oid)
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
        # R17 (2026-06-16): market_value is the value of ALL contracts on this
        # OCC combined, so divide by 100 × qty to get the PER-CONTRACT price.
        # Dividing by a flat 100 returned an N×-too-high price on a multi-
        # contract position (e.g. the MARA quad), which kept the 50%-profit
        # close from ever triggering.
        mv = abs(float(pos.get("market_value", 0)))
        try:
            qty = abs(int(float(pos.get("qty", 1)))) or 1
        except (ValueError, TypeError):
            qty = 1
        return mv / (100.0 * qty)
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

            current_price, btc_limit = _close_mark_and_limit(contract)
            if current_price is not None:
                entry = sym_state.get("contract_entry_price")
                if entry and check_early_close(sym_state, current_price):
                    log(f"[{symbol}] 50% PROFIT RULE: {contract} @ ${current_price:.2f} vs entry ${entry:.2f}. Closing (marketable @ ${btc_limit:.2f}).")
                    # place_buy_to_close auto-detects qty and closes the bot's
                    # contracts on this OCC in one order, capped at the tracked
                    # count (R19). Priced marketable (R4) so it actually fills.
                    place_buy_to_close(contract, btc_limit,
                                       max_qty=sym_state.get("contract_qty"))
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
            cur_qty = int(float(stock_pos.get("qty", 0))) if stock_pos else 0
            covered = max(1, (sym_state.get("shares_qty") or 100) // 100) * 100
            # R18 (2026-06-16): only treat the position as "called away" when the
            # shares are actually GONE (qty <= 0). The old `< 100` heuristic
            # misfired on a non-100-lot adoption or a partial manual sell (e.g.
            # 200 → 50 shares left), wrongly declaring an assignment — which
            # dropped the remaining shares from management and could leave a
            # partially-naked call. A 1..covered-1 remainder is ambiguous: alert
            # and hold rather than guess.
            if 0 < cur_qty < covered:
                log(f"[{symbol}] Stage 2: call gone but {cur_qty} shares remain "
                    f"(covered {covered}) — ambiguous (partial sell / odd lot); "
                    f"holding, not declaring assignment")
                send_embed(
                    ERRORS_CH, f"Wheel: {symbol} Stage 2 ambiguous share count",
                    color=Color.YELLOW,
                    description=(
                        f"Covered call `{contract}` is gone but {cur_qty} shares "
                        f"remain (expected ~0 if assigned, {covered} if expired). "
                        f"Not auto-classifying — manage manually."
                    ),
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "stage2_ambiguous_shares",
                          result="skipped", symbol=contract,
                          details={"underlying": symbol, "cur_qty": cur_qty,
                                   "covered": covered})
                return
            if cur_qty <= 0:
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
                # R25 (2026-06-16): increment cycle_count + append history like
                # the assigned and put-expired paths do (the CC-expired path was
                # the only one that skipped it, leaving cycle reporting off by one
                # whenever a covered call expired worthless).
                sym_state["cycle_count"]          += 1
                sym_state["cycle_history"].append({
                    "cycle": sym_state["cycle_count"],
                    "type": "call",
                    "symbol": contract,
                    "outcome": "expired_worthless",
                    "premium": premium_dollars,
                    "contracts": contracts_held,
                })
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

            current_price, btc_limit = _close_mark_and_limit(contract)
            if current_price is not None:
                entry = sym_state.get("contract_entry_price")
                if entry and check_early_close(sym_state, current_price):
                    log(f"[{symbol}] 50% PROFIT RULE on call: closing (marketable @ ${btc_limit:.2f}).")
                    # place_buy_to_close auto-detects qty, capped at the bot's
                    # tracked contract count (R19). Priced marketable (R4).
                    place_buy_to_close(contract, btc_limit,
                                       max_qty=sym_state.get("contract_qty"))
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
            # R11 (2026-06-16): net_credit is derived from Alpaca's per-leg
            # avg_entry_price, which can mis-split an mleg fill (most of the
            # credit on one leg, ~0 on the other). A valid credit spread
            # satisfies 0 < net_credit < width; outside that band the P&L math
            # (profit_pct, max_loss) is corrupt from the moment of adoption.
            # Clamp into a sane band and warn rather than seed a broken basis —
            # the spread is a real position that still needs management.
            if not (0 < net_credit < width):
                hi = max(0.01, round(width - 0.01, 4))
                clamped = round(min(max(net_credit, 0.01), hi), 4)
                log(f"[{ticker}] adopted spread net_credit ${net_credit:.4f} "
                    f"outside (0, width ${width:.2f}) — per-leg entries look "
                    f"mis-split; clamping to ${clamped:.4f} for management")
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "spread_adopt_net_credit_clamped", result="success",
                          symbol=ticker,
                          details={"short_occ": s["occ"], "long_occ": l["occ"],
                                   "raw_net_credit": net_credit, "width": width,
                                   "clamped": clamped})
                net_credit = clamped
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
    occs_present = {p["symbol"] for p in positions
                    if p.get("asset_class") == "us_option"}

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
        # R21 (2026-06-16): the wheel state tracks ONE contract per ticker. If
        # this ticker already tracks a DIFFERENT contract that is still a live
        # position, don't clobber it with this second short — a user holding two
        # short options on the same underlying would otherwise have the first
        # silently overwritten (and dropped from management). Keep the first;
        # surface the untracked second instead of losing it.
        tracked = sym_state.get("current_contract")
        if tracked and tracked != symbol and tracked in occs_present:
            log(f"[wheel-discover] {ticker} already tracks {tracked}; a second "
                f"short {symbol} on the same underlying is NOT wheel-tracked "
                f"(one contract per ticker)")
            log_event(LOG_STREAM, "wheel_strategy.py", "second_short_untracked",
                      result="skipped", symbol=symbol,
                      details={"underlying": ticker, "tracked": tracked})
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


def credit_ratio_passes(net_credit: float, width: float, min_ratio: float) -> bool:
    """Return True iff net_credit / width >= min_ratio.

    Degenerate width (<= 0) is treated as a fail (defensive — width
    should never be <= 0 by the time this is called, but if it ever is
    we won't divide by zero).
    """
    if width <= 0:
        return False
    return (net_credit / width) >= min_ratio


def compute_open_limit_credit(mid_credit: float, marketable_credit: float,
                              concession_pct: float, min_pct_of_mid: float,
                              floor: float = SPREAD_OPEN_MIN_LIMIT) -> float:
    """Pick the credit to place a credit-spread opening limit at.

    We believe `mid_credit` (short_mid - long_mid) is fair value. Crossing all
    the way to `marketable_credit` (short_bid - long_ask) guarantees an instant
    fill but gives away the entire bid/ask width on entry — that is how MU
    opened at $1.50 against a $3.65 mid on 2026-05-29.

    Instead we rest the limit between the mid and the marketable cross: give up
    at most `concession_pct` of the (mid - marketable) gap, and never accept
    less than `min_pct_of_mid` of the mid. Floored at `floor`.

      concession_pct = 0.0  -> rest exactly at the mid (best price, may not fill)
      concession_pct = 1.0  -> full marketable cross (legacy behavior)

    A resting unfilled order is safe now that the opener tracks open_order_id
    and stale-cancels — non-fills cost nothing, a bad fill costs real money.
    """
    if mid_credit <= 0:
        # Degenerate mid — fall back to the marketable cross, floored.
        return max(round(marketable_credit, 2), floor)
    gap = max(mid_credit - marketable_credit, 0.0)
    target = mid_credit - concession_pct * gap
    # Never accept less than the configured fraction of the mid...
    target = max(target, min_pct_of_mid * mid_credit)
    # ...and never demand MORE than the mid (an above-mid ask never fills).
    target = min(target, mid_credit)
    return max(round(target, 2), floor)


def pick_best_ratio_width(candidates: list) -> dict | None:
    """Pick the candidate with the highest net_credit/width ratio.

    Each candidate is a dict containing at least 'width' and 'net_credit'.
    Returns None on empty input. Stable on ties — first candidate wins
    (which gives the narrowest of equally-good ratios, fine).
    """
    if not candidates:
        return None
    return max(candidates, key=lambda c: c["net_credit"] / c["width"])


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

    Raises ValueError if the two OCC symbols don't share an expiration —
    Alpaca's mleg endpoint will happily accept a diagonal (different
    expirations), but the bot's pairing + management code requires a
    vertical. Reject early rather than open a spread the bot can't
    pair on the next cycle.
    """
    short_exp = _parse_occ_strike_expiry(short_occ)[1]
    long_exp  = _parse_occ_strike_expiry(long_occ)[1]
    if short_exp is None or long_exp is None or short_exp != long_exp:
        raise ValueError(
            f"_open_spread_mleg refused mismatched expirations: "
            f"short={short_occ} (exp={short_exp}) "
            f"long={long_occ} (exp={long_exp}) — would have placed a "
            f"diagonal, not a vertical"
        )
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
    target_delta = cfg.get("short_put_target_delta")
    dte_min   = cfg["spread_dte_min"]
    dte_max   = cfg["spread_dte_max"]
    max_risk_pct = cfg["max_risk_pct_equity"]
    bypass_syms = set(cfg.get("wheelability_bypass_symbols") or [])

    # (6) iterate best→worst, but always include bypass symbols even if
    # their score is below the wheelability floor. ETFs (QQQ/SPY/IWM)
    # always score low on `bid/strike` and would otherwise be dropped at
    # the floor; bypass evaluates them on the strength of the other
    # gates (credit/width, risk cap, trend, BP, earnings) instead.
    sorted_syms = sorted(norm, key=lambda s: norm[s], reverse=True)
    # Bypass symbols (QQQ/SPY/IWM) go FIRST, then score-sorted single stocks.
    # The bypass design originally only let ETFs through the percentile floor;
    # it didn't promote them in iteration order, so single stocks at the top
    # of the score sort always consumed both max_opens_per_cycle slots and
    # ETFs in the tail never got tried (observed every cycle 2026-05-22).
    # Putting bypass first guarantees QQQ/SPY/IWM at least get an attempt
    # every cycle; the remaining single-stock candidates fill any slots the
    # bypass symbols didn't claim (e.g. when none clears the c/w + risk gates).
    bypass_first = [s for s in sorted_syms if s in bypass_syms]
    # R12 (2026-06-16): percentile ranks are only meaningful on a pool big
    # enough to rank. On a degenerate 1-2 name eligible pool, normalize_scores
    # hands the single best candidate a 100 regardless of its absolute quality,
    # so `norm[s] >= threshold` rubber-stamps it. Require a minimum eligible
    # pool before trusting the percentile floor for SINGLE STOCKS; below it,
    # hold single-stock opens this cycle (the absolute credit/width + trend +
    # risk gates still protect, and the curated bypass ETFs are unaffected —
    # they don't rely on the percentile). None = off (non-SM modes unchanged).
    min_pool = cfg.get("wheelability_min_pool")
    pool_ok = (min_pool is None) or (len(raw) >= int(min_pool))
    if not pool_ok:
        log(f"[auto-spread] eligible pool {len(raw)} < wheelability_min_pool "
            f"{min_pool} — percentile rank not meaningful; holding single-stock "
            f"opens this cycle (bypass ETFs still eligible)")
    others       = [s for s in sorted_syms
                    if s not in bypass_syms and norm[s] >= threshold and pool_ok]
    eligible_syms = bypass_first + others
    if not eligible_syms:
        log(f"[auto-spread] best remaining wheelability < {threshold} "
            f"and no bypass candidates — no trade")
    max_opens = int(cfg.get("max_opens_per_cycle", 1))
    opens_this_cycle = 0
    for sym in eligible_syms:
        # Inline concurrency check: open_spreads was counted at the top of
        # this cycle, but with max_opens_per_cycle > 1 we may now be at the
        # cap mid-loop. Stop before exceeding it (observed 2026-05-22: with
        # 3 open + 2 new opens, total went to 5 against a cap of 4).
        if open_spreads + opens_this_cycle >= cap:
            log(f"[auto-spread] concurrency cap reached mid-cycle "
                f"({open_spreads + opens_this_cycle}/{cap}) — stopping")
            break

        if earnings.next_earnings_within(sym, cfg["earnings_exclusion_days"]):
            log(f"[auto-spread] {sym} earnings within "
                f"{cfg['earnings_exclusion_days']}d (or unknown) — skipping")
            continue

        # Trend gate (hardened SM engine). Only sell put credit spreads
        # when the underlying is at or above its 20-day SMA — no falling
        # knives. Fail-closed: missing history skips the symbol.
        if cfg.get("trend_filter"):
            price = scored_full[sym]["price"]
            if not screener_core.is_above_sma20(
                sym, price, get_recent_daily_closes
            ):
                log(f"[auto-spread] {sym} below 20-day SMA "
                    f"(price ${price:.2f}) — trend gate skip")
                log_event(LOG_STREAM, "wheel_strategy.py",
                          "auto_spread_trend_gate_skip", result="skipped",
                          symbol=sym, details={"price": price})
                continue

        if not bp_wants_spread(options_bp, cfg["bp_switch_threshold"]):
            # BP is above the switch — a CSP would be opened instead, but
            # SM modes keep wheel_skip_new_puts ON, so just skip (SM is
            # always far below this threshold in practice).
            log(f"[auto-spread] {sym} options_bp ${options_bp:.0f} >= "
                f"switch ${cfg['bp_switch_threshold']} — not a spread candidate")
            continue

        price = scored_full[sym]["price"]
        if target_delta is not None:
            # Delta-based selection — self-calibrates across IV regimes so
            # ETFs (QQQ/SPY/IWM) and high-IV single stocks both land on a
            # short with comparable risk/reward characteristics.
            short_contract = find_contract_by_delta(
                sym, "put", target_delta, dte_min, dte_max
            )
            if not short_contract:
                log(f"[auto-spread] {sym} no short put at Δ {target_delta:.2f} "
                    f"(chain snapshot missing or no greeks) — skipping")
                continue
        else:
            short_target = round_strike(price * (1 - otm_pct), price)
            short_contract = find_best_contract(sym, "put", short_target,
                                                 dte_min, dte_max)
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

        # Search widening long strikes; collect all that clear the risk cap
        # and BP-fit, then pick the highest credit-to-width ratio (Task 10).
        candidates = []
        _credit_floor_hit = False   # sentinel: absolute-floor break fired
        min_net_credit = cfg.get("min_net_credit", 0.05)
        max_steps = 10  # bounded — don't scan an unbounded chain
        for step in range(1, max_steps + 1):
            long_target = short_strike - inc * step
            if long_target <= 0:
                break
            # Force the long leg to the SHORT's expiration — without this
            # the picker's strike-vs-target_exp scoring can land on a
            # different expiration than the short (e.g. short 06/18, long
            # 06/12 = a diagonal instead of a vertical, observed in the
            # 2026-05-22 AAL open).
            long_contract = find_best_contract(sym, "put", long_target,
                                                dte_min, dte_max,
                                                exp_date=expiration)
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
            # require_bid=False (R15): a far-OTM long hedge legitimately shows a
            # $0 bid; we BUY it, so a positive ask is enough. Skipping these
            # made sm500 cheap-underlying spreads find no eligible width.
            long_q = get_option_quote(long_contract["symbol"], require_bid=False)
            if not long_q:
                continue
            long_mid = (long_q["bid"] + long_q["ask"]) / 2.0
            cand_net_credit = round(short_mid - long_mid, 4)
            # Absolute minimum net-credit floor (degenerate-guard). A thin or
            # crossed market can yield zero or NEGATIVE credit — zero pins
            # profit_pct to 0.0 forever (50%-close never fires); negative is a
            # disguised debit spread whose max_loss blows past the risk cap.
            # This guard fires off the SHORT leg's quote, which is the SAME for
            # every width iteration on this symbol — credit only INCREASES with
            # width (wider = cheaper long, larger net), so a degenerate result
            # at the narrowest width means the short_mid itself is below the
            # floor. Wider strikes can't rescue a sub-floor short_mid. Break,
            # emit the event, skip to next symbol.
            if cand_net_credit < min_net_credit:
                log(f"[auto-spread] {sym} net_credit ${cand_net_credit:.4f} "
                    f"< min ${min_net_credit:.4f} (thin chain — would be a "
                    f"non-credit/near-zero spread) — skipping")
                log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_skip",
                          result="skipped", symbol=sym,
                          notes="below_min_net_credit",
                          details={"net_credit": cand_net_credit,
                                   "min_net_credit": min_net_credit,
                                   "short_mid": round(short_mid, 4),
                                   "long_mid": round(long_mid, 4)})
                _credit_floor_hit = True
                break
            # Credit-to-width gate (hardened SM engine). Reject thin spreads
            # whose payoff/risk ratio is too asymmetric to ever beat losses.
            # Absolute floor is the degenerate guard (above); this gate is the
            # real quality filter — try the next wider width on a soft miss.
            min_ratio = cfg.get("min_credit_to_width_pct")
            if min_ratio is not None and not credit_ratio_passes(
                cand_net_credit, width, min_ratio
            ):
                continue
            if not spread_passes_risk(width, cand_net_credit, equity,
                                      max_risk_pct):
                continue
            # Collect, don't break — Task 10 picks best ratio after the loop.
            candidates.append({
                "long_occ":    long_contract["symbol"],
                "long_strike": long_strike,
                "long_mid":    long_mid,
                "long_bid":    long_q["bid"],
                "long_ask":    long_q["ask"],
                "width":       width,
                "net_credit":  cand_net_credit,
            })

        # Degenerate-quote skip MUST run before picker — otherwise we'd
        # spend cycles computing a best-ratio winner only to discard it.
        if _credit_floor_hit:
            # logging already emitted inside the loop; just skip to next symbol
            continue

        chosen = pick_best_ratio_width(candidates)

        if not chosen:
            log(f"[auto-spread] {sym} no long leg fits risk budget "
                f"(equity ${equity:.2f} @ {max_risk_pct:.0%}) — trying next")
            continue

        # (7) fully eligible — place the order
        net_credit = chosen["net_credit"]
        width      = chosen["width"]

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

        # Liquidity gate (2026-05-30 spread-loss fix). All the credit gates
        # above run on the MID, so a spread whose bid/ask is so wide that it can
        # only transact for a fraction of fair value slips through — MU
        # 2026-05-29 had a $3.65 mid but a $1.50 executable cross (41% of mid),
        # opened, and stopped out for -$175 in 20 minutes. Require the
        # executable credit to be at least SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID of
        # the mid; otherwise the chain is too wide to open AND later close
        # reliably, so skip. Same fraction the opening-limit floor uses.
        min_pct = SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID
        if min_pct > 0 and exec_credit < min_pct * net_credit:
            log(f"[auto-spread] {sym} executable credit ${exec_credit:.4f} is "
                f"{exec_credit / net_credit:.0%} of the ${net_credit:.4f} mid "
                f"(< {min_pct:.0%}) — bid/ask too wide to transact, skipping")
            log_event(LOG_STREAM, "wheel_strategy.py", "auto_spread_skip",
                      result="skipped", symbol=sym,
                      notes="exec_below_pct_of_mid",
                      details={"exec_credit": exec_credit,
                               "mid_net_credit": net_credit,
                               "exec_pct_of_mid": round(exec_credit / net_credit, 4)
                                                  if net_credit else None,
                               "min_pct_of_mid": min_pct})
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
        # Opening limit (2026-05-30 spread-loss fix). The full marketable cross
        # (short_bid - long_ask) gave away the entire bid/ask width on entry.
        # Rest between the mid (net_credit) and that cross per the mode's
        # concession posture; never demand more than the mid, floor at one cent.
        marketable_credit = round(short_q["bid"] - chosen["long_ask"], 2)
        limit_credit = compute_open_limit_credit(
            mid_credit=net_credit,
            marketable_credit=marketable_credit,
            concession_pct=SPREAD_OPEN_CONCESSION_PCT,
            min_pct_of_mid=SPREAD_OPEN_MIN_CREDIT_PCT_OF_MID,
        )
        try:
            order = _open_spread_mleg(short_occ, chosen["long_occ"],
                                      1, net_credit,
                                      limit_credit=limit_credit)
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
            # Try the next eligible symbol instead of burning the cycle
            # on a single failure. Alpaca returns 403 occasionally for
            # mleg orders on certain symbols (NVDA/MU observed 2026-05-22);
            # we'd rather fall through to a working candidate than no-op.
            continue

        order_id = order.get("id", "?") if isinstance(order, dict) else "?"
        client_oid = order.get("client_order_id") if isinstance(order, dict) else None

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
        ss["open_client_order_id"] = client_oid  # R13: resolve fallback
        ss["open_limit_credit"] = limit_credit
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
        opens_this_cycle += 1
        # R14 (2026-06-16): the spread just opened reserves its full defined-risk
        # collateral (width × 100). When max_opens_per_cycle > 1, decrement the
        # local BP estimate so the NEXT open's bp_fits check sees the consumed
        # buying power instead of the stale start-of-cycle value (which could
        # wave through an over-leveraged second open that Alpaca then 403s).
        options_bp = max(0.0, options_bp - width * 100.0)
        if opens_this_cycle >= max_opens:
            return
        # Otherwise keep iterating — manual mode runs with
        # max_opens_per_cycle=2 so a single-stock spread + a bypass
        # ETF spread can both fill on the same cycle.
        continue

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

        # R23 (2026-06-16): check market-open BEFORE auto-discovery so we don't
        # make position/quote API calls or fire adoption embeds off-hours. The
        # auto-open cold-start path below already requires is_market_open(), so
        # nothing that should run while the market is open is skipped here.
        if not is_market_open():
            log(f"Market closed — skipping wheel cycle (no discovery this cycle).")
            log_event(LOG_STREAM, "wheel_strategy.py", "cycle_skipped_market_closed",
                      result="skipped", details={"mode": MODE})
            return

        # Manual mode: build SYMBOLS from live Alpaca positions instead of
        # the static list. Adopts any user-opened option/share positions
        # the wheel hasn't seen yet so handle_stage1/handle_stage2 work
        # without modification.
        if AUTO_DISCOVER_SYMBOLS:
            discovered = _discover_wheel_state(state)
            # Drop any symbol the user has handed back to manual control. The
            # position still shows in Alpaca, but the bot must not manage it —
            # no covered-call sale on assignment, no put management. Lets the
            # user close the position by hand without the bot re-covering it.
            if EXCLUDED_SYMBOLS:
                skipped = sorted(discovered & EXCLUDED_SYMBOLS)
                if skipped:
                    log(f"Excluding {', '.join(skipped)} from wheel management "
                        f"(config.excluded_symbols) — bot will not sell calls or "
                        f"manage options on these.")
                discovered = discovered - EXCLUDED_SYMBOLS
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
        # Lazy, once-per-cycle positions cache for the naked-leg guard. Only
        # fetched the first time a Stage-1 put needs the hedge check, so
        # cons/agg cycles (no spread legs) pay nothing.
        _positions_cache = {}
        def _wheel_positions():
            if "v" not in _positions_cache:
                try:
                    _positions_cache["v"] = get_positions()
                except Exception:
                    _positions_cache["v"] = []
            return _positions_cache["v"]

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
                    # Naked-leg guard: if this short put still has an un-paired
                    # long hedge in the account, hold rather than 50%-close it
                    # naked (which would orphan the hedge — the AAL bleed).
                    if _short_put_has_live_hedge(symbol, sym_state, _wheel_positions()):
                        log(f"[{symbol}] naked-leg guard — short put has an "
                            f"un-paired long hedge; holding (not managing as a "
                            f"single leg)")
                        log_event(LOG_STREAM, "wheel_strategy.py",
                                  "naked_leg_guard_hold", result="skipped",
                                  symbol=symbol,
                                  details={"contract": sym_state.get("current_contract")})
                    else:
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
                detail = alpaca_err_detail(e)
                log(f"[{symbol}] error in wheel cycle: {detail}")

                # PDT denial: quiet to actions and KEEP GOING. Must precede the
                # blanket-403 BP-exhaustion check below — a PDT 403 is not BP
                # exhaustion, and `break`ing on it would wrongly skip every
                # remaining symbol's management every cycle on a PDT-locked
                # account (2026-06-03).
                if report_pdt_quietly(symbol, detail, "Wheel action"):
                    continue

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
                    description=f"`{detail[:500]}`",
                    footer=f"wheel_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "wheel_strategy.py", "symbol_exception",
                          result="failure",
                          notes=f"{symbol}: {detail[:500]}")

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
