#!/usr/bin/env python3
"""
TSLA Trailing Stop + Adaptive Ladder Strategy

Rules:
  Entry:      10 shares at market
  Stop loss:  sell all if price drops 10% below current avg cost (recalculates after each ladder)
  Trailing:   activates at +10% from entry; floor = 5% below high-water mark (never goes down)
  Ladder 1:   -15% from entry  → buy  8 shares
  Ladder 2:   -25% from entry  → buy 12 shares
  Ladder 3:   -40% from entry  → buy 20 shares
  After each ladder: stop recalculates to new_avg_cost × 0.90
"""

import os
import time
import requests
from datetime import datetime
from dotenv import load_dotenv

import config
from notifications import send_embed, log_event, Color

load_dotenv()

DATA_URL = "https://data.alpaca.markets/v2"

# ── Strategy parameters (constant across modes) ───────────────────────────
SYMBOL             = "TSLA"
INITIAL_QTY        = 10
INITIAL_ENTRY_ID   = "b74249cf-9fc3-4476-8b78-3202a5d2adad"  # conservative-account seed only

STOP_PCT           = 0.10   # stop = avg_cost × (1 - STOP_PCT), recalculates after each ladder
TRAIL_TRIGGER_PCT  = 0.10   # trailing activates after +10% from entry
TRAIL_DISTANCE_PCT = 0.05   # floor sits 5% below high-water mark

LADDERS = [
    {"drop": 0.15, "qty": 8,  "label": "Ladder 1"},   # -15% → buy  8 shares
    {"drop": 0.25, "qty": 12, "label": "Ladder 2"},   # -25% → buy 12 shares
    {"drop": 0.40, "qty": 20, "label": "Ladder 3"},   # -40% → buy 20 shares
]

POLL_INTERVAL = 60  # seconds

# ── Mode-aware globals (assigned by apply_mode) ──────────────────────────

API_KEY     = None
API_SECRET  = None
BASE_URL    = None
HEADERS     = None
STATE_FILE  = None
TRADES_CH   = None
ERRORS_CH   = None
ACTIONS_CH  = None
LOG_STREAM  = None
MODE        = None


def apply_mode(mode_name: str) -> None:
    """Switch this module to the given mode (conservative|aggressive).

    Loads credentials, state file path, Discord channels, and JSONL log
    stream from config.MODES[mode_name].
    """
    global API_KEY, API_SECRET, BASE_URL, HEADERS, STATE_FILE
    global TRADES_CH, ERRORS_CH, ACTIONS_CH, LOG_STREAM, MODE

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
    STATE_FILE = os.path.join(os.path.dirname(__file__), cfg["strategy_state_file"])

    TRADES_CH  = cfg["trades_channel"]
    ERRORS_CH  = cfg["errors_channel"]
    ACTIONS_CH = cfg["actions_channel"]
    LOG_STREAM = cfg["log_stream"]


apply_mode(config.DEFAULT_MODE)


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def place_order(symbol, qty, side, order_type="market", time_in_force="day"):
    resp = requests.post(
        f"{BASE_URL}/orders",
        headers=HEADERS,
        json={"symbol": symbol, "qty": qty, "side": side,
              "type": order_type, "time_in_force": time_in_force},
    )
    resp.raise_for_status()
    return resp.json()


def get_order(order_id):
    resp = requests.get(f"{BASE_URL}/orders/{order_id}", headers=HEADERS)
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


def close_all(symbol):
    resp = requests.delete(f"{BASE_URL}/positions/{symbol}", headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


def wait_for_fill(order_id, timeout_hours=72):
    log(f"Waiting for fill on order {order_id}...")
    deadline = time.time() + timeout_hours * 3600
    while time.time() < deadline:
        order = get_order(order_id)
        status = order["status"]
        if status == "filled":
            fill_price = float(order["filled_avg_price"])
            fill_qty   = int(float(order["filled_qty"]))
            log(f"Filled: {fill_qty} shares @ ${fill_price:.2f}")
            send_embed(
                TRADES_CH, f"TSLA Entry Filled — {fill_qty} shares @ ${fill_price:.2f}",
                color=Color.GREEN,
                fields=[
                    {"name": "Order ID", "value": order_id, "inline": False},
                    {"name": "Stop", "value": f"${recalculate_stop(fill_price):.2f}", "inline": True},
                    {"name": "Trail trigger", "value": f"${fill_price * (1 + TRAIL_TRIGGER_PCT):.2f}", "inline": True},
                ],
                footer="strategy.py",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "entry_filled",
                      symbol=SYMBOL,
                      details={"qty": fill_qty, "fill_price": fill_price},
                      alpaca_order_id=order_id)
            return fill_price
        if status in ("canceled", "expired", "rejected"):
            raise RuntimeError(f"Order ended with status '{status}' — aborting.")
        log(f"Order status: {status} — checking again in 30s")
        time.sleep(30)
    raise TimeoutError("Order did not fill within the timeout window.")


def recalculate_stop(avg_cost):
    return round(avg_cost * (1 - STOP_PCT), 2)


def run_strategy(entry_order_id=INITIAL_ENTRY_ID):
    entry_price = wait_for_fill(entry_order_id)

    # ── Strategy state ─────────────────────────────────────────────────────
    avg_cost        = entry_price
    total_qty       = INITIAL_QTY
    total_cost      = entry_price * INITIAL_QTY
    stop_price      = recalculate_stop(avg_cost)
    high_water_mark = entry_price
    trailing_active = False
    ladder_done     = [False] * len(LADDERS)

    log("=" * 65)
    log("Strategy active:")
    log(f"  Entry price      : ${entry_price:.2f}  ({INITIAL_QTY} shares)")
    log(f"  Initial stop     : ${stop_price:.2f}  (-{STOP_PCT*100:.0f}% of avg cost)")
    log(f"  Trail trigger    : ${entry_price*(1+TRAIL_TRIGGER_PCT):.2f}  (+{TRAIL_TRIGGER_PCT*100:.0f}%)")
    for ldr in LADDERS:
        log(f"  {ldr['label']:10s}   : ${entry_price*(1-ldr['drop']):.2f}  (-{ldr['drop']*100:.0f}%) → buy {ldr['qty']} shares")
    log("=" * 65)

    # ── Main loop ──────────────────────────────────────────────────────────
    while True:
        try:
            price   = get_latest_price(SYMBOL)
            pnl_pct = (price - avg_cost) / avg_cost * 100

            log(
                f"TSLA ${price:.2f}  |  vs avg ${avg_cost:.2f} ({pnl_pct:+.2f}%)  |  "
                f"Stop ${stop_price:.2f}  |  Trail {'ON ' if trailing_active else 'OFF'}  |  "
                f"HWM ${high_water_mark:.2f}  |  Qty {total_qty}"
            )

            # ── 1. Stop loss ───────────────────────────────────────────────
            if price <= stop_price:
                log(f"STOP HIT — price ${price:.2f} ≤ stop ${stop_price:.2f}. Closing {total_qty} shares.")
                close_all(SYMBOL)
                realized = (price - avg_cost) * total_qty
                log(f"Position closed. Realized P&L: ${realized:+.2f}")
                send_embed(
                    TRADES_CH, f"TSLA STOP HIT — closed {total_qty} shares @ ${price:.2f}",
                    color=Color.RED,
                    description=f"Realized P&L: ${realized:+.2f}",
                    fields=[
                        {"name": "Avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                        {"name": "Stop was", "value": f"${stop_price:.2f}", "inline": True},
                    ],
                    footer="strategy.py",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "strategy.py", "stop_hit",
                          symbol=SYMBOL,
                          details={"exit_price": price, "qty": total_qty, "realized_pnl": realized})
                return

            # ── 2. Trailing stop logic ─────────────────────────────────────
            if not trailing_active and price >= entry_price * (1 + TRAIL_TRIGGER_PCT):
                trailing_active = True
                log(f"Trailing ACTIVATED at ${price:.2f} (+{TRAIL_TRIGGER_PCT*100:.0f}% from entry)")
                send_embed(
                    TRADES_CH, "TSLA Trailing Stop Activated",
                    color=Color.BLUE,
                    description=f"Price ${price:.2f} hit +{TRAIL_TRIGGER_PCT*100:.0f}% from entry. Floor will trail 5% below high-water mark.",
                    footer="strategy.py",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "strategy.py", "trail_activated",
                          symbol=SYMBOL, details={"price": price, "entry_price": entry_price})

            if trailing_active:
                high_water_mark = max(high_water_mark, price)
                new_stop = round(high_water_mark * (1 - TRAIL_DISTANCE_PCT), 2)
                if new_stop > stop_price:
                    log(f"Stop raised ${stop_price:.2f} → ${new_stop:.2f}  (HWM ${high_water_mark:.2f})")
                    old_stop = stop_price
                    stop_price = new_stop
                    send_embed(
                        TRADES_CH, f"TSLA Stop Raised → ${new_stop:.2f}",
                        color=Color.BLUE,
                        description=f"HWM ${high_water_mark:.2f} (was ${old_stop:.2f})",
                        footer="strategy.py",
                        actions_channel=ACTIONS_CH,
                    )
                    log_event(LOG_STREAM, "strategy.py", "stop_raised",
                              symbol=SYMBOL,
                              details={"old_stop": old_stop, "new_stop": new_stop, "hwm": high_water_mark})

            # ── 3. Ladder buys ─────────────────────────────────────────────
            for i, ldr in enumerate(LADDERS):
                if not ladder_done[i] and price <= entry_price * (1 - ldr["drop"]):
                    qty = ldr["qty"]
                    log(f"{ldr['label']} TRIGGERED — ${price:.2f} hit -{ldr['drop']*100:.0f}%. Buying {qty} shares.")
                    o = place_order(SYMBOL, qty, "buy")
                    log(f"{ldr['label']} order placed: {o['id']}")

                    # Recalculate avg cost and stop
                    total_cost  += price * qty
                    total_qty   += qty
                    avg_cost     = round(total_cost / total_qty, 2)
                    new_stop     = recalculate_stop(avg_cost)
                    # Stop only moves down on a ladder (lower avg cost), which is intended
                    stop_price   = new_stop
                    ladder_done[i] = True

                    log(f"  New avg cost: ${avg_cost:.2f} | New stop: ${stop_price:.2f} | Total qty: {total_qty}")
                    send_embed(
                        TRADES_CH, f"TSLA {ldr['label']} Triggered — bought {qty} shares @ ${price:.2f}",
                        color=Color.YELLOW,
                        fields=[
                            {"name": "New avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                            {"name": "New stop", "value": f"${new_stop:.2f}", "inline": True},
                            {"name": "Total qty", "value": str(total_qty), "inline": True},
                        ],
                        footer="strategy.py",
                        actions_channel=ACTIONS_CH,
                    )
                    log_event(LOG_STREAM, "strategy.py", "ladder_triggered",
                              symbol=SYMBOL,
                              details={"label": ldr["label"], "qty": qty, "price": price, "new_avg_cost": avg_cost},
                              alpaca_order_id=o["id"])

        except Exception as e:
            log(f"Error: {e} — retrying next tick")
            send_embed(
                ERRORS_CH, "strategy.py — exception in main loop",
                color=Color.RED,
                description=f"`{type(e).__name__}: {str(e)[:500]}`",
                footer="strategy.py",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "exception",
                      result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")

        time.sleep(POLL_INTERVAL)


def _load_state():
    import json
    with open(STATE_FILE) as f:
        return json.load(f)


def _save_state(state):
    import json
    state["last_checked"] = datetime.utcnow().isoformat() + "Z"
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def run_one_cycle():
    """Single check cycle for hosted execution.

    Reads strategy_state.json, runs one iteration of the stop / trail / ladder
    logic, writes state back. No looping, no time.sleep, no waiting on fills.
    Designed to be called once per GitHub Actions cron fire.
    """
    try:
        state = _load_state()
    except FileNotFoundError:
        log(f"No state file at {STATE_FILE} — initial run_strategy() must seed state first.")
        log_event(LOG_STREAM, "strategy.py", "no_state_file",
                  result="failure", notes=f"missing {STATE_FILE}")
        return

    if state.get("position_qty", 0) == 0:
        log("position_qty=0 — no shares held, skipping monitor cycle.")
        log_event(LOG_STREAM, "strategy.py", "cycle_skipped_no_position",
                  result="skipped", details={"state": state})
        return

    # Recover state into local vars matching run_strategy's naming
    entry_price     = state["entry_price"]
    avg_cost        = state["avg_cost"]
    total_qty       = state["position_qty"]
    total_cost      = state["total_cost"]
    stop_price      = state["stop_price"]
    high_water_mark = state["high_water_mark"]
    trailing_active = state["trailing_active"]
    ladder_done     = [state.get(f"ladder_{i+1}_done", False) for i in range(len(LADDERS))]

    try:
        price   = get_latest_price(SYMBOL)
        pnl_pct = (price - avg_cost) / avg_cost * 100

        log(
            f"TSLA ${price:.2f}  |  vs avg ${avg_cost:.2f} ({pnl_pct:+.2f}%)  |  "
            f"Stop ${stop_price:.2f}  |  Trail {'ON ' if trailing_active else 'OFF'}  |  "
            f"HWM ${high_water_mark:.2f}  |  Qty {total_qty}"
        )

        # ── 1. Stop loss ───────────────────────────────────────────────
        if price <= stop_price:
            log(f"STOP HIT — price ${price:.2f} ≤ stop ${stop_price:.2f}. Closing {total_qty} shares.")
            close_all(SYMBOL)
            realized = (price - avg_cost) * total_qty
            log(f"Position closed. Realized P&L: ${realized:+.2f}")
            send_embed(
                TRADES_CH, f"TSLA STOP HIT — closed {total_qty} shares @ ${price:.2f}",
                color=Color.RED,
                description=f"Realized P&L: ${realized:+.2f}",
                fields=[
                    {"name": "Avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                    {"name": "Stop was", "value": f"${stop_price:.2f}", "inline": True},
                ],
                footer="strategy.py",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "stop_hit",
                      symbol=SYMBOL,
                      details={"exit_price": price, "qty": total_qty, "realized_pnl": realized})
            # Mark position closed in state
            state["position_qty"] = 0
            state["total_cost"] = 0
            state["last_action"] = f"Stop hit at ${price:.2f}. Closed {total_qty} shares. Realized ${realized:+.2f}."
            _save_state(state)
            return

        # ── 2. Trailing stop logic ─────────────────────────────────────
        if not trailing_active and price >= entry_price * (1 + TRAIL_TRIGGER_PCT):
            trailing_active = True
            log(f"Trailing ACTIVATED at ${price:.2f} (+{TRAIL_TRIGGER_PCT*100:.0f}% from entry)")
            send_embed(
                TRADES_CH, "TSLA Trailing Stop Activated",
                color=Color.BLUE,
                description=f"Price ${price:.2f} hit +{TRAIL_TRIGGER_PCT*100:.0f}% from entry. Floor will trail 5% below high-water mark.",
                footer="strategy.py",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "trail_activated",
                      symbol=SYMBOL, details={"price": price, "entry_price": entry_price})

        if trailing_active:
            high_water_mark = max(high_water_mark, price)
            new_stop = round(high_water_mark * (1 - TRAIL_DISTANCE_PCT), 2)
            if new_stop > stop_price:
                log(f"Stop raised ${stop_price:.2f} → ${new_stop:.2f}  (HWM ${high_water_mark:.2f})")
                old_stop = stop_price
                stop_price = new_stop
                send_embed(
                    TRADES_CH, f"TSLA Stop Raised → ${new_stop:.2f}",
                    color=Color.BLUE,
                    description=f"HWM ${high_water_mark:.2f} (was ${old_stop:.2f})",
                    footer="strategy.py",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "strategy.py", "stop_raised",
                          symbol=SYMBOL,
                          details={"old_stop": old_stop, "new_stop": new_stop, "hwm": high_water_mark})

        # ── 3. Ladder buys ─────────────────────────────────────────────
        for i, ldr in enumerate(LADDERS):
            if not ladder_done[i] and price <= entry_price * (1 - ldr["drop"]):
                qty = ldr["qty"]
                log(f"{ldr['label']} TRIGGERED — ${price:.2f} hit -{ldr['drop']*100:.0f}%. Buying {qty} shares.")
                o = place_order(SYMBOL, qty, "buy")
                log(f"{ldr['label']} order placed: {o['id']}")

                total_cost  += price * qty
                total_qty   += qty
                avg_cost     = round(total_cost / total_qty, 2)
                new_stop     = recalculate_stop(avg_cost)
                stop_price   = new_stop
                ladder_done[i] = True

                log(f"  New avg cost: ${avg_cost:.2f} | New stop: ${stop_price:.2f} | Total qty: {total_qty}")
                send_embed(
                    TRADES_CH, f"TSLA {ldr['label']} Triggered — bought {qty} shares @ ${price:.2f}",
                    color=Color.YELLOW,
                    fields=[
                        {"name": "New avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                        {"name": "New stop", "value": f"${new_stop:.2f}", "inline": True},
                        {"name": "Total qty", "value": str(total_qty), "inline": True},
                    ],
                    footer="strategy.py",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "strategy.py", "ladder_triggered",
                          symbol=SYMBOL,
                          details={"label": ldr["label"], "qty": qty, "price": price, "new_avg_cost": avg_cost},
                          alpaca_order_id=o["id"])

        # ── Persist updated state ──────────────────────────────────────
        state["avg_cost"]        = avg_cost
        state["total_cost"]      = total_cost
        state["position_qty"]    = total_qty
        state["stop_price"]      = stop_price
        state["high_water_mark"] = high_water_mark
        state["trailing_active"] = trailing_active
        for i in range(len(LADDERS)):
            state[f"ladder_{i+1}_done"] = ladder_done[i]
        state["last_action"] = (
            f"Monitoring TSLA ${price:.2f} vs avg ${avg_cost:.2f} "
            f"(PnL {pnl_pct:+.2f}%). Stop ${stop_price:.2f}, "
            f"Trail {'ON' if trailing_active else 'OFF'}."
        )
        _save_state(state)
        log_event(LOG_STREAM, "strategy.py", "cycle_complete",
                  result="success",
                  details={"price": price, "avg_cost": avg_cost, "stop": stop_price,
                           "qty": total_qty, "trail": trailing_active})

    except Exception as e:
        log(f"Error in run_one_cycle: {e}")
        send_embed(
            ERRORS_CH, "strategy.py — exception in run_one_cycle",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer="strategy.py",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


if __name__ == "__main__":
    import sys
    selected_mode, remaining = config.parse_mode_arg(sys.argv[1:])
    apply_mode(selected_mode)
    if remaining and remaining[0] == "once":
        run_one_cycle()
    else:
        run_strategy()
