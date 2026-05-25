"""Regression tests for scraper regex helpers.

Locking these in because a silent CapitolTrades HTML change broke ticker
extraction once (returning zero disclosures for ~weeks before noticed).
"""
from src.scraper import _extract_ticker, _parse_date, _parse_dollar_range
from decimal import Decimal


class TestExtractTicker:
    def test_current_format_space_separator(self):
        """CapitolTrades layout as of 2026-05-24: plain space between name and ticker."""
        assert _extract_ticker("3M Co MMM:US") == "MMM"
        assert _extract_ticker("Apple Inc AAPL:US") == "AAPL"
        assert _extract_ticker("Tesla Inc TSLA:US") == "TSLA"

    def test_legacy_pipe_format_still_works(self):
        """Old layout where Playwright inner_text returned `\\n` for the CSS-styled pipe."""
        assert _extract_ticker("Air Products and Chemicals Inc\nAPD:US") == "APD"

    def test_literal_pipe_separator(self):
        """Defensive: if CapitolTrades ever serves a literal pipe."""
        assert _extract_ticker("Air Products and Chemicals Inc | APD:US") == "APD"

    def test_ticker_only(self):
        assert _extract_ticker("TSLA:US") == "TSLA"
        assert _extract_ticker("AAPL") == "AAPL"

    def test_returns_none_on_garbage(self):
        assert _extract_ticker("") is None
        assert _extract_ticker("no ticker here") is None


class TestParseDate:
    def test_current_format_no_separator(self):
        d = _parse_date("20 May 2026")
        assert d is not None and d.year == 2026 and d.month == 5 and d.day == 20

    def test_legacy_pipe_format(self):
        d = _parse_date("9 Apr | 2026")
        assert d is not None and d.year == 2026 and d.month == 4 and d.day == 9

    def test_legacy_newline_format(self):
        d = _parse_date("9 Apr\n2026")
        assert d is not None and d.year == 2026 and d.month == 4 and d.day == 9


class TestParseDollarRange:
    def test_hyphen_separator(self):
        lo, hi = _parse_dollar_range("1K-15K")
        assert lo == Decimal(1_000) and hi == Decimal(15_000)

    def test_endash_separator(self):
        lo, hi = _parse_dollar_range("1K–15K")
        assert lo == Decimal(1_000) and hi == Decimal(15_000)
