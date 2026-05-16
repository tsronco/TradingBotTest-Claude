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
