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
import uuid
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
    global TRADES_CH, ERRORS_CH, ACTIONS_CH, LOG_STREAM, MODE, EXCLUDED_SYMBOLS

    cfg = config.get_mode(mode_name)
    MODE = mode_name
    # Symbols handed back to manual control — strategy.py must not seed,
    # trail/ladder/stop, or otherwise touch them even though auto-discovery
    # sees the position. Empty for modes that don't opt in.
    EXCLUDED_SYMBOLS = config.excluded_symbols(mode_name)

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
    # trading to paper and leave the real account unmanaged. Fail loudly.
    if mode_name == "live" and "paper-api.alpaca.markets" in BASE_URL:
        raise RuntimeError(
            f"live mode resolved to the PAPER endpoint ({BASE_URL}) — refusing "
            f"to run. Set ALPACA_LIVE_BASE_URL to https://api.alpaca.markets/v2.")
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


def auto_discover_enabled() -> bool:
    """True when the active mode auto-discovers symbols from Alpaca positions."""
    return config.get_mode(MODE).get("auto_discover_symbols", False)


apply_mode(config.DEFAULT_MODE)


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# Retry policy — mirrors wheel_strategy._alpaca_request. See that file for
# the full rationale on which codes are retried.
_ALPACA_RETRY_STATUS = {429, 500, 502, 503, 504}
_ALPACA_RETRY_BACKOFFS = (2, 8)
_ALPACA_MAX_ATTEMPTS = 3


def _alpaca_request(method: str, url: str, **kwargs) -> requests.Response:
    """HTTP request to Alpaca with bounded retry on transient failures."""
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
            raise


def _gen_client_order_id() -> str:
    """Unique client_order_id for an order POST (R1 — idempotent retries).

    Mirrors wheel_strategy._gen_client_order_id (these scripts intentionally
    duplicate their Alpaca request layer). Stamped once and reused on every
    transport-level retry of the same call, so a lost response can't
    double-place: Alpaca rejects the duplicate id (422) and place_order
    resolves to the already-created order.
    """
    return f"{MODE or 'bot'}-{uuid.uuid4().hex}"


def _get_order_by_client_id(client_order_id):
    """Fetch an order by its client_order_id, or None if unresolvable."""
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


def place_order(symbol, qty, side, order_type="market", time_in_force="day"):
    # R1 — idempotent order placement (see _gen_client_order_id).
    body = {"symbol": symbol, "qty": qty, "side": side,
            "type": order_type, "time_in_force": time_in_force,
            "client_order_id": _gen_client_order_id()}
    resp = _alpaca_request(
        "POST", f"{BASE_URL}/orders", headers=HEADERS, json=body)
    if resp.status_code == 422 and "client_order_id" in (resp.text or "").lower():
        coid = body["client_order_id"]
        log(f"order client_order_id={coid} already exists — resolving to the "
            f"existing order (retry after a lost response)")
        existing = _get_order_by_client_id(coid)
        if existing is not None:
            return existing
    resp.raise_for_status()
    return resp.json()


def get_order(order_id):
    resp = _alpaca_request("GET", f"{BASE_URL}/orders/{order_id}", headers=HEADERS)
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


def get_stock_positions():
    """Return list of open stock positions on the current Alpaca account.

    Filters to asset_class='us_equity' so options are excluded (those are
    managed by wheel_strategy.py and long_options_strategy.py separately).
    """
    resp = _alpaca_request("GET", f"{BASE_URL}/positions", headers=HEADERS)
    resp.raise_for_status()
    return [p for p in resp.json() if p.get("asset_class") == "us_equity"]


def close_all(symbol):
    resp = _alpaca_request("DELETE", f"{BASE_URL}/positions/{symbol}", headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


def alpaca_err_detail(e) -> str:
    """Render an Alpaca exception WITH the response body.

    raise_for_status() raises an HTTPError whose str() is only the status
    line; Alpaca's actual reason lives in the response BODY. Mirror of the
    helper in wheel_strategy.py (these two scripts intentionally duplicate
    their Alpaca request layer).
    """
    msg = f"{type(e).__name__}: {e}"
    resp = getattr(e, "response", None)
    if resp is not None:
        body = (getattr(resp, "text", "") or "").strip()
        if body:
            msg = f"{msg} — {body[:400]}"
    return msg


def is_pdt_denied(detail: str) -> bool:
    """True if an Alpaca failure is a Pattern Day Trading block (40310100).

    A sub-$25k margin account that exceeds the day-trade limit gets every
    closing order denied — including stock exits via DELETE /positions/{sym}.
    Not a fixable per-cycle error, so callers route it to the actions
    firehose instead of pinging #errors every cycle (manual account PDT
    lockout, 2026-06-03). Mirror of wheel_strategy.is_pdt_denied.
    """
    d = (detail or "").lower()
    return "40310100" in d or "pattern day trading" in d


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
                footer=f"strategy.py · {MODE}",
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
                    footer=f"strategy.py · {MODE}",
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
                    footer=f"strategy.py · {MODE}",
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
                        footer=f"strategy.py · {MODE}",
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
                        footer=f"strategy.py · {MODE}",
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
                footer=f"strategy.py · {MODE}",
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

    # R27 (2026-06-16): defend against an incompletely-seeded state file. A
    # missing avg_cost/entry_price used to raise KeyError and crash the cycle
    # into #errors every tick; skip with a warning instead so the bot keeps
    # running (and the gap can be re-seeded).
    if state.get("avg_cost") is None or state.get("entry_price") is None:
        log("strategy state missing avg_cost/entry_price — skipping cycle (re-seed required)")
        log_event(LOG_STREAM, "strategy.py", "state_incomplete",
                  result="skipped", details={"keys": sorted(state.keys())})
        return

    # Recover state into local vars matching run_strategy's naming. Non-essential
    # keys fall back to sane defaults rather than KeyError on a partial state.
    entry_price     = state["entry_price"]
    avg_cost        = state["avg_cost"]
    total_qty       = state.get("position_qty", 0)
    total_cost      = state.get("total_cost") or round(avg_cost * total_qty, 2)
    stop_price      = state.get("stop_price") or recalculate_stop(avg_cost)
    high_water_mark = state.get("high_water_mark", entry_price)
    trailing_active = state.get("trailing_active", False)
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
            # R31 (2026-06-16): sell only the FREELY-AVAILABLE shares — never
            # DELETE the whole position. If the wheel got assigned and wrote a
            # covered call against some of these shares (stage 2), those shares
            # are locked as CC collateral; close_all(SYMBOL) would liquidate
            # them and leave a NAKED short call (unlimited upside risk) — and
            # would also dump the wheel's assigned shares. Mirror the manual
            # path: place a bounded sell of just the free shares.
            position = next((p for p in get_stock_positions()
                             if p.get("symbol") == SYMBOL), None)
            free_qty = _available_qty(position) if position else total_qty
            sell_qty = min(total_qty, free_qty)
            if sell_qty <= 0:
                log(f"STOP HIT at ${price:.2f} but 0 freely-sellable shares "
                    f"(all held as covered-call collateral) — not liquidating; "
                    f"wheel_strategy manages the covered call.")
                send_embed(
                    ACTIONS_CH, f"TSLA stop hit but shares are CC collateral — holding",
                    color=Color.YELLOW,
                    description=(
                        f"Price ${price:.2f} ≤ stop ${stop_price:.2f}, but all "
                        f"shares are locked as covered-call collateral. Not "
                        f"liquidating (would naked the call); wheel_strategy owns the CC."
                    ),
                    footer=f"strategy.py · {MODE}",
                    also_to_actions=False,
                )
                log_event(LOG_STREAM, "strategy.py", "stop_blocked_cc_collateral",
                          result="skipped", symbol=SYMBOL,
                          details={"price": price, "stop": stop_price, "qty": total_qty})
                return
            log(f"STOP HIT — price ${price:.2f} ≤ stop ${stop_price:.2f}. "
                f"Selling {sell_qty} freely-sellable shares (of {total_qty} tracked).")
            place_order(SYMBOL, sell_qty, "sell")
            realized = (price - avg_cost) * sell_qty
            remaining = total_qty - sell_qty
            log(f"Sold {sell_qty}. Realized P&L: ${realized:+.2f}. Remaining tracked: {remaining}")
            send_embed(
                TRADES_CH, f"TSLA STOP HIT — sold {sell_qty} shares @ ${price:.2f}",
                color=Color.RED,
                description=(f"Realized P&L: ${realized:+.2f}"
                             + (f" · {remaining} shares remain (CC collateral)"
                                if remaining else "")),
                fields=[
                    {"name": "Avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                    {"name": "Stop was", "value": f"${stop_price:.2f}", "inline": True},
                ],
                footer=f"strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "stop_hit",
                      symbol=SYMBOL,
                      details={"exit_price": price, "qty": sell_qty,
                               "realized_pnl": realized, "remaining": remaining})
            state["position_qty"] = remaining
            state["total_cost"] = round(avg_cost * remaining, 2)
            state["last_action"] = (
                f"Stop hit at ${price:.2f}. Sold {sell_qty} shares. "
                f"Realized ${realized:+.2f}."
                + (f" {remaining} CC-collateral shares held." if remaining else ""))
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
                footer=f"strategy.py · {MODE}",
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
                    footer=f"strategy.py · {MODE}",
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
                    footer=f"strategy.py · {MODE}",
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
            footer=f"strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


def _scaled_ladders(initial_qty: int):
    """Return ladder list with qty scaled to the position size.

    TSLA's hand-tuned ratios are 8/12/20 against an INITIAL_QTY of 10 — i.e.
    multipliers of 0.8 / 1.2 / 2.0. We reuse those multipliers for every
    auto-discovered symbol so a 5-share manual position ladders 4/6/10 and
    a 1-share position ladders 1/1/2 (rounding ensures at least 1 share).
    """
    multipliers = [0.8, 1.2, 2.0]
    return [
        {"drop": LADDERS[i]["drop"],
         "qty": max(1, round(initial_qty * multipliers[i])),
         "label": LADDERS[i]["label"]}
        for i in range(len(LADDERS))
    ]


def _available_qty(position: dict) -> int:
    """Freely-sellable share count for a position.

    Alpaca's `qty_available` excludes shares locked as options collateral
    (a covered call written against wheel-assigned shares) or reserved by
    open orders. strategy.py in manual mode only manages the FREE shares —
    the locked portion belongs to wheel_strategy.py's covered call. Without
    this, a manual stop tried to liquidate the WHOLE position (DELETE
    /positions/{sym}) and Alpaca rejected it 40310000 'insufficient qty'
    because most shares were held_for_options (SNAP: 110 held, 100 locked,
    10 free — 2026-06-03), crashing the symbol cycle into #errors.
    """
    try:
        return int(float(position.get("qty_available", position["qty"])))
    except (KeyError, TypeError, ValueError):
        return int(float(position.get("qty", 0)))


def _manual_seed_state(symbol: str, position: dict) -> dict:
    """Seed state for a newly-discovered manual-mode position.

    Treats current avg cost as the entry baseline since the user bought
    these shares manually — the bot has no ladder/trail history pre-seed.
    """
    entry_price = round(float(position["avg_entry_price"]), 2)
    qty = _available_qty(position)
    return {
        "first_seen":      datetime.utcnow().isoformat() + "Z",
        "entry_price":     entry_price,
        "initial_qty":     qty,
        "avg_cost":        entry_price,
        "total_cost":      round(entry_price * qty, 2),
        "position_qty":    qty,
        "stop_price":      recalculate_stop(entry_price),
        "high_water_mark": entry_price,
        "trailing_active": False,
        "ladder_done":     [False] * len(LADDERS),
        "last_action":     f"Seeded from manual position: {qty} shares @ ${entry_price:.2f}",
    }


def _manual_run_symbol(symbol: str, sym_state: dict, alpaca_qty: int, alpaca_avg_cost: float) -> dict:
    """One cycle of trail/ladder/stop logic for a single manual-mode symbol.

    Reconciles bot state against Alpaca first (the user may have bought or
    sold shares by hand since the last cycle), then applies the same
    stop-loss / trailing-stop / ladder-buy logic that conservative TSLA uses.
    Returns the updated sym_state. Persistence is handled by the caller.
    """
    # ── Reconcile with Alpaca position drift ──────────────────────────────
    bot_qty = int(sym_state.get("position_qty", 0))
    if alpaca_qty != bot_qty:
        log(f"{symbol}: position drift bot={bot_qty} alpaca={alpaca_qty} — adopting Alpaca's avg cost")
        old_avg = float(sym_state.get("avg_cost") or alpaca_avg_cost)
        sym_state["position_qty"] = alpaca_qty
        sym_state["avg_cost"]     = round(alpaca_avg_cost, 2)
        sym_state["total_cost"]   = round(alpaca_avg_cost * alpaca_qty, 2)
        sym_state["stop_price"]   = recalculate_stop(alpaca_avg_cost)
        # R2 (2026-06-16): an average-DOWN lowers the cost basis. Leaving a
        # stale (higher) high-water mark + trailing_active would let the
        # trailing block below snap the stop right back ABOVE the new cost
        # basis (it only ever raises the stop), instantly liquidating the
        # shares the user just added on the dip. Re-baseline the trail to the
        # new cost when averaging down so the stop sits at new_avg × 0.90 and
        # the trail re-arms from the new basis. An average-UP keeps its
        # ratcheted trail (don't give back a locked-in gain).
        if alpaca_avg_cost < old_avg - 1e-9:
            sym_state["high_water_mark"] = round(alpaca_avg_cost, 2)
            sym_state["entry_price"]     = round(alpaca_avg_cost, 2)
            sym_state["trailing_active"] = False
        # R20 (2026-06-16): if the managed (free) share count has grown beyond
        # the initial baseline — e.g. covered-call collateral was released back
        # to freely-sellable, or the user added shares — re-baseline initial_qty
        # so ladder sizing (_scaled_ladders) scales to the REAL position instead
        # of the stale, smaller starting count. Only ever grows it.
        if alpaca_qty > int(sym_state.get("initial_qty", 0)):
            sym_state["initial_qty"] = alpaca_qty

    if sym_state["position_qty"] == 0:
        sym_state["last_action"] = "Position empty — skipping cycle."
        return sym_state

    # ── Local vars matching run_one_cycle's naming ────────────────────────
    entry_price     = sym_state["entry_price"]
    avg_cost        = sym_state["avg_cost"]
    total_qty       = sym_state["position_qty"]
    total_cost      = sym_state["total_cost"]
    stop_price      = sym_state["stop_price"]
    high_water_mark = sym_state["high_water_mark"]
    trailing_active = sym_state["trailing_active"]
    ladder_done     = list(sym_state.get("ladder_done", [False] * len(LADDERS)))
    ladders         = _scaled_ladders(int(sym_state["initial_qty"]))

    price = get_latest_price(symbol)
    pnl_pct = (price - avg_cost) / avg_cost * 100
    log(
        f"{symbol} ${price:.2f}  |  avg ${avg_cost:.2f} ({pnl_pct:+.2f}%)  |  "
        f"Stop ${stop_price:.2f}  |  Trail {'ON' if trailing_active else 'OFF'}  |  "
        f"HWM ${high_water_mark:.2f}  |  Qty {total_qty}"
    )

    # ── 1. Stop loss ──────────────────────────────────────────────────────
    if price <= stop_price:
        log(f"{symbol} STOP HIT — ${price:.2f} ≤ ${stop_price:.2f}. Closing {total_qty} shares.")
        # Sell exactly the managed (free) quantity rather than close_all's
        # full-position liquidation — the position may also hold shares locked
        # as covered-call collateral that belong to the wheel, and DELETE
        # /positions/{sym} would try to dump those too (40310000 insufficient
        # qty). total_qty here is already the freely-sellable count.
        place_order(symbol, total_qty, "sell")
        realized = (price - avg_cost) * total_qty
        send_embed(
            TRADES_CH, f"{symbol} STOP HIT — closed {total_qty} shares @ ${price:.2f}",
            color=Color.RED,
            description=f"Realized P&L: ${realized:+.2f}",
            fields=[
                {"name": "Avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                {"name": "Stop was", "value": f"${stop_price:.2f}", "inline": True},
            ],
            footer=f"strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "strategy.py", "stop_hit",
                  symbol=symbol,
                  details={"exit_price": price, "qty": total_qty, "realized_pnl": realized})
        sym_state["position_qty"] = 0
        sym_state["total_cost"]   = 0
        sym_state["last_action"]  = f"Stop hit at ${price:.2f}. Closed {total_qty} shares. Realized ${realized:+.2f}."
        return sym_state

    # ── 2. Trailing stop ──────────────────────────────────────────────────
    if not trailing_active and price >= entry_price * (1 + TRAIL_TRIGGER_PCT):
        trailing_active = True
        send_embed(
            TRADES_CH, f"{symbol} Trailing Stop Activated",
            color=Color.BLUE,
            description=f"${price:.2f} hit +{TRAIL_TRIGGER_PCT*100:.0f}% from entry. Floor trails 5% below HWM.",
            footer=f"strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "strategy.py", "trail_activated",
                  symbol=symbol, details={"price": price, "entry_price": entry_price})

    if trailing_active:
        high_water_mark = max(high_water_mark, price)
        new_stop = round(high_water_mark * (1 - TRAIL_DISTANCE_PCT), 2)
        if new_stop > stop_price:
            old_stop = stop_price
            stop_price = new_stop
            send_embed(
                TRADES_CH, f"{symbol} Stop Raised → ${new_stop:.2f}",
                color=Color.BLUE,
                description=f"HWM ${high_water_mark:.2f} (was ${old_stop:.2f})",
                footer=f"strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "stop_raised",
                      symbol=symbol,
                      details={"old_stop": old_stop, "new_stop": new_stop, "hwm": high_water_mark})

    # ── 3. Ladder buys ────────────────────────────────────────────────────
    for i, ldr in enumerate(ladders):
        if not ladder_done[i] and price <= entry_price * (1 - ldr["drop"]):
            qty = ldr["qty"]
            log(f"{symbol} {ldr['label']} TRIGGERED — ${price:.2f} hit -{ldr['drop']*100:.0f}%. Buying {qty}.")
            o = place_order(symbol, qty, "buy")
            total_cost  += price * qty
            total_qty   += qty
            avg_cost     = round(total_cost / total_qty, 2)
            stop_price   = recalculate_stop(avg_cost)
            ladder_done[i] = True
            send_embed(
                TRADES_CH, f"{symbol} {ldr['label']} Triggered — bought {qty} shares @ ${price:.2f}",
                color=Color.YELLOW,
                fields=[
                    {"name": "New avg cost", "value": f"${avg_cost:.2f}", "inline": True},
                    {"name": "New stop",     "value": f"${stop_price:.2f}", "inline": True},
                    {"name": "Total qty",    "value": str(total_qty), "inline": True},
                ],
                footer=f"strategy.py · {MODE}",
                actions_channel=ACTIONS_CH,
            )
            log_event(LOG_STREAM, "strategy.py", "ladder_triggered",
                      symbol=symbol,
                      details={"label": ldr["label"], "qty": qty, "price": price, "new_avg_cost": avg_cost},
                      alpaca_order_id=o["id"])

    # ── Persist ───────────────────────────────────────────────────────────
    sym_state["avg_cost"]        = avg_cost
    sym_state["total_cost"]      = total_cost
    sym_state["position_qty"]    = total_qty
    sym_state["stop_price"]      = stop_price
    sym_state["high_water_mark"] = high_water_mark
    sym_state["trailing_active"] = trailing_active
    sym_state["ladder_done"]     = ladder_done
    sym_state["last_action"] = (
        f"Monitoring ${price:.2f} vs avg ${avg_cost:.2f} (PnL {pnl_pct:+.2f}%). "
        f"Stop ${stop_price:.2f}, Trail {'ON' if trailing_active else 'OFF'}."
    )
    return sym_state


def run_one_cycle_manual():
    """Manual-mode cycle: trail/ladder/stop on every stock the user holds.

    Symbols are auto-discovered from Alpaca positions each cycle. State is
    keyed by symbol in strategy_state_manual.json. New positions seed at
    the current avg cost; closed positions are pruned from state.
    """
    import json

    try:
        positions = get_stock_positions()
    except Exception as e:
        log(f"Error fetching positions: {e}")
        send_embed(
            ERRORS_CH, "strategy.py — failed to fetch positions",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer=f"strategy.py · {MODE}",
            actions_channel=ACTIONS_CH,
        )
        log_event(LOG_STREAM, "strategy.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise

    # Load state (or initialize empty)
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except FileNotFoundError:
        state = {}

    # Index Alpaca positions for quick lookup
    held = {p["symbol"]: p for p in positions}

    # Drop symbols handed back to manual control — the user wants to manage
    # (e.g. exit) these by hand, so the bot leaves them alone: no seed, no
    # trail/ladder/stop. The position stays in Alpaca; the bot just ignores it.
    if EXCLUDED_SYMBOLS:
        excluded_held = sorted(s for s in held if s.upper() in EXCLUDED_SYMBOLS)
        if excluded_held:
            log(f"Excluding {', '.join(excluded_held)} from strategy management "
                f"(config.excluded_symbols) — bot will not trail/ladder/stop these.")
        held = {s: p for s, p in held.items() if s.upper() not in EXCLUDED_SYMBOLS}

    if not held:
        log("No stock positions held — manual strategy cycle is a no-op.")
        log_event(LOG_STREAM, "strategy.py", "no_positions",
                  result="skipped", details={"mode": MODE})
        state["_meta"] = {"last_checked": datetime.utcnow().isoformat() + "Z"}
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
        return

    log(f"Manual strategy cycle: {len(held)} symbols held — {', '.join(sorted(held))}")

    # Process each held symbol with per-symbol error isolation
    for symbol, position in sorted(held.items()):
        try:
            if symbol not in state or symbol.startswith("_"):
                log(f"{symbol}: first sighting, seeding state")
                state[symbol] = _manual_seed_state(symbol, position)
                send_embed(
                    TRADES_CH, f"{symbol} — manual position seeded",
                    color=Color.BLUE,
                    description=(
                        f"Bot now managing {state[symbol]['position_qty']} shares @ "
                        f"${state[symbol]['entry_price']:.2f}. Stop ${state[symbol]['stop_price']:.2f}."
                    ),
                    footer=f"strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )

            alpaca_qty = _available_qty(position)  # free shares only (excl. CC collateral)
            alpaca_avg = float(position["avg_entry_price"])
            state[symbol] = _manual_run_symbol(symbol, state[symbol], alpaca_qty, alpaca_avg)
        except Exception as e:
            detail = alpaca_err_detail(e)
            log(f"{symbol}: error in cycle: {detail}")
            # PDT blocks are not a fixable per-cycle error — a sub-$25k margin
            # account that hit the day-trade limit has every stock exit denied.
            # Route to the actions firehose instead of pinging #errors each
            # cycle; the position is intact until the PDT restriction clears.
            if is_pdt_denied(detail):
                send_embed(
                    ACTIONS_CH, f"⏸️ {symbol} exit blocked by PDT",
                    color=Color.YELLOW,
                    description=(
                        f"Closing {symbol} was denied by Alpaca Pattern Day "
                        f"Trading protection (account < $25k, day-trade limit "
                        f"hit). Position is intact; the exit can't go through "
                        f"until the PDT restriction clears. Not retrying as an "
                        f"error."
                    ),
                    footer=f"strategy.py · {MODE}",
                    also_to_actions=False,
                )
                log_event(LOG_STREAM, "strategy.py", "exit_pdt_blocked",
                          symbol=symbol, result="skipped", notes=detail[:500])
            else:
                send_embed(
                    ERRORS_CH, f"strategy.py — {symbol} cycle exception",
                    color=Color.RED,
                    description=f"`{detail[:500]}`",
                    footer=f"strategy.py · {MODE}",
                    actions_channel=ACTIONS_CH,
                )
                log_event(LOG_STREAM, "strategy.py", "exception",
                          symbol=symbol, result="failure",
                          notes=detail[:500])
            # Continue to next symbol — don't break the whole cycle on one failure

    # Prune symbols the user has fully closed (not in held AND state qty is 0)
    pruned = []
    for sym in list(state):
        if sym.startswith("_"):
            continue
        if sym not in held and int(state[sym].get("position_qty", 0)) == 0:
            pruned.append(sym)
            del state[sym]
    if pruned:
        log(f"Pruned closed positions from state: {', '.join(pruned)}")

    state["_meta"] = {"last_checked": datetime.utcnow().isoformat() + "Z"}
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


if __name__ == "__main__":
    import sys
    selected_mode, remaining = config.parse_mode_arg(sys.argv[1:])
    apply_mode(selected_mode)
    if remaining and remaining[0] == "once":
        if auto_discover_enabled():
            run_one_cycle_manual()
        else:
            run_one_cycle()
    else:
        if auto_discover_enabled():
            # Manual mode has no run_strategy() seed flow; the cycle is the
            # entire strategy and runs once per cron fire.
            run_one_cycle_manual()
        else:
            run_strategy()
