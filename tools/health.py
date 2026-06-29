#!/usr/bin/env python3
"""/health — sanity check on the bot's plumbing.

Verifies for both paper accounts:
  - Alpaca creds authenticate (calls /v2/account)
  - Wheel state file exists, parses, and was checked recently
  - Strategy state file exists and parses
  - No stale open orders (open > 24 hours)

Read-only. No side effects.

Usage:
    python tools/health.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config
import alpaca_data as ad


GREEN = "✓"
RED = "✗"
YELLOW = "!"


def _check_creds_present(mode: str) -> tuple[str, str]:
    cfg = config.get_mode(mode)
    key = os.getenv(cfg["alpaca_key_env"], "")
    secret = os.getenv(cfg["alpaca_secret_env"], "")
    if not key or not secret:
        return RED, f"creds missing ({cfg['alpaca_key_env']} / {cfg['alpaca_secret_env']})"
    return GREEN, f"creds present (key {key[:6]}…{key[-4:]})"


def _check_account_auth(mode: str) -> tuple[str, str]:
    try:
        account = ad.get_account(mode=mode)
        equity = float(account.get("equity", 0))
        cash = float(account.get("cash", 0))
        return GREEN, f"auth ok — equity ${equity:,.2f}, cash ${cash:,.2f}"
    except Exception as e:
        return RED, f"auth FAILED: {type(e).__name__}: {str(e)[:120]}"


def _check_wheel_state(mode: str) -> tuple[str, str]:
    cfg = config.get_mode(mode)
    path = ROOT / cfg["wheel_state_file"]
    if not path.exists():
        return YELLOW, f"{cfg['wheel_state_file']} missing (will be created on first wheel run)"
    try:
        with open(path) as f:
            state = json.load(f)
    except Exception as e:
        return RED, f"{cfg['wheel_state_file']} unreadable: {type(e).__name__}"

    last_checked = state.get("_meta", {}).get("last_checked")
    n_symbols = sum(1 for k, v in state.items() if not k.startswith("_") and isinstance(v, dict))
    if not last_checked:
        return YELLOW, f"{n_symbols} symbol(s); never checked"
    try:
        ts = datetime.fromisoformat(last_checked.rstrip("Z")).replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - ts
    except Exception:
        return YELLOW, f"{n_symbols} symbol(s); last_checked unparseable: {last_checked!r}"

    age_str = _human_age(age)
    # Wheel runs every 10 min during market hours. Outside market hours, age can
    # legitimately stretch overnight / over weekends — only flag if older than ~3 days.
    if age > timedelta(days=3):
        return YELLOW, f"{n_symbols} symbol(s); last checked {age_str} ago (stale?)"
    return GREEN, f"{n_symbols} symbol(s); last checked {age_str} ago"


def _check_strategy_state(mode: str) -> tuple[str, str]:
    cfg = config.get_mode(mode)
    path = ROOT / cfg["strategy_state_file"]
    if not path.exists():
        return YELLOW, f"{cfg['strategy_state_file']} missing (no TSLA strategy state for this mode yet)"
    try:
        with open(path) as f:
            state = json.load(f)
    except Exception as e:
        return RED, f"{cfg['strategy_state_file']} unreadable: {type(e).__name__}"
    qty = state.get("position_qty", 0)
    avg = state.get("avg_cost") or 0
    return GREEN, f"position_qty={qty}, avg_cost=${avg:.2f}" if avg else f"position_qty={qty}"


def _check_stale_orders(mode: str) -> tuple[str, str]:
    try:
        orders = ad.get_orders(status="open", limit=100, mode=mode)
    except Exception as e:
        return RED, f"orders fetch failed: {type(e).__name__}: {str(e)[:80]}"
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    stale = []
    for o in orders:
        submitted = o.get("submitted_at") or o.get("created_at")
        if not submitted:
            continue
        try:
            ts = datetime.fromisoformat(submitted.replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts < cutoff:
            stale.append(f"{o.get('symbol', '?')} {o.get('side', '?')} {o.get('id', '')[:8]}")
    if not stale:
        return GREEN, f"{len(orders)} open order(s); none stale"
    return YELLOW, f"{len(orders)} open, {len(stale)} stale: {', '.join(stale[:3])}"


def _human_age(delta: timedelta) -> str:
    secs = int(delta.total_seconds())
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m"
    if secs < 86400:
        return f"{secs // 3600}h"
    return f"{secs // 86400}d"


def render() -> str:
    out = [f"═══ HEALTH CHECK — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ".ljust(80, "═")]

    overall_ok = True
    for mode in ("manual", "live"):
        out.append("")
        out.append(f"  [{mode}]")
        for label, fn in (
            ("Credentials  ", _check_creds_present),
            ("Account auth ", _check_account_auth),
            ("Wheel state  ", _check_wheel_state),
            ("Strategy st. ", _check_strategy_state),
            ("Open orders  ", _check_stale_orders),
        ):
            mark, detail = fn(mode)
            out.append(f"    {mark} {label}  {detail}")
            if mark == RED:
                overall_ok = False

    out.append("")
    out.append("  → " + ("All systems OK." if overall_ok else "Issues detected — see above."))
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    print(render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
