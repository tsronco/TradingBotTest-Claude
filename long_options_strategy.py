#!/usr/bin/env python3
"""
Long Options Manager — generic, multi-symbol, side-agnostic.

Discovers every LONG option position in the Alpaca account (calls + puts)
and applies a uniform set of management rules. Does NOT touch SHORT
options (those are managed by the wheel — wheel positions have qty < 0
which this filters out automatically).

Rules per long position:
  TAKE PROFIT:  close at +100% (option worth ≥ 2× entry premium)
  STOP LOSS:    close at −50%  (option worth ≤ 0.5× entry premium)
  TIME EXIT:    close within DAYS_TO_EXPIRY_CLOSE days of expiration
                if not already in profit (avoids the expiration-day cliff)
  HOLD:         everything else — just log and watch

State: NONE. Alpaca is the source of truth for open positions. We log
closed-position events to logs/tsla.jsonl + post Discord cards on close.

Designed to run on the same 30-min cadence as the wheel, after wheel.py.
"""

import json
import os
import time
from datetime import date, datetime, timedelta

import requests
from dotenv import load_dotenv

import config
import wheel_strategy
from notifications import send_embed, log_event, Color

# Reuse wheel's API helpers (these read wheel_strategy's module globals at
# call time, so they automatically pick up whichever mode wheel_strategy
# is in at the moment of the call).
from wheel_strategy import (
    api_get,
    api_post,
    get_account,
    get_option_last_price,
    get_option_quote,
    is_market_open,
)

load_dotenv()


# ── Strategy parameters ───────────────────────────────────────────────────
TAKE_PROFIT_PCT          = 1.00   # +100% (option worth ≥ 2× entry)
STOP_LOSS_PCT            = 0.50   # −50%  (option worth ≤ 0.5× entry)
DAYS_TO_EXPIRY_CLOSE     = 3      # close this many days before expiry if not profitable


# ── Mode-aware globals (assigned by apply_mode) ──────────────────────────

TRADES_CH  = None
ERRORS_CH  = None
ACTIONS_CH = None
LOG_STREAM = None
MODE       = None


def apply_mode(mode_name: str) -> None:
    """Switch this module + the underlying wheel_strategy module to the named mode.

    long_options_strategy.py reuses wheel_strategy's Alpaca API helpers
    (api_get, api_post, etc.). Those helpers reference wheel_strategy's
    HEADERS/BASE_URL module globals at call time. So we MUST switch
    wheel_strategy to the same mode first; otherwise we'd hit the wrong
    Alpaca account.
    """
    global TRADES_CH, ERRORS_CH, ACTIONS_CH, LOG_STREAM, MODE
    cfg = config.get_mode(mode_name)
    MODE = mode_name
    TRADES_CH  = cfg["trades_channel"]
    ERRORS_CH  = cfg["errors_channel"]
    ACTIONS_CH = cfg["actions_channel"]
    LOG_STREAM = cfg["log_stream"]

    # Ensure the borrowed wheel_strategy.api_* functions hit the right account.
    wheel_strategy.apply_mode(mode_name)


apply_mode(config.DEFAULT_MODE)


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ── OCC option symbol parsing ─────────────────────────────────────────────

def parse_occ_symbol(symbol: str) -> dict | None:
    """Parse an OCC option symbol like 'RIVN260522C00015500' into parts.

    Returns None if the symbol doesn't match the expected pattern.
    OCC format: TICKER + YYMMDD + (C|P) + STRIKE_PRICE_×1000_PADDED_TO_8_DIGITS
    """
    # Ticker is the leading non-digit characters
    for i, c in enumerate(symbol):
        if c.isdigit():
            ticker = symbol[:i]
            rest = symbol[i:]
            break
    else:
        return None

    if len(rest) != 15:  # YYMMDD(6) + side(1) + strike(8) = 15
        return None

    try:
        yy = int(rest[0:2])
        mm = int(rest[2:4])
        dd = int(rest[4:6])
        side = rest[6]
        strike_raw = int(rest[7:15])
    except ValueError:
        return None

    if side not in ("C", "P"):
        return None

    return {
        "ticker": ticker,
        "expiry": date(2000 + yy, mm, dd),
        "type": "call" if side == "C" else "put",
        "strike": strike_raw / 1000.0,
    }


# ── Wheel-spread coordination ─────────────────────────────────────────────

def _wheel_claimed_long_occs() -> set:
    """OCC symbols of long option legs that wheel_strategy has claimed as
    part of a spread. long_options_strategy MUST NOT touch these — selling
    the hedge would leave the short leg naked and break the spread's risk
    profile.

    Reads wheel_strategy's state file directly (no import-time side effects)
    so a stale dashboard or a partial cycle doesn't desync the two scripts.
    Returns an empty set if the state file doesn't exist yet.
    """
    state_file = getattr(wheel_strategy, "STATE_FILE", None)
    if not state_file or not os.path.exists(state_file):
        return set()
    try:
        with open(state_file) as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError):
        return set()
    claimed = set()
    for sym, ss in state.items():
        if sym.startswith("_") or not isinstance(ss, dict):
            continue
        if ss.get("stage") != "spread_active":
            continue
        long_occ = (ss.get("long_leg") or {}).get("occ")
        short_occ = (ss.get("short_leg") or {}).get("occ")
        if long_occ:
            claimed.add(long_occ)
        if short_occ:
            claimed.add(short_occ)
    return claimed


def _unpaired_hedge_long_occs(all_positions: list) -> set:
    """OCC symbols of long option legs that hedge a short leg still held.

    Two cases — both the long leg of a vertical CREDIT spread that must NOT be
    sold here (selling it leaves the short leg naked):
      - put credit spread:  a long PUT with a short PUT at a HIGHER strike,
        same expiration.
      - call credit spread: a long CALL with a short CALL at a LOWER strike,
        same expiration.
    Detect both straight from live positions even when wheel_strategy hasn't
    paired them into spread_active state (split-fill qty mismatch, not-yet-
    adopted, or stale state). Mirrors wheel_strategy's naked-leg guard on the
    short side (2026-05-30). The call case (R32, 2026-06-16) closes the
    naked-short-CALL hole — selling the long call of a user-opened call credit
    spread would leave an unlimited-upside-risk naked short call.
    """
    shorts: dict = {}   # (ticker, expiry, type) -> [short strikes]
    longs: list = []    # (occ, key, type, strike)
    for pos in all_positions:
        if pos.get("asset_class") != "us_option":
            continue
        parsed = parse_occ_symbol(pos.get("symbol", ""))
        if parsed is None or parsed["type"] not in ("put", "call"):
            continue
        try:
            qty = int(float(pos["qty"]))
        except (KeyError, ValueError, TypeError):
            continue
        key = (parsed["ticker"], parsed["expiry"].isoformat(), parsed["type"])
        if qty < 0:
            shorts.setdefault(key, []).append(parsed["strike"])
        elif qty > 0:
            longs.append((pos["symbol"], key, parsed["type"], parsed["strike"]))
    hedges = set()
    for occ, key, otype, strike in longs:
        short_strikes = shorts.get(key, [])
        # put credit spread: short put sits ABOVE the long put hedge.
        # call credit spread: short call sits BELOW the long call hedge.
        if otype == "put" and any(s > strike for s in short_strikes):
            hedges.add(occ)
        elif otype == "call" and any(s < strike for s in short_strikes):
            hedges.add(occ)
    return hedges


# ── Alpaca helpers specific to long-options ───────────────────────────────

def list_all_positions() -> list[dict]:
    """Fetch every open position in the account."""
    return api_get("/positions")


def list_long_option_positions() -> list[dict]:
    """Filter for LONG option positions (qty > 0, us_option asset class).

    Wheel-managed shorts naturally have qty < 0 and get excluded here.
    """
    out = []
    for pos in list_all_positions():
        if pos.get("asset_class") != "us_option":
            continue
        try:
            qty = float(pos.get("qty", 0))
        except (TypeError, ValueError):
            continue
        if qty > 0:
            out.append(pos)
    return out


def has_open_sell_order(option_symbol: str) -> bool:
    """True if there's already an open sell-side order for this contract.

    Prevents duplicate sell-to-close placements on cycles where a prior
    close order is still resting (Alpaca returns 403 on the second sell
    if it would over-commit the position qty).
    """
    try:
        orders = api_get("/orders", params={"status": "open", "symbols": option_symbol})
    except Exception:
        return False
    for o in orders or []:
        if o.get("symbol") == option_symbol and o.get("side") == "sell":
            return True
    return False


def _report_pdt_quietly(symbol: str, detail: str, context: str) -> bool:
    """Route a PDT-denied long-option exit to the actions firehose.

    Reuses wheel_strategy.is_pdt_denied (a pure check) but posts to this
    script's own channels. A PDT block (sub-$25k margin account over the
    day-trade limit) is an account-state condition, not a fixable per-cycle
    error — quieting it keeps #errors meaningful. Returns True when handled
    (caller skips its #errors embed), False otherwise (2026-06-03).
    """
    if not wheel_strategy.is_pdt_denied(detail):
        return False
    send_embed(
        ACTIONS_CH, f"⏸️ {context} blocked by PDT — {symbol}",
        color=Color.YELLOW,
        description=(
            f"{context} for {symbol} was denied by Alpaca Pattern Day Trading "
            f"protection (account < $25k, day-trade limit hit). Position is "
            f"intact; can't act until the PDT restriction clears."
        ),
        footer=f"long_options_strategy.py · {MODE}",
        also_to_actions=False,
    )
    log_event(LOG_STREAM, "long_options_strategy.py", "pdt_blocked",
              result="skipped", symbol=symbol, notes=(detail or "")[:400])
    return True


def place_sell_to_close(option_symbol: str, limit_price: float, qty: int):
    """Submit a sell-to-close limit order to exit a long option position."""
    body = {
        "symbol":          option_symbol,
        "qty":             str(qty),
        "side":            "sell",
        "type":            "limit",
        "limit_price":     str(round(limit_price, 2)),
        "time_in_force":   "day",
        "position_intent": "sell_to_close",
    }
    order = api_post("/orders", body)
    log(f"Sell-to-close placed: {option_symbol} qty={qty} @ ${limit_price:.2f}")
    return order


def compute_close_price(option_symbol: str, urgent: bool = False) -> float | None:
    """Pick a sell limit price for closing a long option.

    `urgent=True` (stop-loss / time-exit) prices at the BID so the order
    actually fills — a mid-priced limit on the illiquid, dying options these
    exits usually hit just rests unfilled and re-fires a stop-loss alert every
    morning while the position rots to zero (AAL 06/12 $12.50 put, 5/26–5/29).
    When we've decided to get out, take the bid.

    `urgent=False` (take-profit) keeps the bid-ask midpoint — there's no rush
    to bank a winner, so don't give away the spread.

    Fallback for both: last trade price. Returns None if nothing is priceable.
    """
    quote = get_option_quote(option_symbol)
    if quote:
        if urgent:
            # Hit the bid (floored at a cent) to transact now.
            return round(max(quote["bid"], 0.01), 2)
        return round((quote["bid"] + quote["ask"]) / 2, 2)
    last = get_option_last_price(option_symbol)
    if last is not None:
        return round(last, 2)
    return None


# ── Core decision logic ───────────────────────────────────────────────────

def _current_mark(symbol: str):
    """Current mark for a long option, used for exit decisions (R3, 2026-06-16).

    Prefer the live quote MID over the last TRADE price: on an illiquid contract
    the last trade can be hours or days stale, so a long that has actually
    collapsed still shows a small loss (stop never fires) and a long that has
    run shows a phantom +100% (premature take-profit). Fall back to the last
    trade only when no two-sided quote is available.
    """
    q = get_option_quote(symbol)
    if q:
        bid, ask = q.get("bid"), q.get("ask")
        if bid is not None and ask is not None:
            mid = (float(bid) + float(ask)) / 2.0
            if mid > 0:
                return round(mid, 2)
    return get_option_last_price(symbol)


def evaluate_position(pos: dict, today: date) -> tuple[str, float, dict]:
    """Decide what to do with a long option position.

    Returns (action, pnl_pct, info) where action is one of:
      "hold"          — keep watching
      "take_profit"   — option ≥ 2× entry, close to bank gain
      "stop_loss"     — option ≤ 0.5× entry, close to preserve remainder
      "time_exit"     — within N days of expiry and not profitable, close to avoid theta cliff
      "skip_no_entry" — couldn't determine entry price
      "skip_no_price" — couldn't fetch current price
      "skip_unparseable" — symbol doesn't match OCC format
    """
    symbol = pos["symbol"]
    parsed = parse_occ_symbol(symbol)
    if parsed is None:
        return "skip_unparseable", 0.0, {"symbol": symbol}

    try:
        entry = float(pos["avg_entry_price"])
    except (KeyError, TypeError, ValueError):
        return "skip_no_entry", 0.0, {"symbol": symbol}

    if entry <= 0:
        return "skip_no_entry", 0.0, {"symbol": symbol}

    current = _current_mark(symbol)
    if current is None or current <= 0:
        return "skip_no_price", 0.0, {"symbol": symbol, "entry": entry}

    pnl_pct = (current - entry) / entry  # for a LONG: positive = good

    info = {
        "symbol": symbol,
        "ticker": parsed["ticker"],
        "type": parsed["type"],
        "strike": parsed["strike"],
        "expiry": parsed["expiry"].isoformat(),
        "entry": entry,
        "current": current,
        "pnl_pct": pnl_pct,
    }

    # Check the rules in priority order (profit / loss before time)
    if pnl_pct >= TAKE_PROFIT_PCT:
        return "take_profit", pnl_pct, info
    if pnl_pct <= -STOP_LOSS_PCT:
        return "stop_loss", pnl_pct, info

    days_left = (parsed["expiry"] - today).days
    info["days_to_expiry"] = days_left
    if days_left <= DAYS_TO_EXPIRY_CLOSE and pnl_pct < 0:
        return "time_exit", pnl_pct, info

    return "hold", pnl_pct, info


def execute_close(pos: dict, action: str, info: dict) -> bool:
    """Place a sell-to-close for a long option position. Logs + pings Discord."""
    symbol = pos["symbol"]
    qty = int(float(pos["qty"]))

    if has_open_sell_order(symbol):
        log(f"[{symbol}] close already pending — skipping")
        log_event(LOG_STREAM, "long_options_strategy.py", "close_already_pending",
                  symbol=symbol, result="skipped",
                  notes=f"action={action} pnl={info.get('pnl_pct', 0):.2%}")
        return False

    # Stop-loss and time-exit are decisions to GET OUT — price marketable so
    # the order fills instead of resting at the mid (the AAL daily-churn bug).
    urgent = action in ("stop_loss", "time_exit")
    close_price = compute_close_price(symbol, urgent=urgent)
    if close_price is None or close_price <= 0:
        log(f"[{symbol}] cannot price for close — skipping")
        log_event(LOG_STREAM, "long_options_strategy.py", "close_no_price",
                  symbol=symbol, result="failure",
                  notes=f"action={action} pnl={info.get('pnl_pct'):.2%}")
        return False

    try:
        order = place_sell_to_close(symbol, close_price, qty)
    except Exception as e:
        detail = wheel_strategy.alpaca_err_detail(e)
        log(f"[{symbol}] sell-to-close failed: {detail}")
        if _report_pdt_quietly(symbol, detail, f"Long-option close ({action})"):
            return False
        send_embed(
            ERRORS_CH, f"long_options: sell-to-close failed for {symbol}",
            color=Color.RED,
            description=f"Action: {action}\n`{detail[:300]}`",
            footer=f"long_options_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
            )
        log_event(LOG_STREAM, "long_options_strategy.py", "close_failed",
                  symbol=symbol, result="failure",
                  notes=detail[:300])
        return False

    label_map = {
        "take_profit": ("TAKE PROFIT", Color.GREEN),
        "stop_loss":   ("STOP LOSS",   Color.RED),
        "time_exit":   ("TIME EXIT",   Color.YELLOW),
    }
    label, color = label_map.get(action, ("CLOSED", Color.BLUE))
    underlying = info.get("ticker", "?")
    pnl_pct = info.get("pnl_pct", 0.0)
    pnl_dollars = (info["current"] - info["entry"]) * 100 * qty

    send_embed(
        TRADES_CH, f"Long Options: {label} on {underlying} {info['type']} {info['strike']}",
        color=color,
        description=(
            f"Contract: {symbol}\n"
            f"Entry: ${info['entry']:.2f} → close: ${close_price:.2f}\n"
            f"P&L: {pnl_pct:+.1%} (${pnl_dollars:+.2f})"
        ),
        fields=[
            {"name": "Underlying", "value": underlying, "inline": True},
            {"name": "Type", "value": info["type"], "inline": True},
            {"name": "Strike", "value": f"${info['strike']}", "inline": True},
            {"name": "Action", "value": label, "inline": True},
            {"name": "Qty", "value": str(qty), "inline": True},
            {"name": "Days to expiry", "value": str(info.get("days_to_expiry", "—")), "inline": True},
        ],
        footer=f"long_options_strategy.py · {MODE}",
        actions_channel=ACTIONS_CH,
        )
    log_event(LOG_STREAM, "long_options_strategy.py", f"closed_{action}",
              symbol=symbol, result="success",
              details={
                  "underlying": underlying,
                  "type": info["type"],
                  "strike": info["strike"],
                  "entry": info["entry"],
                  "close_price": close_price,
                  "pnl_pct": pnl_pct,
                  "pnl_dollars": pnl_dollars,
                  "qty": qty,
              },
              alpaca_order_id=order.get("id"))
    return True


# ── Top-level orchestration ───────────────────────────────────────────────

def run_long_options_cycle():
    """One cycle: scan long option positions, apply rules, close as needed."""
    try:
        if not is_market_open():
            log("Market closed — skipping long-options cycle.")
            log_event(LOG_STREAM, "long_options_strategy.py", "cycle_skipped_market_closed",
                      result="skipped")
            return

        positions = list_long_option_positions()
        log(f"Long-options cycle: {len(positions)} long option position(s) open")

        if not positions:
            log_event(LOG_STREAM, "long_options_strategy.py", "cycle_complete",
                      result="success", details={"checked": 0, "closed": 0})
            return

        today = date.today()
        closed = 0
        held = 0
        skipped = 0

        # Hedge legs of wheel-managed credit spreads must never be touched
        # here — selling the long put would leave the short leg naked. Two
        # sources: (1) spreads the wheel has paired into spread_active state,
        # and (2) un-paired hedges detected straight from live positions (a
        # long put with a short put above it at the same expiry) — the latter
        # closes the gap that orphaned the AAL 06/12 long and churned a stuck
        # stop-loss for days.
        claimed_by_wheel = _wheel_claimed_long_occs()
        try:
            claimed_by_wheel |= _unpaired_hedge_long_occs(list_all_positions())
        except Exception as e:
            log(f"hedge-detection skipped: {type(e).__name__}: {e}")

        for pos in positions:
            symbol = pos.get("symbol", "?")
            if symbol in claimed_by_wheel:
                skipped += 1
                log(f"[{symbol}] skip_wheel_spread_leg — managed by wheel_strategy")
                log_event(LOG_STREAM, "long_options_strategy.py", "skip_wheel_spread_leg",
                          symbol=symbol,
                          details={"reason": "managed_by_wheel_spread"})
                continue
            try:
                action, pnl_pct, info = evaluate_position(pos, today)

                if action == "hold":
                    held += 1
                    days_left = info.get("days_to_expiry", "?")
                    log(f"[{symbol}] hold — entry ${info['entry']:.2f} now ${info['current']:.2f} ({pnl_pct:+.1%}, {days_left}d to expiry)")
                elif action.startswith("skip_"):
                    skipped += 1
                    log(f"[{symbol}] {action}")
                else:
                    log(f"[{symbol}] {action.upper()} — entry ${info['entry']:.2f} now ${info['current']:.2f} ({pnl_pct:+.1%})")
                    if execute_close(pos, action, info):
                        closed += 1
            except Exception as e:
                # Per-position error isolation
                detail = wheel_strategy.alpaca_err_detail(e)
                log(f"[{symbol}] error: {detail}")
                if _report_pdt_quietly(symbol, detail, "Long-option action"):
                    continue
                send_embed(
                    ERRORS_CH, f"long_options_strategy.py — error on {symbol}",
                    color=Color.RED,
                    description=f"`{detail[:400]}`",
                    footer=f"long_options_strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                    )
                log_event(LOG_STREAM, "long_options_strategy.py", "position_exception",
                          symbol=symbol, result="failure",
                          notes=detail[:400])
                skipped += 1

        log_event(LOG_STREAM, "long_options_strategy.py", "cycle_complete",
                  result="success",
                  details={"checked": len(positions), "closed": closed,
                           "held": held, "skipped": skipped})
    except Exception as e:
        send_embed(
            ERRORS_CH, "long_options_strategy.py — cycle crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer=f"long_options_strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
            )
        log_event(LOG_STREAM, "long_options_strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


if __name__ == "__main__":
    import sys
    selected_mode, remaining = config.parse_mode_arg(sys.argv[1:])
    apply_mode(selected_mode)
    cmd = remaining[0] if remaining else "once"
    if cmd == "once":
        run_long_options_cycle()
    else:
        # Loop mode for legacy local-run; not used by GitHub Actions
        while True:
            run_long_options_cycle()
            time.sleep(60)
