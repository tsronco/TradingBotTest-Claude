"""Resilience of the agent's Anthropic API calls.

Regression cover for 2026-08-18, when two consecutive hourly cycles died on a
529 `overloaded_error`. The SDK does retry 5xx, but only twice by default —
a couple of seconds of cover — and the decision call was unguarded beyond that,
so a brief capacity blip cost the whole trading hour.
"""
import pytest

import agent_config
import agent_trader


class _Status(Exception):
    """Stand-in for an SDK APIStatusError carrying an HTTP status."""
    def __init__(self, status_code):
        super().__init__(f"status {status_code}")
        self.status_code = status_code


class OverloadedError(Exception):
    """Name-matched stand-in for anthropic.OverloadedError (529)."""


class APIConnectionError(Exception):
    """Name-matched stand-in for anthropic.APIConnectionError."""


class BadRequestError(Exception):
    """A caller-side fault — must never be retried."""


# ── classification ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("status", [500, 502, 503, 529, 599])
def test_5xx_is_transient(status):
    assert agent_trader.is_transient_api_error(_Status(status)) is True


def test_429_is_transient():
    assert agent_trader.is_transient_api_error(_Status(429)) is True


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_4xx_is_not_transient(status):
    # Retrying a malformed or unauthorized request just burns quota.
    assert agent_trader.is_transient_api_error(_Status(status)) is False


def test_recognized_by_class_name_when_no_status_attached():
    assert agent_trader.is_transient_api_error(OverloadedError()) is True
    assert agent_trader.is_transient_api_error(APIConnectionError()) is True


def test_unknown_exception_is_not_transient():
    assert agent_trader.is_transient_api_error(BadRequestError()) is False
    assert agent_trader.is_transient_api_error(ValueError("boom")) is False


# ── retry helper ───────────────────────────────────────────────────────────

def test_returns_immediately_when_the_call_succeeds():
    calls = []
    out = agent_trader.call_with_retry(
        lambda: (calls.append(1), "ok")[1],
        attempts=3, backoff=5, sleep=lambda _: pytest.fail("should not sleep"),
    )
    assert out == "ok"
    assert len(calls) == 1


def test_retries_a_transient_failure_then_succeeds():
    seen = {"n": 0}
    slept = []

    def flaky():
        seen["n"] += 1
        if seen["n"] < 3:
            raise OverloadedError()
        return "recovered"

    out = agent_trader.call_with_retry(
        flaky, attempts=5, backoff=10, sleep=slept.append,
    )
    assert out == "recovered"
    assert seen["n"] == 3
    # Linear backoff, and no sleep after the successful attempt.
    assert slept == [10, 20]


def test_gives_up_after_the_attempt_budget_and_reraises_the_last_error():
    seen = {"n": 0}

    def always_busy():
        seen["n"] += 1
        raise OverloadedError()

    with pytest.raises(OverloadedError):
        agent_trader.call_with_retry(
            always_busy, attempts=3, backoff=1, sleep=lambda _: None,
        )
    assert seen["n"] == 3  # exactly the budget — no extra call


def test_does_not_retry_a_caller_side_error():
    seen = {"n": 0}

    def bad_request():
        seen["n"] += 1
        raise _Status(400)

    with pytest.raises(_Status):
        agent_trader.call_with_retry(
            bad_request, attempts=5, backoff=1, sleep=lambda _: pytest.fail("no sleep"),
        )
    assert seen["n"] == 1


def test_reports_each_retry_to_the_caller():
    reported = []

    def flaky():
        if len(reported) < 2:
            raise OverloadedError()
        return "ok"

    agent_trader.call_with_retry(
        flaky, attempts=4, backoff=3, sleep=lambda _: None,
        on_retry=lambda n, delay, e: reported.append((n, delay, type(e).__name__)),
    )
    assert reported == [(1, 3, "OverloadedError"), (2, 6, "OverloadedError")]


def test_attempts_below_one_still_runs_once():
    calls = []
    agent_trader.call_with_retry(
        lambda: calls.append(1), attempts=0, backoff=1, sleep=lambda _: None,
    )
    assert len(calls) == 1


# ── client configuration ───────────────────────────────────────────────────

def test_retry_budget_exceeds_the_sdk_default():
    # The SDK default of 2 is what left cycles unprotected.
    assert agent_config.AGENT_CONFIG["max_retries"] > 2


def test_decision_call_has_its_own_retry_budget():
    cfg = agent_config.AGENT_CONFIG
    assert cfg["decision_retries"] >= 2
    assert cfg["decision_retry_backoff_seconds"] > 0


def test_client_factory_passes_the_configured_retry_budget(monkeypatch):
    captured = {}

    class _FakeAnthropic:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import sys, types
    fake = types.ModuleType("anthropic")
    fake.Anthropic = _FakeAnthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)

    agent_config.client()
    assert captured["max_retries"] == agent_config.AGENT_CONFIG["max_retries"]


def test_client_factory_allows_per_call_overrides(monkeypatch):
    captured = {}

    class _FakeAnthropic:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import sys, types
    fake = types.ModuleType("anthropic")
    fake.Anthropic = _FakeAnthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)

    agent_config.client(max_retries=1, timeout=5)
    assert captured["max_retries"] == 1
    assert captured["timeout"] == 5


# ── depth context wiring ───────────────────────────────────────────────────

class _StubBars:
    """Deterministic rising series so trend numbers are predictable."""
    @staticmethod
    def get_stock_bars(symbol, days=90, timeframe="1Day", mode="manual"):
        return [{"c": 100 + i * 0.1} for i in range(300)]


def test_context_pack_attaches_trend_and_earnings(monkeypatch):
    monkeypatch.setattr(agent_trader.alpaca_data, "get_stock_bars", _StubBars.get_stock_bars)
    monkeypatch.setattr(agent_trader.earnings_mod, "earnings_context",
                        lambda sym: {"days_to_next_earnings": 40, "days_since_last_earnings": 12})
    pack = agent_trader.build_context_pack(["cvs", "DIS"])
    assert set(pack) == {"CVS", "DIS"}
    assert pack["CVS"]["trend"]["available"] is True
    assert pack["CVS"]["trend"]["return_3m_pct"] is not None
    assert pack["CVS"]["earnings"]["days_since_last_earnings"] == 12
    assert "%" in pack["CVS"]["trend_summary"]


def test_context_pack_survives_a_bars_failure(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("alpaca down")
    monkeypatch.setattr(agent_trader.alpaca_data, "get_stock_bars", boom)
    monkeypatch.setattr(agent_trader.earnings_mod, "earnings_context", lambda sym: {})
    pack = agent_trader.build_context_pack(["CVS"])
    # Unavailable, not absent and not zeroed — the mandate keys off this.
    assert pack["CVS"]["trend"]["available"] is False


def test_context_pack_survives_an_earnings_failure(monkeypatch):
    monkeypatch.setattr(agent_trader.alpaca_data, "get_stock_bars", _StubBars.get_stock_bars)
    def boom(sym):
        raise RuntimeError("yfinance rate limited")
    monkeypatch.setattr(agent_trader.earnings_mod, "earnings_context", boom)
    pack = agent_trader.build_context_pack(["CVS"])
    assert pack["CVS"]["trend"]["available"] is True
    assert "unavailable" in pack["CVS"]["earnings"]["note"]


def test_context_is_keyed_by_underlying_not_by_option_leg(monkeypatch):
    # An OCC leg has no chart of its own; depth symbols include both.
    monkeypatch.setattr(agent_trader.alpaca_data, "get_stock_bars", _StubBars.get_stock_bars)
    monkeypatch.setattr(agent_trader.earnings_mod, "earnings_context", lambda sym: {})
    underlyings = [agent_trader._occ_underlying(s)
                   for s in ["CVS260925C00096000", "CVS", "DIS260828P00103000"]]
    pack = agent_trader.build_context_pack(underlyings)
    assert set(pack) == {"CVS", "DIS"}
