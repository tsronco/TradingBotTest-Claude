"""Tests for Alpaca API retry logic.

Mirrors tests/test_discord_retry.py — same retry contract applied to Alpaca
endpoints in wheel_strategy._alpaca_request, strategy._alpaca_request, and
alpaca_data._request_with_retry. The 2026-05-13 MARA ConnectionReset incident
motivated this fix: transient TCP resets and Alpaca 5xx blips should not
crash a per-symbol cycle.

The retry pin:
  - 3 attempts max
  - 2s + 8s backoff between attempts
  - Retry on 429/5xx + ConnectionError + Timeout
  - 4xx is NOT retried (returned as-is to caller)
  - On exhausted ConnectionError, the underlying exception propagates so the
    existing per-symbol exception handler can isolate the failure.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import requests

import wheel_strategy as ws
import strategy
import alpaca_data


@pytest.fixture
def stub_sleep(monkeypatch):
    """Replace time.sleep in every retry-using module with a counter.
    Returns the calls list so tests can assert backoff happened."""
    calls: list[float] = []
    sleep_stub = lambda s: calls.append(s)
    monkeypatch.setattr(ws.time, "sleep", sleep_stub)
    monkeypatch.setattr(strategy.time, "sleep", sleep_stub)
    monkeypatch.setattr(alpaca_data.time, "sleep", sleep_stub)
    return calls


def _fake_resp(status_code: int):
    """A minimal requests.Response stand-in for our retry tests."""
    m = MagicMock(spec=requests.Response)
    m.status_code = status_code
    return m


# ── wheel_strategy._alpaca_request ──────────────────────────────────────────


def test_wheel_alpaca_request_succeeds_in_one_attempt(monkeypatch, stub_sleep):
    """Happy path: 200 on first try → no retry, no sleep."""
    calls = []
    def fake_request(method, url, **kw):
        calls.append((method, url))
        return _fake_resp(200)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("GET", "https://example.com/orders")

    assert resp.status_code == 200
    assert len(calls) == 1
    assert stub_sleep == []


def test_wheel_alpaca_request_retries_on_503_then_succeeds(monkeypatch, stub_sleep):
    """503 then 200 → success, exactly one backoff."""
    responses = [_fake_resp(503), _fake_resp(200)]
    def fake_request(method, url, **kw):
        return responses.pop(0)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("GET", "https://example.com/x")

    assert resp.status_code == 200
    assert responses == []  # both consumed
    assert stub_sleep == [ws._ALPACA_RETRY_BACKOFFS[0]]


def test_wheel_alpaca_request_returns_last_response_after_max_5xx(monkeypatch, stub_sleep):
    """3 consecutive 503s → returns the final 503 (caller decides what to do
    with it — usually raise_for_status())."""
    attempts = [0]
    def fake_request(method, url, **kw):
        attempts[0] += 1
        return _fake_resp(503)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("GET", "https://example.com/x")

    assert resp.status_code == 503
    assert attempts[0] == ws._ALPACA_MAX_ATTEMPTS
    assert stub_sleep == list(ws._ALPACA_RETRY_BACKOFFS[: ws._ALPACA_MAX_ATTEMPTS - 1])


@pytest.mark.parametrize("code", sorted(ws._ALPACA_RETRY_STATUS))
def test_wheel_alpaca_request_retries_each_retryable_code(monkeypatch, stub_sleep, code):
    """Every code in _ALPACA_RETRY_STATUS triggers retry."""
    attempts = [0]
    def fake_request(method, url, **kw):
        attempts[0] += 1
        return _fake_resp(code) if attempts[0] == 1 else _fake_resp(200)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("GET", "https://example.com/x")

    assert resp.status_code == 200
    assert attempts[0] == 2  # one retry happened


@pytest.mark.parametrize("code", [400, 401, 403, 404, 422])
def test_wheel_alpaca_request_does_not_retry_4xx(monkeypatch, stub_sleep, code):
    """4xx codes mean the request itself is wrong (or, for 403, that BP is
    exhausted) — retrying won't help. Return on first attempt.

    NOTE: 403 specifically is the wheel's BP-exhaustion short-circuit signal.
    Retrying it would just delay the inevitable short-circuit by ~10 seconds."""
    attempts = [0]
    def fake_request(method, url, **kw):
        attempts[0] += 1
        return _fake_resp(code)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("POST", "https://example.com/orders")

    assert resp.status_code == code
    assert attempts[0] == 1
    assert stub_sleep == []


def test_wheel_alpaca_request_retries_on_connection_error(monkeypatch, stub_sleep):
    """ConnectionError (the exact failure mode from MARA 2026-05-13 15:49)
    should retry. Once it recovers, return the successful response."""
    attempts = [0]
    def fake_request(method, url, **kw):
        attempts[0] += 1
        if attempts[0] < 3:
            raise requests.exceptions.ConnectionError("connection reset by peer")
        return _fake_resp(200)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("GET", "https://example.com/x")

    assert resp.status_code == 200
    assert attempts[0] == 3
    assert stub_sleep == list(ws._ALPACA_RETRY_BACKOFFS[:2])


def test_wheel_alpaca_request_raises_after_max_connection_errors(monkeypatch, stub_sleep):
    """If all attempts hit ConnectionError, the underlying exception propagates
    so the existing per-symbol handler can log + isolate the failure."""
    attempts = [0]
    def fake_request(method, url, **kw):
        attempts[0] += 1
        raise requests.exceptions.ConnectionError("connection reset by peer")
    monkeypatch.setattr(ws.requests, "request", fake_request)

    with pytest.raises(requests.exceptions.ConnectionError):
        ws._alpaca_request("GET", "https://example.com/x")

    assert attempts[0] == ws._ALPACA_MAX_ATTEMPTS


def test_wheel_alpaca_request_retries_on_timeout(monkeypatch, stub_sleep):
    """Timeout is also transient — retry."""
    attempts = [0]
    def fake_request(method, url, **kw):
        attempts[0] += 1
        if attempts[0] == 1:
            raise requests.exceptions.Timeout("read timeout")
        return _fake_resp(200)
    monkeypatch.setattr(ws.requests, "request", fake_request)

    resp = ws._alpaca_request("GET", "https://example.com/x")
    assert resp.status_code == 200
    assert attempts[0] == 2


# ── strategy._alpaca_request — same contract, sanity check ─────────────────


def test_strategy_alpaca_request_succeeds_in_one_attempt(monkeypatch, stub_sleep):
    """strategy.py has its own copy of the retry helper. Verify it works."""
    monkeypatch.setattr(strategy.requests, "request",
                        lambda method, url, **kw: _fake_resp(200))
    resp = strategy._alpaca_request("GET", "https://example.com/x")
    assert resp.status_code == 200
    assert stub_sleep == []


def test_strategy_alpaca_request_retries_on_503(monkeypatch, stub_sleep):
    responses = [_fake_resp(503), _fake_resp(200)]
    monkeypatch.setattr(strategy.requests, "request",
                        lambda method, url, **kw: responses.pop(0))
    resp = strategy._alpaca_request("GET", "https://example.com/x")
    assert resp.status_code == 200
    assert stub_sleep == [strategy._ALPACA_RETRY_BACKOFFS[0]]


def test_strategy_alpaca_request_raises_after_max_connection_errors(monkeypatch, stub_sleep):
    def fake_request(method, url, **kw):
        raise requests.exceptions.ConnectionError("nope")
    monkeypatch.setattr(strategy.requests, "request", fake_request)
    with pytest.raises(requests.exceptions.ConnectionError):
        strategy._alpaca_request("GET", "https://example.com/x")


# ── alpaca_data._request_with_retry — same contract ────────────────────────


def test_alpaca_data_request_with_retry_succeeds(monkeypatch, stub_sleep):
    monkeypatch.setattr(alpaca_data.requests, "request",
                        lambda method, url, **kw: _fake_resp(200))
    resp = alpaca_data._request_with_retry("GET", "https://example.com/x")
    assert resp.status_code == 200
    assert stub_sleep == []


def test_alpaca_data_request_with_retry_retries_5xx(monkeypatch, stub_sleep):
    responses = [_fake_resp(502), _fake_resp(503), _fake_resp(200)]
    monkeypatch.setattr(alpaca_data.requests, "request",
                        lambda method, url, **kw: responses.pop(0))
    resp = alpaca_data._request_with_retry("GET", "https://example.com/x")
    assert resp.status_code == 200
    assert stub_sleep == list(alpaca_data._RETRY_BACKOFFS[:2])


def test_alpaca_data_get_position_404_returns_None_without_retry(monkeypatch, stub_sleep):
    """alpaca_data.get_position has special 404 handling — must NOT trigger
    retry (404 isn't in retry list) AND must return None instead of raising."""
    calls = [0]
    def fake_request(method, url, **kw):
        calls[0] += 1
        return _fake_resp(404)
    monkeypatch.setattr(alpaca_data.requests, "request", fake_request)

    result = alpaca_data.get_position("DOES_NOT_EXIST", mode="manual")

    assert result is None
    assert calls[0] == 1  # no retry on 404
    assert stub_sleep == []


def test_alpaca_data_get_position_retries_on_503_then_404(monkeypatch, stub_sleep):
    """If Alpaca gives us a 503 then a 404, we retry past the 503 and still
    treat the 404 as 'not held'."""
    responses = [_fake_resp(503), _fake_resp(404)]
    monkeypatch.setattr(alpaca_data.requests, "request",
                        lambda method, url, **kw: responses.pop(0))

    result = alpaca_data.get_position("BAC", mode="manual")

    assert result is None
    assert stub_sleep == [alpaca_data._RETRY_BACKOFFS[0]]
