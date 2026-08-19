"""Trailing price context for the agent's decision prompt.

The failure this closes: the agent saw only today's price and wrote "a steady
grind higher" into a CVS thesis about a stock that was drifting sideways. With
no history in the payload the claim could not be checked by the model writing
it or by anyone reading it later.
"""
import pytest

import agent_market_context as mc


def bars(closes):
    return [{"c": c} for c in closes]


def flat(n, price=100.0):
    return bars([price] * n)


def rising(n, start=100.0, step=0.5):
    return bars([start + i * step for i in range(n)])


# ── returns ────────────────────────────────────────────────────────────────

def test_one_week_return_uses_five_sessions_back():
    b = bars([100, 101, 102, 103, 104, 110])   # 6 closes: 5 sessions back == 100
    assert mc.trailing_stats(b)["return_1w_pct"] == 10.0


def test_returns_are_none_when_history_is_too_short():
    # A 3-month number computed from three weeks would read as authoritative
    # and be wrong — refuse rather than approximate.
    s = mc.trailing_stats(rising(30))
    assert s["return_1w_pct"] is not None
    assert s["return_1m_pct"] is not None
    assert s["return_3m_pct"] is None


def test_all_returns_available_with_a_full_year():
    s = mc.trailing_stats(rising(300))
    assert s["return_1w_pct"] is not None
    assert s["return_1m_pct"] is not None
    assert s["return_3m_pct"] is not None


def test_a_falling_stock_reports_negative_returns():
    # The case that mattered: prose said "grind higher"; the numbers disagree.
    s = mc.trailing_stats(bars([110 - i * 0.2 for i in range(100)]))
    assert s["return_1m_pct"] < 0
    assert s["return_3m_pct"] < 0
    assert s["pct_from_52w_high"] < 0


def test_a_flat_stock_reports_zero_not_a_trend():
    s = mc.trailing_stats(flat(100))
    assert s["return_1w_pct"] == 0.0
    assert s["return_1m_pct"] == 0.0
    assert s["pct_vs_sma20"] == 0.0


# ── moving average ─────────────────────────────────────────────────────────

def test_sma20_needs_twenty_sessions():
    assert mc.sma(mc._closes(flat(19))) is None
    assert mc.sma(mc._closes(flat(20))) == 100.0


def test_pct_vs_sma20_is_positive_above_the_average():
    s = mc.trailing_stats(rising(60))
    assert s["pct_vs_sma20"] > 0


def test_pct_vs_sma20_is_none_without_enough_history():
    s = mc.trailing_stats(flat(10))
    assert s["sma20"] is None
    assert s["pct_vs_sma20"] is None


# ── 52-week extremes ───────────────────────────────────────────────────────

def test_extremes_come_from_the_trailing_window():
    # An old spike outside the window must not define the "52-week" high.
    b = bars([500.0] + [100.0] * 300)
    s = mc.trailing_stats(b)
    assert s["high_52w"] == 100.0
    assert s["extremes_window_sessions"] == mc.WINDOW_52W


def test_at_the_high_reports_zero_distance():
    s = mc.trailing_stats(rising(100))
    assert s["pct_from_52w_high"] == 0.0
    assert s["pct_from_52w_low"] > 0


def test_window_is_labelled_honestly_when_short_of_a_year():
    s = mc.trailing_stats(flat(40))
    assert s["extremes_window_sessions"] == 40


# ── robustness ─────────────────────────────────────────────────────────────

def test_no_bars_reports_unavailable_rather_than_zeros():
    # Zeros would read as "flat", which is a claim. Unknown is not a claim.
    s = mc.trailing_stats([])
    assert s["available"] is False
    assert "return_1w_pct" not in s


def test_malformed_bars_are_skipped_not_fatal():
    b = [{"c": 100}, {"c": None}, {}, {"c": "x"}, {"c": 110}]
    s = mc.trailing_stats(b)
    assert s["available"] is True
    assert s["last_close"] == 110


def test_non_positive_closes_are_ignored():
    s = mc.trailing_stats([{"c": 0}, {"c": -5}, {"c": 50}])
    assert s["last_close"] == 50


# ── summary line ───────────────────────────────────────────────────────────

def test_describe_trend_carries_signed_numbers():
    line = mc.describe_trend(mc.trailing_stats(rising(300)))
    assert "1w" in line and "1m" in line and "3m" in line
    assert "%" in line
    assert "+" in line or "-" in line


def test_describe_trend_is_none_without_data():
    assert mc.describe_trend({"available": False}) is None


def test_describe_trend_omits_fields_it_cannot_compute():
    line = mc.describe_trend(mc.trailing_stats(rising(30)))
    assert "3m" not in line     # not enough history
    assert "1m" in line
