import datetime as dt
from unittest.mock import patch
import pytest
import earnings


@pytest.fixture(autouse=True)
def clear_earnings_cache():
    """Isolate each test: clear the per-run cache before every test."""
    earnings._CACHE.clear()
    yield
    earnings._CACHE.clear()


def _mk(days_out):
    when = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days_out)
    return when


def test_blocks_when_earnings_within_window():
    with patch("earnings._next_earnings_dt", return_value=_mk(3)):
        assert earnings.next_earnings_within("F", 7) is True


def test_clear_when_earnings_outside_window():
    with patch("earnings._next_earnings_dt", return_value=_mk(30)):
        assert earnings.next_earnings_within("F", 7) is False


def test_unknown_earnings_is_treated_as_blocked_by_default():
    # No data -> conservative: assume risk, block (don't sell blind into a possible print)
    with patch("earnings._next_earnings_dt", return_value=None):
        assert earnings.next_earnings_within("ZZZZ", 7) is True


def test_per_run_cache_avoids_duplicate_lookups():
    earnings._CACHE.clear()
    with patch("earnings._next_earnings_dt", return_value=_mk(30)) as m:
        earnings.next_earnings_within("F", 7)
        earnings.next_earnings_within("F", 7)
        assert m.call_count == 1  # second call served from cache


def test_yfinance_exhaustion_returns_none_and_logs(monkeypatch, capsys):
    """All 3 attempts raise -> returns None (BLOCKED) and logs the exhaustion line."""
    monkeypatch.setattr("time.sleep", lambda _: None)  # no real sleeps
    with patch("yfinance.Ticker", side_effect=RuntimeError("rate limited")):
        result = earnings._next_earnings_dt("X")
    assert result is None
    captured = capsys.readouterr()
    assert "all 3 attempts failed" in captured.out
    assert "BLOCKED" in captured.out


# ── R16: same-day earnings must block (yfinance midnight-dating gap) ──────────

def test_blocks_same_day_earnings_dated_midnight():
    # yfinance dates today's earnings at 00:00 UTC; by the afternoon the old
    # seconds-based delta is NEGATIVE and slipped through as "not within".
    today_midnight = dt.datetime.now(dt.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0)
    with patch("earnings._next_earnings_dt", return_value=today_midnight):
        assert earnings.next_earnings_within("F", 7) is True


def test_boundary_blocks_at_exactly_days_out():
    with patch("earnings._next_earnings_dt", return_value=_mk(7)):
        assert earnings.next_earnings_within("F", 7) is True


def test_just_outside_window_not_blocked():
    with patch("earnings._next_earnings_dt", return_value=_mk(8)):
        assert earnings.next_earnings_within("F", 7) is False


class _FakeTS:
    def __init__(self, d):
        self._d = d
    def to_pydatetime(self):
        return self._d


class _FakeDF:
    def __init__(self, idx):
        self.index = idx
    def __len__(self):
        return len(self.index)


def test_next_earnings_dt_includes_same_day_excludes_past(monkeypatch):
    now = dt.datetime.now(dt.timezone.utc)
    yesterday = now - dt.timedelta(days=1)
    today_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    fake = _FakeDF([_FakeTS(yesterday), _FakeTS(today_midnight)])

    class _T:
        def __init__(self, s):
            pass
        def get_earnings_dates(self, limit=8):
            return fake

    monkeypatch.setattr("yfinance.Ticker", _T)
    result = earnings._next_earnings_dt("X")
    assert result is not None
    assert result.date() == now.date()  # same-day included; yesterday excluded
