#!/usr/bin/env python3
"""
Daily Summary — combined end-of-day report across all strategies.

Reads state from:
  - strategy_state.json     (TSLA stock — trailing stop / ladder)
  - wheel_state.json        (TSLA wheel — puts / covered calls)
  - congress-copy/data/state.db  (congress-copy positions)

Sends a single combined embed to #daily-summary and writes a structured
JSONL line to logs/daily-summary.jsonl.

Designed to be invoked once per day by GitHub Actions cron at 3:05 PM CT.
"""
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import requests
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

ROOT             = Path(__file__).resolve().parent
STRATEGY_STATE   = ROOT / "strategy_state.json"
WHEEL_STATE      = ROOT / "wheel_state.json"
CONGRESS_STATE   = ROOT / "congress-copy" / "data" / "state.db"


def _load_json(path):
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def _get_account():
    resp = requests.get(f"{BASE_URL}/account", headers=HEADERS, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _get_latest_price(symbol):
    try:
        resp = requests.get(
            f"{DATA_URL}/stocks/{symbol}/trades/latest",
            headers=HEADERS,
            params={"feed": "iex"},
            timeout=10,
        )
        resp.raise_for_status()
        return float(resp.json()["trade"]["p"])
    except Exception:
        return None


def _summarize_strategy():
    state = _load_json(STRATEGY_STATE)
    if not state:
        return {"available": False}
    qty = state.get("position_qty", 0)
    return {
        "available": True,
        "qty": qty,
        "avg_cost": state.get("avg_cost"),
        "stop_price": state.get("stop_price"),
        "trailing_active": state.get("trailing_active", False),
        "last_action": state.get("last_action", ""),
    }


def _summarize_wheel():
    state = _load_json(WHEEL_STATE)
    if not state:
        return {"available": False}
    return {
        "available": True,
        "stage": state.get("stage", 1),
        "current_contract": state.get("current_contract"),
        "premium_today": state.get("total_premium_today", 0),
        "total_premium": state.get("total_premium_collected", 0),
        "cycle_count": state.get("cycle_count", 0),
        "cost_basis": state.get("cost_basis_per_share"),
    }


def _summarize_congress():
    if not CONGRESS_STATE.exists():
        return {"available": False}
    try:
        conn = sqlite3.connect(str(CONGRESS_STATE), timeout=10.0)
        conn.row_factory = sqlite3.Row
        open_positions = conn.execute(
            "SELECT COUNT(*) AS n FROM positions WHERE closed_at IS NULL"
        ).fetchone()["n"]
        closed_today = conn.execute(
            "SELECT COUNT(*) AS n FROM positions "
            "WHERE closed_at IS NOT NULL AND DATE(closed_at) = DATE('now')"
        ).fetchone()["n"]
        recent_events = conn.execute(
            "SELECT event_type, COUNT(*) AS n FROM events "
            "WHERE DATE(created_at) = DATE('now') GROUP BY event_type"
        ).fetchall()
        conn.close()
        return {
            "available": True,
            "open_positions": open_positions,
            "closed_today": closed_today,
            "events_today": {row["event_type"]: row["n"] for row in recent_events},
        }
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}


def run_daily_summary():
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        account     = _get_account()
        tsla_price  = _get_latest_price("TSLA")
        strategy    = _summarize_strategy()
        wheel       = _summarize_wheel()
        congress    = _summarize_congress()

        cash      = float(account["cash"])
        portfolio = float(account["portfolio_value"])

        # ── Build embed fields ─────────────────────────────────────────
        fields = [
            {"name": "Date", "value": today, "inline": True},
            {"name": "TSLA price", "value": f"${tsla_price:.2f}" if tsla_price else "—", "inline": True},
            {"name": "Portfolio value", "value": f"${portfolio:,.2f}", "inline": True},
        ]

        if strategy["available"]:
            fields.append({
                "name": "TSLA Stock (strategy.py)",
                "value": (
                    f"Qty: {strategy['qty']} | Avg: ${strategy['avg_cost']:.2f} | "
                    f"Stop: ${strategy['stop_price']:.2f} | "
                    f"Trail: {'ON' if strategy['trailing_active'] else 'OFF'}"
                ),
                "inline": False,
            })

        if wheel["available"]:
            fields.append({
                "name": "TSLA Wheel (wheel_strategy.py)",
                "value": (
                    f"Stage {wheel['stage']} | "
                    f"Contract: {wheel['current_contract'] or 'none'} | "
                    f"Premium today: ${wheel['premium_today']:.2f} | "
                    f"Total premium: ${wheel['total_premium']:.2f} | "
                    f"Cycles: {wheel['cycle_count']}"
                ),
                "inline": False,
            })

        if congress["available"]:
            events_str = ", ".join(f"{k}={v}" for k, v in congress.get("events_today", {}).items()) or "none"
            fields.append({
                "name": "Congress Copy",
                "value": (
                    f"Open positions: {congress['open_positions']} | "
                    f"Closed today: {congress['closed_today']} | "
                    f"Events today: {events_str}"
                ),
                "inline": False,
            })

        fields.append({"name": "Cash", "value": f"${cash:,.2f}", "inline": True})

        send_embed(
            "summary", f"Daily Trading Summary — {today}",
            color=Color.BLUE,
            fields=fields,
            footer="daily_summary.py",
        )

        log_event("daily-summary", "daily_summary.py", "daily_summary",
                  result="success",
                  details={
                      "date": today,
                      "tsla_price": tsla_price,
                      "portfolio_value": portfolio,
                      "cash": cash,
                      "strategy": strategy,
                      "wheel": wheel,
                      "congress": congress,
                  })

        print(json.dumps({
            "date": today,
            "tsla_price": tsla_price,
            "portfolio_value": portfolio,
            "strategy": strategy,
            "wheel": wheel,
            "congress": congress,
        }, indent=2, default=str))

    except Exception as e:
        send_embed(
            "errors", "daily_summary.py crashed",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer="daily_summary.py",
        )
        log_event("errors", "daily_summary.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


if __name__ == "__main__":
    run_daily_summary()
