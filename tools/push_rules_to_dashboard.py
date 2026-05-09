"""Read config.MODES + strategy module + congress-copy config (when conservative)
and POST a BotRulesPayload to the dashboard's /api/bot-state.

Used by tsla-monitor.yml, tsla-monitor-aggressive.yml, tsla-monitor-manual.yml
after each bot run. Idempotent (modulo `pushed_at`). Fail-soft: if the push
fails, print to stderr but exit 0 — the bot must not be blocked by dashboard
plumbing.
"""
import argparse
import datetime as dt
import math
import os
import sys
from typing import Any, Dict

import requests

# Add repo root so config / strategy imports work regardless of cwd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402
import strategy  # noqa: E402


def _utcnow_iso() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


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

    # Congress block — conservative only
    if mode == 'conservative':
        payload['congress'] = _build_congress_block()

    return payload


def _build_congress_block() -> Dict[str, Any]:
    """Import congress-copy/config.py and project SIZING_TIERS + POLITICIANS into wire shape."""
    # congress-copy/config.py is in a subdirectory with a hyphenated name and
    # collides with the top-level `config` module already imported above. Load
    # it by file path under a distinct name to avoid the sys.modules cache hit.
    import importlib.util
    cc_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'congress-copy', 'config.py',
    )
    spec = importlib.util.spec_from_file_location('congress_copy_config', cc_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load congress-copy config from {cc_path}")
    cc_config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cc_config)

    INF_FLOAT = 1e18  # sentinel for Decimal('Infinity') — JSON has no Infinity

    sizing_tiers = []
    for max_disc, alloc in cc_config.SIZING_TIERS:
        try:
            md = float(max_disc)
            if math.isinf(md):
                md = INF_FLOAT
        except (OverflowError, ValueError):
            md = INF_FLOAT
        sizing_tiers.append({
            'max_disclosure_usd': md,
            'alloc_usd': float(alloc),
        })

    politicians = [
        {'slug': p['slug'], 'name': p['name']}
        for p in cc_config.POLITICIANS
    ]

    return {'sizing_tiers': sizing_tiers, 'politicians': politicians}


def push(mode: str) -> int:
    """Returns HTTP status code, or -1 if the request failed."""
    token = os.environ.get('BOT_PUSH_TOKEN')
    base = os.environ.get('DASHBOARD_URL')
    if not token or not base:
        print('[push_rules] BOT_PUSH_TOKEN or DASHBOARD_URL missing; skipping', file=sys.stderr)
        return -1

    payload = build_payload(mode)
    body = {'key': f'bot:rules:{mode}', 'payload': payload}
    try:
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
    except Exception as exc:  # noqa: BLE001 — fail soft, must not crash the bot
        print(f"[push_rules] error posting to dashboard: {exc}", file=sys.stderr)
        return -1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', required=True, choices=['conservative', 'aggressive', 'manual'])
    args = parser.parse_args()
    push(args.mode)


if __name__ == '__main__':
    main()
