"""Tests for the pure-function helpers inside the new skill scripts.

Covers the deterministic, no-network logic. The Alpaca-fetching paths are
exercised via the existing wheel/strategy tests with mocks; the tools/*
scripts above just call alpaca_data.* and format the result, so we test
formatting and normalization here.
"""

from datetime import timedelta

from tools.health import _human_age
from tools.pnl import PERIOD_ALIASES, TIMEFRAME_FOR, normalize_period
from tools.positions import _classify, _direction, _row


# ── tools/positions.py ──────────────────────────────────────────────────────

class TestPositionsHelpers:
    def test_classify_stock(self):
        assert _classify({"asset_class": "us_equity"}) == "stock"

    def test_classify_option(self):
        assert _classify({"asset_class": "us_option"}) == "option"

    def test_classify_default(self):
        assert _classify({}) == "stock"  # missing asset_class → stock

    def test_direction_long(self):
        assert _direction({"qty": "10"}) == "long"
        assert _direction({"qty": "0"}) == "long"  # 0 → long by convention

    def test_direction_short(self):
        assert _direction({"qty": "-1"}) == "short"
        assert _direction({"qty": "-100"}) == "short"

    def test_direction_unparseable(self):
        assert _direction({"qty": "abc"}) == "long"

    def test_row_stock(self):
        p = {
            "symbol": "TSLA",
            "asset_class": "us_equity",
            "qty": "10",
            "avg_entry_price": "200.50",
            "current_price": "220.00",
            "market_value": "2200.00",
            "unrealized_pl": "195.00",
            "unrealized_plpc": "0.0975",
        }
        r = _row(p)
        assert r["symbol"] == "TSLA"
        assert r["qty"] == 10
        assert r["entry"] == 200.5
        assert r["current"] == 220.0
        assert r["market_value"] == 2200.0
        assert r["upl"] == 195.0
        assert abs(r["upl_pct"] - 9.75) < 0.01
        assert r["kind"] == "stock"
        assert r["side"] == "long"

    def test_row_short_option(self):
        p = {
            "symbol": "TSLA250620P00200000",
            "asset_class": "us_option",
            "qty": "-1",
            "avg_entry_price": "2.50",
            "current_price": "1.10",
            "market_value": "-110.00",
            "unrealized_pl": "140.00",
            "unrealized_plpc": "0.56",
        }
        r = _row(p)
        assert r["kind"] == "option"
        assert r["side"] == "short"
        assert r["qty"] == -1


# ── tools/pnl.py ────────────────────────────────────────────────────────────

class TestPnlPeriodNormalization:
    def test_aliases_map_consistently(self):
        assert normalize_period("day") == "1D"
        assert normalize_period("today") == "1D"
        assert normalize_period("1d") == "1D"
        assert normalize_period("week") == "1W"
        assert normalize_period("1w") == "1W"
        assert normalize_period("month") == "1M"
        assert normalize_period("1m") == "1M"
        assert normalize_period("3m") == "3M"
        assert normalize_period("year") == "1A"
        assert normalize_period("1y") == "1A"
        assert normalize_period("all") == "all"
        assert normalize_period("max") == "all"

    def test_uppercase_passthrough(self):
        assert normalize_period("1D") == "1D"
        assert normalize_period("3M") == "3M"

    def test_unknown_falls_back_to_month(self):
        assert normalize_period("nonsense") == "1M"

    def test_every_alias_maps_to_a_known_period(self):
        for alias, target in PERIOD_ALIASES.items():
            assert target in TIMEFRAME_FOR or target == "all", (
                f"alias {alias!r} → {target!r} has no timeframe entry"
            )

    def test_every_known_period_has_a_timeframe(self):
        for period in ("1D", "1W", "1M", "3M", "1A", "all"):
            assert period in TIMEFRAME_FOR


# ── tools/health.py ─────────────────────────────────────────────────────────

class TestHumanAge:
    def test_seconds(self):
        assert _human_age(timedelta(seconds=42)) == "42s"

    def test_minutes(self):
        assert _human_age(timedelta(minutes=5)) == "5m"

    def test_minutes_round_down(self):
        # 90 seconds → 1m, not 1.5m
        assert _human_age(timedelta(seconds=90)) == "1m"

    def test_hours(self):
        assert _human_age(timedelta(hours=3)) == "3h"

    def test_days(self):
        assert _human_age(timedelta(days=2, hours=5)) == "2d"

    def test_zero(self):
        assert _human_age(timedelta(0)) == "0s"
