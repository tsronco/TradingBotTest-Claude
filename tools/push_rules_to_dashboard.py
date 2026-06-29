"""Read config.MODES + strategy module and POST a BotRulesPayload to the
dashboard's /api/bot-state.

Used by tsla-monitor-manual.yml and tsla-monitor-live.yml after each bot run.
Idempotent (modulo `pushed_at`). Fail-soft: if the push fails, print to stderr
but exit 0 — the bot must not be blocked by dashboard plumbing.
"""
import argparse
import datetime as dt
import os
import sys
from typing import Any, Dict

import requests

# Add repo root so config / strategy imports work regardless of cwd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402
import strategy  # noqa: E402


def _utcnow_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + 'Z'


def build_payload(mode: str) -> Dict[str, Any]:
    if mode not in config.MODES:
        raise ValueError(f"unknown mode: {mode}")
    m = config.MODES[mode]

    wheel: Dict[str, Any] = {
        'symbols': list(m.get('wheel_symbols', [])),
        'otm_pct': float(m['put_strike_pct']),
        'dte_min': int(m['put_dte_min']),
        'dte_max': int(m['put_dte_max']),
        'close_at_profit_pct': float(m['early_close_pct']),
    }

    # strategy parameters are module-level constants; same across modes
    strat: Dict[str, Any] = {
        'underlying': 'TSLA',
        'initial_qty': int(strategy.INITIAL_QTY),
        'stop_loss_pct': float(strategy.STOP_PCT),
        'trail_activate_pct': float(strategy.TRAIL_TRIGGER_PCT),
        'trail_floor_pct': float(strategy.TRAIL_DISTANCE_PCT),
        'ladders': [
            {'trigger_pct': float(l['drop']), 'qty': int(l['qty'])}
            for l in strategy.LADDERS
        ],
    }

    # Optional manual flags: surface only if truthy
    flags: Dict[str, bool] = {}
    if m.get('auto_discover_symbols'):
        flags['auto_discover_symbols'] = True
    if m.get('wheel_skip_new_puts'):
        flags['wheel_skip_new_puts'] = True

    payload: Dict[str, Any] = {
        'mode': mode,
        'wheel': wheel,
        'strategy': strat,
        'pushed_at': _utcnow_iso(),
    }
    if flags:
        payload['flags'] = flags

    return payload


def push(mode: str) -> int:
    """Returns HTTP status code, or -1 if the request failed."""
    token = os.environ.get('BOT_PUSH_TOKEN')
    base = os.environ.get('DASHBOARD_URL')
    if not token or not base:
        print('[push_rules] BOT_PUSH_TOKEN or DASHBOARD_URL missing; skipping', file=sys.stderr)
        return -1

    try:
        payload = build_payload(mode)
        body = {'key': f'bot:rules:{mode}', 'payload': payload}
        r = requests.post(
            f"{base.rstrip('/')}/api/bot-state",
            json=body,
            headers={
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
            },
            timeout=10,
        )
        if r.status_code >= 300:
            print(f"[push_rules] dashboard returned {r.status_code}: {r.text}", file=sys.stderr)
        return r.status_code
    except Exception as exc:  # noqa: BLE001 — fail-soft: must not crash the bot
        print(f"[push_rules] error building/posting payload: {exc}", file=sys.stderr)
        return -1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--mode',
        required=True,
        choices=['manual', 'live'],
    )
    args = parser.parse_args()
    push(args.mode)


if __name__ == '__main__':
    main()
