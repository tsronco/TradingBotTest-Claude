"""Transient-upstream cycle skip for run_wheel.

Motivated by the 2026-06-29 aggressive incident: Alpaca returned a sustained
500 on `/v2/account` that outlasted `_alpaca_request`'s bounded retry, so the
cycle-gating `get_account()` raised HTTPError, the top-level handler pinged
`#aggressive-errors`, and the workflow went red — even though it was a pure
upstream blip (conservative, firing 2 min off, was fine).

The pin: a transient Alpaca 5xx/429 or network blip that escapes the retry
window skips the cycle quietly (heartbeat → actions firehose, NOT #errors,
no re-raise). A genuine bot bug (any non-transient exception) still pings
#errors and re-raises.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
import requests

import wheel_strategy as ws
import config


def _http_error(status_code: int) -> requests.exceptions.HTTPError:
    """An HTTPError carrying a response with the given status code, exactly as
    `resp.raise_for_status()` produces it."""
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    return requests.exceptions.HTTPError(f"{status_code} Server Error", response=resp)


# ── _is_transient_upstream classification ───────────────────────────────────


@pytest.mark.parametrize("code", sorted(ws._ALPACA_RETRY_STATUS))
def test_transient_classifies_retryable_http_codes(code):
    assert ws._is_transient_upstream(_http_error(code)) is True


@pytest.mark.parametrize("exc", [
    requests.exceptions.ConnectionError("reset by peer"),
    requests.exceptions.Timeout("read timeout"),
])
def test_transient_classifies_network_errors(exc):
    assert ws._is_transient_upstream(exc) is True


@pytest.mark.parametrize("code", [400, 401, 403, 404, 422])
def test_transient_rejects_4xx_http(code):
    """A 4xx is the request's fault, not a transient outage — not skippable."""
    assert ws._is_transient_upstream(_http_error(code)) is False


def test_transient_rejects_http_error_without_response():
    """A bare HTTPError with no attached response can't be confirmed transient."""
    assert ws._is_transient_upstream(requests.exceptions.HTTPError("boom")) is False


@pytest.mark.parametrize("exc", [ValueError("bad json"), KeyError("equity"),
                                 RuntimeError("logic bug")])
def test_transient_rejects_non_http_exceptions(exc):
    assert ws._is_transient_upstream(exc) is False


# ── run_wheel integration ───────────────────────────────────────────────────


def _setup_aggressive(monkeypatch, tmp_path):
    """Put run_wheel on the aggressive path with a writable state file and a
    captured send_embed. Returns the (channel, title) capture list."""
    ws.apply_mode("aggressive")
    state_file = tmp_path / "wheel_state_aggressive.json"
    state_file.write_text(json.dumps({"_meta": {}}))
    monkeypatch.setattr(ws, "STATE_FILE", str(state_file))
    monkeypatch.setattr(ws, "is_market_open", lambda: True)

    embeds: list[tuple] = []
    monkeypatch.setattr(ws, "send_embed",
                        lambda channel, title, *a, **kw: embeds.append((channel, title)))
    return embeds


def test_run_wheel_skips_on_transient_account_500(monkeypatch, tmp_path):
    """A sustained 500 on the cycle-gating get_account() → quiet skip:
    no raise, an actions-channel heartbeat, and NOTHING in #errors."""
    embeds = _setup_aggressive(monkeypatch, tmp_path)
    monkeypatch.setattr(ws, "get_account",
                        lambda: (_ for _ in ()).throw(_http_error(500)))

    ws.run_wheel()  # must NOT raise

    channels = [c for c, _ in embeds]
    assert ws.ERRORS_CH not in channels, "transient skip must not ping #errors"
    assert embeds == [(ws.ACTIONS_CH,
                       "wheel_strategy.py — cycle skipped (transient upstream)")]

    ws.apply_mode(config.DEFAULT_MODE)


def test_run_wheel_skips_on_connection_error(monkeypatch, tmp_path):
    """ConnectionError that exhausts retries is also a quiet skip."""
    embeds = _setup_aggressive(monkeypatch, tmp_path)
    monkeypatch.setattr(ws, "get_account",
                        lambda: (_ for _ in ()).throw(
                            requests.exceptions.ConnectionError("reset")))

    ws.run_wheel()  # must NOT raise

    assert ws.ERRORS_CH not in [c for c, _ in embeds]
    assert (ws.ACTIONS_CH,
            "wheel_strategy.py — cycle skipped (transient upstream)") in embeds

    ws.apply_mode(config.DEFAULT_MODE)


def test_run_wheel_still_raises_on_non_transient_error(monkeypatch, tmp_path):
    """A real bug (non-transient exception) keeps the old behaviour: ping
    #errors and re-raise so the workflow goes red and we notice."""
    embeds = _setup_aggressive(monkeypatch, tmp_path)
    monkeypatch.setattr(ws, "get_account",
                        lambda: (_ for _ in ()).throw(ValueError("logic bug")))

    with pytest.raises(ValueError):
        ws.run_wheel()

    assert ws.ERRORS_CH in [c for c, _ in embeds], "real bug must ping #errors"

    ws.apply_mode(config.DEFAULT_MODE)


def test_run_wheel_still_raises_on_404(monkeypatch, tmp_path):
    """A 404 is not a transient outage — still surfaces as an error."""
    embeds = _setup_aggressive(monkeypatch, tmp_path)
    monkeypatch.setattr(ws, "get_account",
                        lambda: (_ for _ in ()).throw(_http_error(404)))

    with pytest.raises(requests.exceptions.HTTPError):
        ws.run_wheel()

    assert ws.ERRORS_CH in [c for c, _ in embeds]

    ws.apply_mode(config.DEFAULT_MODE)
