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

import os
import time
from datetime import date, datetime, timedelta

import requests
from dotenv import load_dotenv

from notifications import send_embed, log_event, Color

# Reuse wheel's API helpers — same Alpaca account, same patterns
from wheel_strategy import (
    api_get,
    api_post,
    get_account,
    get_option_last_price,
    get_option_quote,
    is_market_open,
    HEADERS,
    BASE_URL,
)

load_dotenv()


# ── Strategy parameters ───────────────────────────────────────────────────
TAKE_PROFIT_PCT          = 1.00   # +100% (option worth ≥ 2× entry)
STOP_LOSS_PCT            = 0.50   # −50%  (option worth ≤ 0.5× entry)
DAYS_TO_EXPIRY_CLOSE     = 3      # close this many days before expiry if not profitable


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
    log(f"Sell-to-close placed: {option_symbol} qty={qty} @ ${limit_price:.2f}")
    return api_post("/orders", body)


def compute_close_price(option_symbol: str) -> float | None:
    """Pick a sell limit price for closing a long option.

    Preferred: bid-ask midpoint (current fair value).
    Fallback:  last trade price.
    Returns None if neither is available — caller must skip the close.
    """
    quote = get_option_quote(option_symbol)
    if quote:
        return round((quote["bid"] + quote["ask"]) / 2, 2)
    last = get_option_last_price(option_symbol)
    if last is not None:
        return round(last, 2)
    return None


# ── Core decision logic ───────────────────────────────────────────────────

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

    current = get_option_last_price(symbol)
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

    close_price = compute_close_price(symbol)
    if close_price is None or close_price <= 0:
        log(f"[{symbol}] cannot price for close — skipping")
        log_event("errors", "long_options_strategy.py", "close_no_price",
                  symbol=symbol, result="failure",
                  notes=f"action={action} pnl={info.get('pnl_pct'):.2%}")
        return False

    try:
        order = place_sell_to_close(symbol, close_price, qty)
    except Exception as e:
        log(f"[{symbol}] sell-to-close failed: {e}")
        send_embed(
            "errors", f"long_options: sell-to-close failed for {symbol}",
            color=Color.RED,
            description=f"Action: {action}\n`{type(e).__name__}: {str(e)[:300]}`",
            footer="long_options_strategy.py",
        )
        log_event("errors", "long_options_strategy.py", "close_failed",
                  symbol=symbol, result="failure",
                  notes=f"{type(e).__name__}: {str(e)[:300]}")
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
        "tsla", f"Long Options: {label} on {underlying} {info['type']} {info['strike']}",
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
        footer="long_options_strategy.py",
    )
    log_event("tsla", "long_options_strategy.py", f"closed_{action}",
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
            log_event("tsla", "long_options_strategy.py", "cycle_skipped_market_closed",
                      result="skipped")
            return

        positions = list_long_option_positions()
        log(f"Long-options cycle: {len(positions)} long option position(s) open")

        if not positions:
            log_event("tsla", "long_options_strategy.py", "cycle_complete",
                      result="success", details={"checked": 0, "closed": 0})
            return

        today = date.today()
        closed = 0
        held = 0
        skipped = 0

        for pos in positions:
            symbol = pos.get("symbol", "?")
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
                log(f"[{symbol}] error: {type(e).__name__}: {e}")
                send_embed(
                    "errors", f"long_options_strategy.py — error on {symbol}",
                    color=Color.RED,
                    description=f"`{type(e).__name__}: {str(e)[:400]}`",
                    footer="long_options_strategy.py",
                )
                log_event("errors", "long_options_strategy.py", "position_exception",
                          symbol=symbol, result="failure",
                          notes=f"{type(e).__name__}: {str(e)[:400]}")
                skipped += 1

        log_event("tsla", "long_options_strategy.py", "cycle_complete",
                  result="success",
                  details={"checked": len(positions), "closed": closed,
                           "held": held, "skipped": skipped})
    except Exception as e:
        send_embed(
            "errors", "long_options_strategy.py — cycle crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer="long_options_strategy.py",
        )
        log_event("errors", "long_options_strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "once"
    if mode == "once":
        run_long_options_cycle()
    else:
        # Loop mode for legacy local-run; not used by GitHub Actions
        while True:
            run_long_options_cycle()
            time.sleep(60)
