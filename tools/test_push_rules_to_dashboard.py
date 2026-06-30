import os
from unittest.mock import MagicMock, patch
import pytest


def test_build_payload_manual_shape_and_flags():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('manual')
    assert payload['mode'] == 'manual'
    # Manual mode mirrors the conservative wheel params it inherited.
    assert payload['wheel']['otm_pct'] == 0.10
    assert payload['wheel']['close_at_profit_pct'] == 0.50
    assert payload['wheel']['dte_min'] == 14
    assert payload['wheel']['dte_max'] == 28
    # Manual auto-discovers; wheel_symbols may be empty list
    assert isinstance(payload['wheel']['symbols'], list)
    assert payload['strategy']['underlying'] == 'TSLA'
    assert payload['strategy']['initial_qty'] == 10
    assert payload['strategy']['stop_loss_pct'] == 0.10
    assert len(payload['strategy']['ladders']) == 3
    assert payload['strategy']['ladders'][0] == {'trigger_pct': 0.15, 'qty': 8}
    assert 'pushed_at' in payload
    # Manual flags surfaced
    assert 'flags' in payload
    assert payload['flags'].get('auto_discover_symbols') is True
    assert payload['flags'].get('wheel_skip_new_puts') is True
    # Congress was conservative-only and retired with that account
    assert 'congress' not in payload


def test_build_payload_live_shape_and_flags():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('live')
    assert payload['mode'] == 'live'
    assert payload['wheel']['otm_pct'] == 0.10
    assert isinstance(payload['wheel']['symbols'], list)
    # Live behaves like manual: auto-discover + skip-new-puts
    assert payload['flags'].get('auto_discover_symbols') is True
    assert payload['flags'].get('wheel_skip_new_puts') is True
    assert 'congress' not in payload
    assert 'pushed_at' in payload


def test_build_payload_unknown_mode_raises():
    from tools.push_rules_to_dashboard import build_payload
    with pytest.raises(ValueError):
        build_payload('nonsense')


@pytest.mark.parametrize('mode', ['conservative', 'aggressive', 'sm500',
                                  'sm1000', 'sm2000'])
def test_build_payload_retired_modes_raise(mode):
    """The five retired accounts are gone from config.MODES, so build_payload
    must reject them rather than silently produce a payload."""
    from tools.push_rules_to_dashboard import build_payload
    with pytest.raises(ValueError):
        build_payload(mode)


@pytest.mark.parametrize('mode', ['manual', 'live'])
def test_argparse_accepts_supported_modes(mode):
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', required=True, choices=['manual', 'live'])
    args = parser.parse_args(['--mode', mode])
    assert args.mode == mode


@pytest.mark.parametrize('mode', ['bogus', 'conservative', 'aggressive', 'sm500'])
def test_argparse_rejects_unsupported_mode(mode):
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', required=True, choices=['manual', 'live'])
    with pytest.raises(SystemExit):
        parser.parse_args(['--mode', mode])


@patch('tools.push_rules_to_dashboard.requests.post')
@pytest.mark.parametrize('mode', ['manual', 'live'])
def test_push_targets_correct_rules_key(mock_post, mode):
    mock_post.return_value = MagicMock(status_code=200, text='ok')
    from tools.push_rules_to_dashboard import push
    os.environ['BOT_PUSH_TOKEN'] = 'tok-1'
    os.environ['DASHBOARD_URL'] = 'https://example.com'
    rc = push(mode)
    assert rc == 200
    _, kwargs = mock_post.call_args
    assert kwargs['json']['key'] == f'bot:rules:{mode}'
    assert kwargs['json']['payload']['mode'] == mode


@patch('tools.push_rules_to_dashboard.requests.post')
def test_push_calls_dashboard_with_bearer(mock_post):
    mock_post.return_value = MagicMock(status_code=200, text='ok')
    from tools.push_rules_to_dashboard import push
    os.environ['BOT_PUSH_TOKEN'] = 'tok-1'
    os.environ['DASHBOARD_URL'] = 'https://example.com'
    rc = push('manual')
    assert rc == 200
    args, kwargs = mock_post.call_args
    assert args[0] == 'https://example.com/api/bot-state'
    assert kwargs['headers']['Authorization'] == 'Bearer tok-1'
    body = kwargs['json']
    assert body['key'] == 'bot:rules:manual'
    assert body['payload']['mode'] == 'manual'


@patch('tools.push_rules_to_dashboard.requests.post')
def test_push_returns_minus_1_when_env_missing(mock_post):
    from tools.push_rules_to_dashboard import push
    # Save and clear
    saved_token = os.environ.pop('BOT_PUSH_TOKEN', None)
    saved_url = os.environ.pop('DASHBOARD_URL', None)
    try:
        rc = push('manual')
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
    rc = push('manual')
    assert rc == -1


def test_build_payload_ladders_renamed_drop_to_trigger_pct():
    """LADDERS in strategy.py uses 'drop'; wire format renames to 'trigger_pct'.
    Ensures the renamed field is what reaches the dashboard."""
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('manual')
    for ladder in payload['strategy']['ladders']:
        assert 'trigger_pct' in ladder
        assert 'qty' in ladder
        assert 'drop' not in ladder  # the original key name must not leak
        assert 'label' not in ladder  # cosmetic field shouldn't ship
