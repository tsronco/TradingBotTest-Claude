"""Tests for the OCC option-symbol humanizer used in the daily summary embed.

OCC symbols like SNAP260515P00007500 are illegible at a glance. The
humanizer renders them as SNAP 05/15/26 $7.50P. Robustness matters more
than fancy formatting — anything unparseable must pass through unchanged
so the daily summary never crashes on an unexpected contract format.
"""
import pytest

from daily_summary import _humanize_occ


def test_humanizes_short_put():
    assert _humanize_occ("SNAP260515P00007500") == "SNAP 05/15/26 $7.50P"


def test_humanizes_long_call():
    assert _humanize_occ("TSLA260620C00280000") == "TSLA 06/20/26 $280.00C"


def test_humanizes_multi_letter_ticker():
    assert _humanize_occ("NVDA260117P00120000") == "NVDA 01/17/26 $120.00P"


def test_humanizes_one_letter_ticker():
    """F is a real Alpaca ticker (Ford)."""
    assert _humanize_occ("F260919C00011000") == "F 09/19/26 $11.00C"


def test_humanizes_fractional_strike():
    """Strike $112.50 must render with the half-dollar precision intact."""
    assert _humanize_occ("AAPL260117C00112500") == "AAPL 01/17/26 $112.50C"


def test_humanizes_three_digit_strike():
    """Four-digit strikes (e.g. $1,000 on TSLA) shouldn't break formatting."""
    assert _humanize_occ("TSLA261218C01000000") == "TSLA 12/18/26 $1000.00C"


def test_none_input_returns_placeholder():
    """daily_summary calls this with the raw state value, which can be None."""
    assert _humanize_occ(None) == "none"


def test_empty_string_returns_placeholder():
    assert _humanize_occ("") == "none"


def test_passthrough_when_unparseable():
    """Garbage in → garbage out (preserved). The summary must not crash."""
    assert _humanize_occ("not-an-occ") == "not-an-occ"


def test_passthrough_when_no_ticker_prefix():
    """All-digit input has no ticker → passthrough."""
    assert _humanize_occ("260515P00007500") == "260515P00007500"


def test_passthrough_when_too_short():
    """OCC requires exactly 15 chars after the ticker."""
    assert _humanize_occ("SNAP260515P0007") == "SNAP260515P0007"


def test_passthrough_when_invalid_side_letter():
    """Side must be P or C — anything else is not a valid OCC symbol."""
    assert _humanize_occ("SNAP260515X00007500") == "SNAP260515X00007500"


def test_passthrough_when_bad_date_digits():
    """Non-numeric date positions → passthrough."""
    assert _humanize_occ("SNAPABCDEFP00007500") == "SNAPABCDEFP00007500"
