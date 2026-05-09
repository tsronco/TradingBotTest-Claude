import os
from unittest.mock import MagicMock, patch
import pytest


def test_build_payload_conservative_shape():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('conservative')
    assert payload['mode'] == 'conservative'
    assert payload['wheel']['otm_pct'] == 0.10
    assert payload['wheel']['close_at_profit_pct'] == 0.50
    assert payload['wheel']['dte_min'] == 14
    assert payload['wheel']['dte_max'] == 28
    assert payload['strategy']['underlying'] == 'TSLA'
    assert payload['strategy']['initial_qty'] == 10
    assert payload['strategy']['stop_loss_pct'] == 0.10
    assert len(payload['strategy']['ladders']) == 3
    assert payload['strategy']['ladders'][0] == {'trigger_pct': 0.15, 'qty': 8}
    assert 'pushed_at' in payload
    # congress only on conservative
    assert 'congress' in payload
    assert len(payload['congress']['politicians']) >= 1
    assert all('slug' in p and 'name' in p for p in payload['congress']['politicians'])
    assert all('max_disclosure_usd' in t and 'alloc_usd' in t for t in payload['congress']['sizing_tiers'])
    # flags absent (no manual flags on conservative)
    assert 'flags' not in payload


def test_build_payload_aggressive_shape():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('aggressive')
    assert payload['mode'] == 'aggressive'
    assert payload['wheel']['otm_pct'] == 0.05
    assert payload['wheel']['close_at_profit_pct'] == 0.40
    assert payload['wheel']['dte_min'] == 7
    assert payload['wheel']['dte_max'] == 14
    # No congress on aggressive
    assert 'congress' not in payload
    assert 'flags' not in payload


def test_build_payload_manual_includes_flags():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('manual')
    assert payload['mode'] == 'manual'
    # Manual mode mirrors conservative wheel params
    assert payload['wheel']['otm_pct'] == 0.10
    # Manual auto-discovers; wheel_symbols may be empty list
    assert isinstance(payload['wheel']['symbols'], list)
    # Manual flags surfaced
    assert 'flags' in payload
    assert payload['flags'].get('auto_discover_symbols') is True
    assert payload['flags'].get('wheel_skip_new_puts') is True
    # No congress on manual
    assert 'congress' not in payload


def test_build_payload_unknown_mode_raises():
    from tools.push_rules_to_dashboard import build_payload
    with pytest.raises(ValueError):
        build_payload('nonsense')


@patch('tools.push_rules_to_dashboard.requests.post')
def test_push_calls_dashboard_with_bearer(mock_post):
    mock_post.return_value = MagicMock(status_code=200, text='ok')
    from tools.push_rules_to_dashboard import push
    os.environ['BOT_PUSH_TOKEN'] = 'tok-1'
    os.environ['DASHBOARD_URL'] = 'https://example.com'
    rc = push('conservative')
    assert rc == 200
    args, kwargs = mock_post.call_args
    assert args[0] == 'https://example.com/api/bot-state'
    assert kwargs['headers']['Authorization'] == 'Bearer tok-1'
    body = kwargs['json']
    assert body['key'] == 'bot:rules:conservative'
    assert body['payload']['mode'] == 'conservative'


@patch('tools.push_rules_to_dashboard.requests.post')
def test_push_returns_minus_1_when_env_missing(mock_post):
    from tools.push_rules_to_dashboard import push
    # Save and clear
    saved_token = os.environ.pop('BOT_PUSH_TOKEN', None)
    saved_url = os.environ.pop('DASHBOARD_URL', None)
    try:
        rc = push('conservative')
        assert rc == -1
        mock_post.assert_not_called()
    finally:
        if saved_token: os.environ['BOT_PUSH_TOKEN'] = saved_token
        if saved_url: os.environ['DASHBOARD_URL'] = saved_url


@patch('tools.push_rules_to_dashboard.requests.post')
def test_push_returns_minus_1_on_request_exception(mock_post):
    mock_post.side_effect = Exception('connection refused')
    from tools.push_rules_to_dashboard import push
    os.environ['BOT_PUSH_TOKEN'] = 'tok-1'
    os.environ['DASHBOARD_URL'] = 'https://example.com'
    rc = push('conservative')
    assert rc == -1


def test_build_payload_conservative_sizing_tier_infinity_sentinel():
    """The last SIZING_TIERS entry uses Decimal('Infinity'); JSON has no Infinity,
    so the wire format substitutes 1e18 as a sentinel for "unbounded"."""
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('conservative')
    last_tier = payload['congress']['sizing_tiers'][-1]
    assert last_tier['max_disclosure_usd'] == 1e18
    assert last_tier['alloc_usd'] == 5000.0  # the dollars-to-commit at the unbounded tier


def test_build_payload_ladders_renamed_drop_to_trigger_pct():
    """LADDERS in strategy.py uses 'drop'; wire format renames to 'trigger_pct'.
    Ensures the renamed field is what reaches the dashboard."""
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('conservative')
    for ladder in payload['strategy']['ladders']:
        assert 'trigger_pct' in ladder
        assert 'qty' in ladder
        assert 'drop' not in ladder  # the original key name must not leak
        assert 'label' not in ladder  # cosmetic field shouldn't ship
