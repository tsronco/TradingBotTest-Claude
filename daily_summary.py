#!/usr/bin/env python3
"""
Daily Summary — combined end-of-day report per account.

  python daily_summary.py --mode manual
      → posts a daily summary embed to #manual-summary covering the
        manual account: strategy_state_manual.json + wheel_state_manual.json
        + long-options positions.

  python daily_summary.py --mode live
      → posts a daily summary embed to #live-summary covering the REAL-MONEY
        live account: strategy_state_live.json + wheel_state_live.json +
        long-options positions.

The GitHub Actions workflow runs both sequentially (manual → live), so each
fire produces two Discord embeds.

(History: the conservative/aggressive head-to-head and the sm500/sm1000/sm2000
summaries were retired 2026-06-29 with those accounts.)
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv

import config
from notifications import send_embed, log_event, Color

load_dotenv()

ROOT = Path(__file__).resolve().parent


def _humanize_occ(occ: str | None) -> str:
    """Convert OCC option symbol (e.g. SNAP260515P00007500) to human form
    (e.g. SNAP 05/15/26 $7.50P). Passes the input through unchanged if it
    doesn't parse as a valid OCC symbol — keeps the daily summary robust
    against any unexpected contract format Alpaca might return.
    """
    if not occ:
        return "none"
    for i, c in enumerate(occ):
        if c.isdigit():
            ticker, rest = occ[:i], occ[i:]
            break
    else:
        return occ
    if not ticker or len(rest) != 15:
        return occ
    try:
        yy, mm, dd = rest[0:2], rest[2:4], rest[4:6]
        int(yy); int(mm); int(dd)  # validates digits
        side = rest[6]
        if side not in ("C", "P"):
            return occ
        strike = int(rest[7:15]) / 1000.0
    except (ValueError, IndexError):
        return occ
    return f"{ticker} {mm}/{dd}/{yy} ${strike:.2f}{side}"


# ── Alpaca helpers ──


def _headers_for(cfg: dict) -> dict:
    return {
        "APCA-API-KEY-ID":     os.getenv(cfg["alpaca_key_env"]),
        "APCA-API-SECRET-KEY": os.getenv(cfg["alpaca_secret_env"]),
        "accept":              "application/json",
    }


def _base_url_for(cfg: dict) -> str:
    # Validate scheme — a missing or malformed (e.g. literal "-" placeholder)
    # GitHub Actions secret would otherwise produce URLs like "-/account"
    # that requests rejects with MissingSchema. Fall back to the paper default
    # if the env value isn't a proper http(s) URL.
    raw = (os.getenv(cfg["alpaca_url_env"]) or "").strip()
    if raw.startswith(("http://", "https://")):
        return raw
    return "https://paper-api.alpaca.markets/v2"


def _get_account(cfg: dict) -> dict:
    resp = requests.get(f"{_base_url_for(cfg)}/account", headers=_headers_for(cfg), timeout=10)
    resp.raise_for_status()
    return resp.json()


def _get_positions(cfg: dict) -> list[dict]:
    resp = requests.get(f"{_base_url_for(cfg)}/positions", headers=_headers_for(cfg), timeout=10)
    resp.raise_for_status()
    return resp.json()


def _funding_today(cfg: dict, today: str) -> tuple[float, float]:
    """Sum today's real-money cash deposits/withdrawals (live only).

    Returns (deposits, withdrawals) as positive dollar amounts. Fail-soft —
    returns (0.0, 0.0) on any error so a funding-fetch hiccup never breaks the
    summary embed. `today` is the "%Y-%m-%d" date string already computed by
    run_daily_summary.
    """
    try:
        resp = requests.get(
            f"{_base_url_for(cfg)}/account/activities",
            headers=_headers_for(cfg),
            params={"activity_types": "CSD,CSW", "page_size": 100, "direction": "desc"},
            timeout=10,
        )
        resp.raise_for_status()
        deposits = withdrawals = 0.0
        for a in resp.json():
            if a.get("date") != today:
                continue
            try:
                amt = abs(float(a.get("net_amount", 0) or 0))
            except (TypeError, ValueError):
                continue
            if a.get("activity_type") == "CSD":
                deposits += amt
            elif a.get("activity_type") == "CSW":
                withdrawals += amt
        return deposits, withdrawals
    except Exception:
        return 0.0, 0.0


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
            "spreads": {},
            "total_premium": state.get("total_premium_collected", 0),
            "total_today":   state.get("total_premium_today", 0),
            "total_cycles":  state.get("cycle_count", 0),
        }

    # Multi-stock format
    per_symbol = {}
    spreads    = {}
    total_premium = 0.0
    total_today   = 0.0
    total_cycles  = 0
    for sym, sym_state in state.items():
        if sym.startswith("_") or not isinstance(sym_state, dict):
            continue
        if sym_state.get("stage") == "spread_active":
            spreads[sym] = {
                "spread_type":  sym_state.get("spread_type"),
                "short_occ":    (sym_state.get("short_leg") or {}).get("occ"),
                "long_occ":     (sym_state.get("long_leg")  or {}).get("occ"),
                "short_strike": (sym_state.get("short_leg") or {}).get("strike"),
                "long_strike":  (sym_state.get("long_leg")  or {}).get("strike"),
                "short_qty":    (sym_state.get("short_leg") or {}).get("qty"),
                "net_credit":   sym_state.get("net_credit"),
                "max_loss":     sym_state.get("max_loss"),
                "width":        sym_state.get("width"),
                "expiration":   sym_state.get("expiration"),
                "opened_at":    sym_state.get("opened_at"),
            }
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
        "spreads": spreads,
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
    total_held = 0   # ALL us_equity positions, regardless of tracked status
    for p in positions:
        if p.get("asset_class") != "us_equity":
            continue
        symbol = p.get("symbol")
        try:
            qty     = float(p.get("qty", 0))
            entry   = float(p.get("avg_entry_price", 0))
            current = float(p.get("current_price", 0))
            mv      = float(p.get("market_value", 0))
            pnl_d   = float(p.get("unrealized_pl", 0))
            pnl_pct = float(p.get("unrealized_plpc", 0))
        except (TypeError, ValueError):
            continue
        if not symbol or qty == 0:
            continue
        total_held += 1
        if symbol in tracked_symbols:
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
        "available":  True,
        "count":      len(held),
        "total_held": total_held,
        "positions":  held,
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


def _summarize_long_options(cfg: dict, exclude_occs: set | None = None) -> dict:
    """Pull all LONG option positions (qty > 0) for the given mode's account.

    `exclude_occs` is the set of OCC symbols already claimed by wheel spreads
    (the long hedge legs). They get filtered out so the spread doesn't
    double-count: the long leg shows as part of the spread row in the
    'Open Spreads' section, not as a standalone long-options bet.
    """
    exclude_occs = exclude_occs or set()
    try:
        positions = _get_positions(cfg)
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}

    longs = []
    total_pnl = 0.0
    for p in positions:
        if p.get("asset_class") != "us_option":
            continue
        if p.get("symbol") in exclude_occs:
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


def _fetch_spread_pnl_for_summary(spread: dict, quote_fn=None) -> dict:
    """Compute live P&L for one spread from Alpaca option quotes.

    Args:
        spread: dict shape from _summarize_wheel's `spreads` block.
        quote_fn: callable(occ) -> {"bid": float, "ask": float} or None.
                  Defaults to wheel_strategy.get_option_quote when None.

    Returns:
        dict with keys:
            current_value:  cost-to-close per share (None if quote missing)
            profit_pct:     0.0–1.0 fraction of credit captured (None if quote missing)
            pnl_dollars:    dollars captured = (net_credit - current_value) * 100 (None if quote missing)
    """
    if quote_fn is None:
        import wheel_strategy
        quote_fn = wheel_strategy.get_option_quote

    short_q = quote_fn(spread["short_occ"])
    long_q  = quote_fn(spread["long_occ"])
    if not short_q or not long_q:
        return {"current_value": None, "profit_pct": None, "pnl_dollars": None}

    short_mid = (short_q["bid"] + short_q["ask"]) / 2
    long_mid  = (long_q["bid"]  + long_q["ask"])  / 2
    current_value = short_mid - long_mid
    net_credit = float(spread["net_credit"])
    profit_pct = (net_credit - current_value) / net_credit if net_credit > 0 else 0.0
    pnl_dollars = (net_credit - current_value) * 100 * int(spread.get("short_qty", 1))

    return {
        "current_value": round(current_value, 4),
        "profit_pct": round(profit_pct, 4),
        "pnl_dollars": round(pnl_dollars, 2),
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
        # Collect OCCs of long hedge legs claimed by wheel spreads so they're
        # excluded from the long-options listing (they belong to the spread).
        _spread_legs = {
            sp["long_occ"]
            for sp in (wheel.get("spreads") or {}).values()
            if sp.get("long_occ")
        }
        long_opts  = _summarize_long_options(cfg, exclude_occs=_spread_legs)
        held_stocks = _summarize_held_stocks(cfg, _tracked_stock_symbols(strategy, wheel))
        # Congress-copy was conservative-only and retired with that account
        # (2026-06-29). Kept as an always-unavailable dict so the embed
        # section below simply doesn't render.
        congress   = {"available": False}

        cash      = float(account["cash"])
        portfolio = float(account["portfolio_value"])
        equity    = float(account.get("equity", portfolio))

        title = f"Daily Trading Summary ({mode_name}) — {today_pretty}"

        fields = [
            {"name": "Equity", "value": f"${equity:,.2f}",   "inline": True},
            {"name": "Cash",   "value": f"${cash:,.2f}",     "inline": True},
        ]

        # Funding Today (live only — real-money deposits/withdrawals). Paper
        # accounts don't move real cash, so this is gated to live mode.
        if mode_name == "live":
            _deposits, _withdrawals = _funding_today(cfg, today)
            if _deposits or _withdrawals:
                _parts = []
                if _deposits:
                    _parts.append(f"Deposits +${_deposits:,.2f}")
                if _withdrawals:
                    _parts.append(f"Withdrawals −${_withdrawals:,.2f}")
                fields.append({
                    "name": "💵 Funding Today",
                    "value": " · ".join(_parts),
                    "inline": False,
                })

        if strategy.get("available"):
            if strategy.get("format") == "multi_stock":
                rows = []
                for sym, info in strategy["symbols"].items():
                    if info.get("avg_cost") is None or info.get("qty", 0) == 0:
                        continue
                    rows.append((sym, info))
                if rows:
                    lines = [
                        f"{'Sym':<5}  {'Qty':>4}  {'Avg':>9}  {'Stop':>9}  Trail",
                        f"{'-'*5}  {'-'*4}  {'-'*9}  {'-'*9}  {'-'*5}",
                    ]
                    for sym, info in rows:
                        avg_str  = f"${info['avg_cost']:,.2f}"
                        stop_str = f"${info['stop_price']:,.2f}"
                        lines.append(
                            f"{sym:<5}  {info['qty']:>4}  {avg_str:>9}  {stop_str:>9}  "
                            f"{'ON' if info['trailing_active'] else 'OFF'}"
                        )
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
            untracked  = held_stocks.get("count", 0)
            total_held = held_stocks.get("total_held", 0)
            if untracked > 0:
                lines = [
                    f"{'Sym':<5}  {'Qty':>6}  {'Avg':>9}  {'Now':>9}",
                    f"{'-'*5}  {'-'*6}  {'-'*9}  {'-'*9}",
                ]
                for p in held_stocks["positions"]:
                    qty_str = f"{p['qty']:.0f}" if p['qty'] == int(p['qty']) else f"{p['qty']:.4f}"
                    avg_str = f"${p['entry']:,.2f}"
                    now_str = f"${p['current']:,.2f}"
                    mv_str  = f"${p['market_value']:,.2f}"
                    pnl_d   = f"${p['pnl_dollars']:+,.2f}"
                    lines.append(
                        f"{p['symbol']:<5}  {qty_str:>6}  {avg_str:>9}  {now_str:>9}"
                    )
                    lines.append(
                        f"       ↳ MV {mv_str}   P&L {p['pnl_pct']:+.1%} ({pnl_d})"
                    )
                fields.append({
                    "name":  f"Held Stocks (not tracked by bot — {untracked})",
                    "value": "```\n" + "\n".join(lines) + "\n```",
                    "inline": False,
                })
            elif total_held == 0:
                fields.append({
                    "name":  "Held Stocks",
                    "value": "Currently holding 0 stocks",
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
                    f"Total premium: ${wheel['total_premium']:.2f}\n"
                    f"Cycles: {wheel['total_cycles']}"
                ),
                "inline": False,
            })
            if wheel.get("format") == "multi_stock":
                rows = list(wheel.get("symbols", {}).items())
                if rows:
                    lines = [
                        f"{'Sym':<5}  {'Stage':<5}  {'Total Prem':>10}  {'Today':>8}",
                        f"{'-'*5}  {'-'*5}  {'-'*10}  {'-'*8}",
                    ]
                    for sym, info in rows:
                        total_str = f"${info['total_premium']:,.2f}"
                        today_str = f"${info['premium_today']:,.2f}"
                        contract  = _humanize_occ(info.get("current_contract"))
                        lines.append(
                            f"{sym:<5}  {info['stage']:<5}  {total_str:>10}  {today_str:>8}"
                        )
                        lines.append(f"       ↳ {contract}")
                    fields.append({
                        "name": "Wheel — Per Symbol",
                        "value": "```\n" + "\n".join(lines) + "\n```",
                        "inline": False,
                    })

        if wheel.get("available") and wheel.get("spreads"):
            from datetime import date as _date
            spread_rows = []
            for sym, sp in wheel["spreads"].items():
                pnl = _fetch_spread_pnl_for_summary(sp)
                try:
                    expiry = _date.fromisoformat(sp["expiration"])
                    dte = (expiry - _date.today()).days
                except (ValueError, TypeError):
                    dte = "?"
                if pnl["profit_pct"] is None:
                    profit_str = "—"
                    pnl_str = "—"
                else:
                    profit_str = f"{pnl['profit_pct']*100:+.0f}%"
                    pnl_str = f"${pnl['pnl_dollars']:+,.2f}"
                spread_rows.append({
                    "sym":     sym,
                    "type":    (sp["spread_type"] or "").replace("_", " "),
                    "strikes": f"${sp['short_strike']:.2f}/${sp['long_strike']:.2f}",
                    "credit":  f"${sp['net_credit']:.2f}",
                    "profit":  profit_str,
                    "pnl":     pnl_str,
                    "dte":     dte,
                })
            if spread_rows:
                lines = [
                    f"{'Sym':<5}  {'Type':<11}  {'Strikes':<13}  {'Credit':>7}  {'P&L%':>6}  {'P&L $':>9}  {'DTE':>4}",
                    f"{'-'*5}  {'-'*11}  {'-'*13}  {'-'*7}  {'-'*6}  {'-'*9}  {'-'*4}",
                ]
                for r in spread_rows:
                    lines.append(
                        f"{r['sym']:<5}  {r['type']:<11}  {r['strikes']:<13}  "
                        f"{r['credit']:>7}  {r['profit']:>6}  {r['pnl']:>9}  {str(r['dte']):>4}"
                    )
                fields.append({
                    "name":  f"Wheel — Open Spreads ({len(spread_rows)})",
                    "value": "```\n" + "\n".join(lines) + "\n```",
                    "inline": False,
                })

        if long_opts.get("available") and long_opts.get("count", 0) > 0:
            lines = []
            for p in long_opts["positions"]:
                contract  = _humanize_occ(p['symbol'])
                entry_str = f"${p['entry']:,.2f}"
                now_str   = f"${p['current']:,.2f}"
                pnl_d     = f"${p['pnl_dollars']:+,.2f}"
                lines.append(f"{contract}  ×{p['qty']}")
                lines.append(
                    f"  ↳ entry {entry_str}  now {now_str}  "
                    f"P&L {p['pnl_pct']:+.1%} ({pnl_d})"
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



# ── CLI ───────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    args = sys.argv[1:]
    reset_counters = "--reset-counters" in args
    args = [a for a in args if a != "--reset-counters"]
    selected_mode, _remaining = config.parse_mode_arg(args)
    run_daily_summary(selected_mode, reset_counters=reset_counters)
