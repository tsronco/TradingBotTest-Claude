#!/usr/bin/env python3
"""
Daily Summary — combined end-of-day report for one or both paper accounts.

Three invocation modes:

  python daily_summary.py --mode conservative
      → posts a daily summary embed to #daily-summary covering the
        conservative account: strategy_state.json + wheel_state.json +
        congress-copy/data/state.db + long-options positions.

  python daily_summary.py --mode aggressive
      → posts a daily summary embed to #aggressive-summary covering the
        aggressive account: strategy_state_aggressive.json +
        wheel_state_aggressive.json + long-options positions.
        (Congress copy doesn't run on aggressive — same source, would dupe.)

  python daily_summary.py --head-to-head
      → reads BOTH accounts' Alpaca portfolio + premium totals, posts a
        side-by-side comparison embed to #daily-summary AND #aggressive-summary
        so each Discord side sees the race result.

The GitHub Actions workflow runs all three sequentially: conservative →
aggressive → head-to-head, so each fire produces three Discord embeds.
"""
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv

import config
from notifications import send_embed, log_event, Color

load_dotenv()

ROOT = Path(__file__).resolve().parent

# Conservative-only: congress-copy lives next to this script
CONGRESS_STATE = ROOT / "congress-copy" / "data" / "state.db"


# ── Alpaca helpers (parameterized so head-to-head can hit both accounts) ──


def _headers_for(cfg: dict) -> dict:
    return {
        "APCA-API-KEY-ID":     os.getenv(cfg["alpaca_key_env"]),
        "APCA-API-SECRET-KEY": os.getenv(cfg["alpaca_secret_env"]),
        "accept":              "application/json",
    }


def _base_url_for(cfg: dict) -> str:
    return os.getenv(cfg["alpaca_url_env"], "https://paper-api.alpaca.markets/v2")


def _get_account(cfg: dict) -> dict:
    resp = requests.get(f"{_base_url_for(cfg)}/account", headers=_headers_for(cfg), timeout=10)
    resp.raise_for_status()
    return resp.json()


def _get_positions(cfg: dict) -> list[dict]:
    resp = requests.get(f"{_base_url_for(cfg)}/positions", headers=_headers_for(cfg), timeout=10)
    resp.raise_for_status()
    return resp.json()


# ── State summarizers (per mode) ──────────────────────────────────────────


def _load_json(path):
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def _summarize_strategy(cfg: dict) -> dict:
    state = _load_json(ROOT / cfg["strategy_state_file"])
    if not state:
        return {"available": False}

    # Single-stock format (conservative/aggressive — TSLA only)
    if "position_qty" in state:
        return {
            "available":       True,
            "format":          "single_stock",
            "qty":             state.get("position_qty", 0),
            "avg_cost":        state.get("avg_cost"),
            "stop_price":      state.get("stop_price"),
            "trailing_active": state.get("trailing_active", False),
            "last_action":     state.get("last_action", ""),
        }

    # Multi-symbol format (manual mode — auto-discovered positions)
    per_symbol = {}
    for sym, sym_state in state.items():
        if sym.startswith("_") or not isinstance(sym_state, dict):
            continue
        per_symbol[sym] = {
            "qty":             sym_state.get("position_qty", 0),
            "avg_cost":        sym_state.get("avg_cost"),
            "stop_price":      sym_state.get("stop_price"),
            "trailing_active": sym_state.get("trailing_active", False),
            "last_action":     sym_state.get("last_action", ""),
        }
    if not per_symbol:
        return {"available": False}
    return {
        "available": True,
        "format":    "multi_stock",
        "symbols":   per_symbol,
    }


def _summarize_wheel(cfg: dict) -> dict:
    """Aggregate wheel state across all symbols for the given mode."""
    state = _load_json(ROOT / cfg["wheel_state_file"])
    if not state:
        return {"available": False}

    # Legacy single-stock format (only ever applied to conservative)
    if "stage" in state:
        return {
            "available": True,
            "format": "legacy_single_stock",
            "TSLA": {
                "stage": state.get("stage", 1),
                "current_contract": state.get("current_contract"),
                "premium_today": state.get("total_premium_today", 0),
                "total_premium": state.get("total_premium_collected", 0),
                "cycle_count": state.get("cycle_count", 0),
                "cost_basis": state.get("cost_basis_per_share"),
            },
            "total_premium": state.get("total_premium_collected", 0),
            "total_today":   state.get("total_premium_today", 0),
            "total_cycles":  state.get("cycle_count", 0),
        }

    # Multi-stock format
    per_symbol = {}
    total_premium = 0.0
    total_today   = 0.0
    total_cycles  = 0
    for sym, sym_state in state.items():
        if sym.startswith("_") or not isinstance(sym_state, dict):
            continue
        per_symbol[sym] = {
            "stage": sym_state.get("stage", 1),
            "current_contract": sym_state.get("current_contract"),
            "premium_today": sym_state.get("total_premium_today", 0),
            "total_premium": sym_state.get("total_premium_collected", 0),
            "cycle_count": sym_state.get("cycle_count", 0),
            "cost_basis": sym_state.get("cost_basis_per_share"),
        }
        total_premium += sym_state.get("total_premium_collected", 0) or 0
        total_today   += sym_state.get("total_premium_today", 0) or 0
        total_cycles  += sym_state.get("cycle_count", 0) or 0

    return {
        "available": True,
        "format": "multi_stock",
        "symbols": per_symbol,
        "total_premium": round(total_premium, 2),
        "total_today":   round(total_today, 2),
        "total_cycles":  total_cycles,
    }


def _summarize_held_stocks(cfg: dict, tracked_symbols: set[str]) -> dict:
    """Pull stock (us_equity) positions from Alpaca that are NOT already
    tracked by strategy.py or wheel_strategy.py.

    Used as a "ground truth" check in the daily summary so a position that
    slipped past the bot's symbol lists still shows up — e.g. a symbol
    removed from config that still has shares, a manual buy made between
    the last bot cycle and the 4:12 PM summary, or an old wheel assignment.

    Symbols already in `tracked_symbols` (strategy state ∪ wheel state) are
    filtered out so this section doesn't duplicate the strategy block.
    """
    try:
        positions = _get_positions(cfg)
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}

    held = []
    for p in positions:
        if p.get("asset_class") != "us_equity":
            continue
        symbol = p.get("symbol")
        if not symbol or symbol in tracked_symbols:
            continue
        try:
            qty     = float(p.get("qty", 0))
            entry   = float(p.get("avg_entry_price", 0))
            current = float(p.get("current_price", 0))
            mv      = float(p.get("market_value", 0))
            pnl_d   = float(p.get("unrealized_pl", 0))
            pnl_pct = float(p.get("unrealized_plpc", 0))
        except (TypeError, ValueError):
            continue
        if qty == 0:
            continue
        held.append({
            "symbol":       symbol,
            "qty":          qty,
            "entry":        entry,
            "current":      current,
            "market_value": round(mv, 2),
            "pnl_dollars":  round(pnl_d, 2),
            "pnl_pct":      pnl_pct,
        })

    return {
        "available": True,
        "count":     len(held),
        "positions": held,
    }


def _tracked_stock_symbols(strategy: dict, wheel: dict) -> set[str]:
    """Build the set of stock symbols the bot is already managing, so the
    held-stocks ground-truth section can filter them out and avoid dupes."""
    tracked: set[str] = set()
    if strategy.get("available"):
        if strategy.get("format") == "multi_stock":
            tracked.update(strategy.get("symbols", {}).keys())
        else:
            # single_stock format on conservative/aggressive is always TSLA
            tracked.add("TSLA")
    if wheel.get("available"):
        if wheel.get("format") == "legacy_single_stock":
            tracked.add("TSLA")
        else:
            tracked.update(
                k for k in wheel.get("symbols", {}).keys()
                if not k.startswith("_")
            )
    return tracked


def _summarize_long_options(cfg: dict) -> dict:
    """Pull all LONG option positions (qty > 0) for the given mode's account."""
    try:
        positions = _get_positions(cfg)
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}

    longs = []
    total_pnl = 0.0
    for p in positions:
        if p.get("asset_class") != "us_option":
            continue
        try:
            qty = float(p.get("qty", 0))
        except (TypeError, ValueError):
            continue
        if qty <= 0:
            continue
        try:
            entry   = float(p.get("avg_entry_price", 0))
            current = float(p.get("current_price", 0))
            mv      = float(p.get("market_value", 0))
            pnl     = (current - entry) * 100 * qty
        except (TypeError, ValueError):
            continue
        longs.append({
            "symbol":       p.get("symbol"),
            "qty":          int(qty),
            "entry":        entry,
            "current":      current,
            "market_value": mv,
            "pnl_dollars":  round(pnl, 2),
            "pnl_pct":      round((current - entry) / entry, 4) if entry > 0 else 0,
        })
        total_pnl += pnl

    return {
        "available": True,
        "count":     len(longs),
        "positions": longs,
        "total_pnl": round(total_pnl, 2),
    }


def _reset_wheel_today_counters(cfg: dict) -> None:
    """Zero `total_premium_today` for every symbol in the wheel state file.

    Called by `run_daily_summary` when invoked with `--reset-counters` so the
    daily counter rolls over after each end-of-day summary post. The actual
    reset block in wheel_strategy.run_daily_summary() never fires in
    production because the GitHub Actions workflow runs daily_summary.py,
    not `python wheel_strategy.py summary`.

    Skips underscore-prefixed top-level keys (e.g. `_meta`) and any non-dict
    values. Handles both multi-stock (new) and legacy single-stock format.
    Silent no-op if the state file doesn't exist.
    """
    state_path = ROOT / cfg["wheel_state_file"]
    if not state_path.exists():
        return

    with open(state_path) as f:
        state = json.load(f)

    # Legacy single-stock format (top-level `stage` + counters)
    if "stage" in state and "total_premium_today" in state:
        state["total_premium_today"] = 0.0

    # Multi-stock format (per-symbol dicts at top level)
    for key, value in state.items():
        if key.startswith("_") or not isinstance(value, dict):
            continue
        if "total_premium_today" in value:
            value["total_premium_today"] = 0.0

    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)


def _summarize_congress() -> dict:
    """Conservative-only: read congress-copy SQLite state."""
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
            "closed_today":   closed_today,
            "events_today":   {row["event_type"]: row["n"] for row in recent_events},
        }
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}


# ── Per-mode daily summary ────────────────────────────────────────────────


def run_daily_summary(mode_name: str, reset_counters: bool = False) -> None:
    """Post a daily summary embed for the given mode to its summary channel.

    When `reset_counters` is True (CI/`--reset-counters` flag), zero out
    every symbol's `total_premium_today` in the wheel state file AFTER the
    embed has been posted, so tomorrow's "Premium today" starts from zero.
    Local invocations omit the flag so they don't mutate state on read.
    """
    cfg          = config.get_mode(mode_name)
    now          = datetime.now()
    today        = now.strftime("%Y-%m-%d")        # ISO — used in log_event details
    today_pretty = now.strftime("%m/%d/%Y")        # American MM/DD/YYYY — shown in Discord

    summary_ch = cfg["summary_channel"]
    errors_ch  = cfg["errors_channel"]
    actions_ch = cfg["actions_channel"]
    log_stream = cfg["log_stream"]

    try:
        account    = _get_account(cfg)
        strategy   = _summarize_strategy(cfg)
        wheel      = _summarize_wheel(cfg)
        long_opts  = _summarize_long_options(cfg)
        held_stocks = _summarize_held_stocks(cfg, _tracked_stock_symbols(strategy, wheel))
        congress   = _summarize_congress() if mode_name == "conservative" else {"available": False}

        cash      = float(account["cash"])
        portfolio = float(account["portfolio_value"])
        equity    = float(account.get("equity", portfolio))

        title = f"Daily Trading Summary ({mode_name}) — {today_pretty}"

        fields = [
            {"name": "Mode",            "value": mode_name,                                         "inline": True},
            {"name": "Portfolio value", "value": f"${portfolio:,.2f}",                              "inline": True},
            {"name": "Equity",          "value": f"${equity:,.2f}",                                 "inline": True},
            {"name": "Cash",            "value": f"${cash:,.2f}",                                   "inline": True},
        ]

        if strategy.get("available"):
            if strategy.get("format") == "multi_stock":
                lines = []
                for sym, info in strategy["symbols"].items():
                    if info.get("avg_cost") is None or info.get("qty", 0) == 0:
                        continue
                    lines.append(
                        f"  {sym:<5} qty {info['qty']:>3}  avg ${info['avg_cost']:>7.2f}  "
                        f"stop ${info['stop_price']:>7.2f}  trail {'ON ' if info['trailing_active'] else 'OFF'}"
                    )
                if lines:
                    fields.append({
                        "name":  f"Stocks (strategy.py — {mode_name} mode)",
                        "value": "```\n" + "\n".join(lines) + "\n```",
                        "inline": False,
                    })
            elif strategy.get("avg_cost") is not None:
                fields.append({
                    "name": "TSLA Stock (strategy.py)",
                    "value": (
                        f"Qty: {strategy['qty']} | Avg: ${strategy['avg_cost']:.2f} | "
                        f"Stop: ${strategy['stop_price']:.2f} | "
                        f"Trail: {'ON' if strategy['trailing_active'] else 'OFF'}"
                    ),
                    "inline": False,
                })

        if held_stocks.get("available"):
            if held_stocks.get("count", 0) > 0:
                lines = []
                for p in held_stocks["positions"]:
                    qty_str = f"{p['qty']:.0f}" if p['qty'] == int(p['qty']) else f"{p['qty']:.4f}"
                    lines.append(
                        f"  {p['symbol']:<5} qty {qty_str:>6}  avg ${p['entry']:>7.2f}  "
                        f"now ${p['current']:>7.2f}  MV ${p['market_value']:>10,.2f}  "
                        f"P&L {p['pnl_pct']:+.1%} (${p['pnl_dollars']:+.2f})"
                    )
                fields.append({
                    "name":  f"Held Stocks (not tracked by bot — {len(lines)})",
                    "value": "```\n" + "\n".join(lines) + "\n```",
                    "inline": False,
                })
            else:
                fields.append({
                    "name":  "Held Stocks",
                    "value": "✅ All stocks tracked",
                    "inline": False,
                })

        if wheel["available"]:
            fields.append({
                "name": "Wheel — All Symbols (totals)",
                "value": (
                    f"Premium today: ${wheel['total_today']:.2f} | "
                    f"Total premium: ${wheel['total_premium']:.2f} | "
                    f"Cycles: {wheel['total_cycles']}"
                ),
                "inline": False,
            })
            if wheel.get("format") == "multi_stock":
                lines = []
                for sym, info in wheel.get("symbols", {}).items():
                    contract = info.get("current_contract") or "none"
                    lines.append(
                        f"  {sym:<5} stage {info['stage']}  ${info['total_premium']:>7.2f}  "
                        f"today ${info['premium_today']:>5.2f}  {contract}"
                    )
                if lines:
                    fields.append({
                        "name": "Wheel — Per Symbol",
                        "value": "```\n" + "\n".join(lines) + "\n```",
                        "inline": False,
                    })

        if long_opts.get("available") and long_opts.get("count", 0) > 0:
            lines = []
            for p in long_opts["positions"]:
                lines.append(
                    f"  {p['symbol']:<22} qty={p['qty']}  entry ${p['entry']:>5.2f}  "
                    f"now ${p['current']:>5.2f}  P&L {p['pnl_pct']:+.1%} (${p['pnl_dollars']:+.2f})"
                )
            fields.append({
                "name":  f"Long Options ({long_opts['count']} open)",
                "value": "```\n" + "\n".join(lines) + "\n```",
                "inline": False,
            })
            fields.append({
                "name":  "Long Options — total unrealized P&L",
                "value": f"${long_opts['total_pnl']:+.2f}",
                "inline": True,
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

        send_embed(
            summary_ch, title,
            color=Color.BLUE,
            fields=fields,
            footer=f"daily_summary.py · {mode_name}",
            actions_channel=actions_ch,
        )

        log_event(log_stream, "daily_summary.py", "daily_summary",
                  result="success",
                  details={
                      "date":            today,
                      "mode":            mode_name,
                      "portfolio_value": portfolio,
                      "equity":          equity,
                      "cash":            cash,
                      "strategy":        strategy,
                      "wheel":           wheel,
                      "long_options":    long_opts,
                      "held_stocks":     held_stocks,
                      "congress":        congress,
                  })

        if reset_counters:
            _reset_wheel_today_counters(cfg)

    except Exception as e:
        send_embed(
            errors_ch, f"daily_summary.py crashed ({mode_name})",
            color=Color.RED,
            description=f"`{type(e).__name__}: {str(e)[:500]}`",
            footer=f"daily_summary.py · {mode_name}",
            actions_channel=actions_ch,
        )
        log_event(log_stream, "daily_summary.py", "exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


# ── Head-to-head comparison ───────────────────────────────────────────────


def _snapshot(cfg: dict) -> dict:
    """One-line comparable snapshot for a mode."""
    account = _get_account(cfg)
    wheel   = _summarize_wheel(cfg)
    longs   = _summarize_long_options(cfg)
    return {
        "equity":         float(account.get("equity", account.get("portfolio_value", 0))),
        "cash":           float(account.get("cash", 0)),
        "portfolio":      float(account.get("portfolio_value", 0)),
        "premium_today":  wheel.get("total_today", 0) if wheel.get("available") else 0,
        "premium_total":  wheel.get("total_premium", 0) if wheel.get("available") else 0,
        "cycles":         wheel.get("total_cycles", 0) if wheel.get("available") else 0,
        "long_pnl":       longs.get("total_pnl", 0) if longs.get("available") else 0,
        "long_count":     longs.get("count", 0) if longs.get("available") else 0,
        "wheel_symbols":  cfg["wheel_symbols"],
    }


def _format_money(n: float) -> str:
    return f"${n:,.2f}"


def run_head_to_head() -> None:
    """Read both accounts and post a side-by-side comparison embed to BOTH
    summary channels so each side sees the race."""
    now          = datetime.now()
    today        = now.strftime("%Y-%m-%d")        # ISO — used in log_event details
    today_pretty = now.strftime("%m/%d/%Y")        # American MM/DD/YYYY — shown in Discord
    try:
        cons = _snapshot(config.MODES["conservative"])
        aggr = _snapshot(config.MODES["aggressive"])

        def _row(label, c, a, fmt=lambda v: str(v)):
            return f"  {label:<22} {fmt(c):>14}  {fmt(a):>14}"

        body_lines = [
            f"  {'Metric':<22} {'Conservative':>14}  {'Aggressive':>14}",
            f"  {'-'*22} {'-'*14}  {'-'*14}",
            _row("Equity",         cons['equity'],        aggr['equity'],        _format_money),
            _row("Cash",           cons['cash'],          aggr['cash'],          _format_money),
            _row("Portfolio val",  cons['portfolio'],     aggr['portfolio'],     _format_money),
            _row("Premium today",  cons['premium_today'], aggr['premium_today'], _format_money),
            _row("Premium total",  cons['premium_total'], aggr['premium_total'], _format_money),
            _row("Wheel cycles",   cons['cycles'],        aggr['cycles']),
            _row("Long opts P&L",  cons['long_pnl'],      aggr['long_pnl'],      _format_money),
            _row("Long opts open", cons['long_count'],    aggr['long_count']),
            _row("Wheel symbols",  len(cons['wheel_symbols']), len(aggr['wheel_symbols'])),
        ]

        # Equity diff highlights who's ahead
        equity_diff = aggr['equity'] - cons['equity']
        winner = "Aggressive" if equity_diff > 0 else ("Conservative" if equity_diff < 0 else "Tied")
        winner_line = (
            f"**Equity gap:** {_format_money(abs(equity_diff))} " +
            (f"({winner} ahead)" if equity_diff != 0 else "(tied)")
        )

        description = winner_line + "\n```\n" + "\n".join(body_lines) + "\n```"

        # Send same embed to both channels so each Discord side sees it
        for ch_name, ch_value in (
            ("daily-summary",     "summary"),
            ("aggressive-summary", "agg_summary"),
        ):
            send_embed(
                ch_value, f"Head-to-Head — {today_pretty}",
                color=Color.BLUE,
                description=description,
                footer="daily_summary.py · head-to-head",
                actions_channel="actions" if ch_value == "summary" else "agg_actions",
            )

        log_event("tsla", "daily_summary.py", "head_to_head",
                  result="success",
                  details={"date": today, "conservative": cons, "aggressive": aggr,
                           "equity_diff": equity_diff})
        log_event("tsla_aggressive", "daily_summary.py", "head_to_head",
                  result="success",
                  details={"date": today, "conservative": cons, "aggressive": aggr,
                           "equity_diff": equity_diff})

        print(json.dumps({"head_to_head": {"conservative": cons, "aggressive": aggr,
                                            "equity_diff": equity_diff}}, indent=2, default=str))
    except Exception as e:
        # Send the failure to BOTH error channels — head-to-head is cross-mode
        for err_ch, act_ch in (("errors", "actions"), ("agg_errors", "agg_actions")):
            send_embed(
                err_ch, "daily_summary.py — head-to-head crashed",
                color=Color.RED,
                description=f"`{type(e).__name__}: {str(e)[:500]}`",
                footer="daily_summary.py · head-to-head",
                actions_channel=act_ch,
            )
        log_event("tsla", "daily_summary.py", "head_to_head_exception",
                  result="failure", notes=f"{type(e).__name__}: {str(e)[:500]}")
        raise


# ── CLI ───────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    args = sys.argv[1:]
    reset_counters = "--reset-counters" in args
    args = [a for a in args if a != "--reset-counters"]
    if "--head-to-head" in args:
        run_head_to_head()
    else:
        selected_mode, _remaining = config.parse_mode_arg(args)
        run_daily_summary(selected_mode, reset_counters=reset_counters)
