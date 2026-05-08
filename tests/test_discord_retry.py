"""Tests for the Discord webhook retry logic in notifications/discord.py.

The retry was added after a Discord 503 outage on 2026-05-08 swallowed an
entire daily-summary fire. These tests pin down the new contract:

  - Successful POSTs make exactly one urlopen call.
  - 5xx + 429 are retried up to _MAX_ATTEMPTS times.
  - 4xx is NOT retried (real request error, no point in repeating).
  - Connection errors are retried (transient by nature).
  - The function NEVER raises — it always swallows and logs to stderr.
"""
from __future__ import annotations

import io
import urllib.error

import pytest

from notifications import discord as dc


# ── Helpers ──────────────────────────────────────────────────────────────


class _FakeResp:
    """Minimal stand-in for the urlopen return value."""
    def __init__(self, status: int = 204, body: bytes = b""):
        self.status = status
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self) -> bytes:
        return self._body


def _make_http_error(code: int, body: bytes = b"discord 503") -> urllib.error.HTTPError:
    """HTTPError requires (url, code, msg, hdrs, fp)."""
    return urllib.error.HTTPError(
        url="https://discord.com/api/webhooks/x",
        code=code,
        msg="error",
        hdrs={},
        fp=io.BytesIO(body),
    )


@pytest.fixture
def webhook_url():
    return "https://discord.com/api/webhooks/123/abc"


@pytest.fixture
def stub_sleep(monkeypatch):
    """Replace time.sleep with a no-op + counter so tests aren't slow.
    Returns the calls list so tests can assert backoff happened."""
    calls: list[float] = []
    monkeypatch.setattr(dc.time, "sleep", lambda s: calls.append(s))
    return calls


# ── Success path ──────────────────────────────────────────────────────────


def test_post_succeeds_in_one_attempt(monkeypatch, webhook_url, stub_sleep):
    """Happy path: 204 on first try → no retry, no sleep."""
    attempts = []
    def fake_urlopen(req, timeout=10):
        attempts.append(req.full_url)
        return _FakeResp(status=204)
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    dc._post(webhook_url, {"content": "hi"})

    assert len(attempts) == 1
    assert stub_sleep == []  # never slept


# ── Retry on transient 5xx ────────────────────────────────────────────────


def test_post_retries_on_503_then_succeeds(monkeypatch, webhook_url, stub_sleep):
    """503 on attempt 1, 200 on attempt 2 → success, exactly one backoff."""
    responses = [
        _make_http_error(503),
        _FakeResp(status=204),
    ]
    def fake_urlopen(req, timeout=10):
        r = responses.pop(0)
        if isinstance(r, urllib.error.HTTPError):
            raise r
        return r
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    dc._post(webhook_url, {"content": "hi"})

    assert responses == []  # both consumed
    assert stub_sleep == [dc._RETRY_BACKOFFS[0]]  # one 2s sleep between attempts


def test_post_gives_up_after_max_attempts_on_503(monkeypatch, webhook_url, stub_sleep):
    """503 on every attempt → fails silently after _MAX_ATTEMPTS, no exception."""
    attempt_count = [0]
    def fake_urlopen(req, timeout=10):
        attempt_count[0] += 1
        raise _make_http_error(503)
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    # Must not raise
    dc._post(webhook_url, {"content": "hi"})

    assert attempt_count[0] == dc._MAX_ATTEMPTS
    # _MAX_ATTEMPTS-1 sleeps between them
    assert stub_sleep == list(dc._RETRY_BACKOFFS[: dc._MAX_ATTEMPTS - 1])


@pytest.mark.parametrize("code", sorted(dc._RETRY_STATUS_CODES))
def test_post_retries_each_retryable_code(monkeypatch, webhook_url, stub_sleep, code):
    """Every code in _RETRY_STATUS_CODES triggers retry."""
    attempts = [0]
    def fake_urlopen(req, timeout=10):
        attempts[0] += 1
        if attempts[0] == 1:
            raise _make_http_error(code)
        return _FakeResp(status=204)
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    dc._post(webhook_url, {"content": "hi"})

    assert attempts[0] == 2  # one retry happened


# ── Fail-fast on 4xx ──────────────────────────────────────────────────────


@pytest.mark.parametrize("code", [400, 401, 403, 404, 405])
def test_post_does_not_retry_on_4xx(monkeypatch, webhook_url, stub_sleep, code):
    """4xx codes mean the request itself is wrong — retrying won't help.
    Bail on the first attempt, no sleeps."""
    attempts = [0]
    def fake_urlopen(req, timeout=10):
        attempts[0] += 1
        raise _make_http_error(code)
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    dc._post(webhook_url, {"content": "hi"})

    assert attempts[0] == 1
    assert stub_sleep == []


# ── Retry on connection-level errors ──────────────────────────────────────


def test_post_retries_on_url_error(monkeypatch, webhook_url, stub_sleep):
    """URLError (DNS / connection refused / etc) should retry."""
    attempts = [0]
    def fake_urlopen(req, timeout=10):
        attempts[0] += 1
        if attempts[0] < 3:
            raise urllib.error.URLError("temporary dns hiccup")
        return _FakeResp(status=204)
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    dc._post(webhook_url, {"content": "hi"})

    assert attempts[0] == 3
    assert stub_sleep == list(dc._RETRY_BACKOFFS[:2])


def test_post_retries_on_socket_timeout(monkeypatch, webhook_url, stub_sleep):
    """Socket timeout (OSError subclass) should retry."""
    import socket
    attempts = [0]
    def fake_urlopen(req, timeout=10):
        attempts[0] += 1
        if attempts[0] == 1:
            raise socket.timeout("timed out")
        return _FakeResp(status=204)
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    dc._post(webhook_url, {"content": "hi"})

    assert attempts[0] == 2  # retried once and recovered


# ── Function never raises ────────────────────────────────────────────────


def test_post_swallows_unexpected_exceptions(monkeypatch, webhook_url, stub_sleep):
    """Truly unexpected error (e.g. ValueError from broken payload encoding)
    must NOT propagate — bots should never crash because Discord is sad."""
    def fake_urlopen(req, timeout=10):
        raise ValueError("something weird happened")
    monkeypatch.setattr(dc.urllib.request, "urlopen", fake_urlopen)

    # Must not raise
    dc._post(webhook_url, {"content": "hi"})
