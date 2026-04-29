"""Tests for long_options_strategy.py.

Covers:
  - OCC symbol parsing (calls, puts, edge cases)
  - Position filtering (long vs short, options vs stock)
  - Decision logic (take profit, stop loss, time exit, hold, skip paths)
"""
from datetime import date, timedelta
from unittest.mock import patch

import long_options_strategy as los


# ── parse_occ_symbol ──────────────────────────────────────────────────────

def test_parse_occ_call():
    p = los.parse_occ_symbol("RIVN260522C00015500")
    assert p == {
        "ticker": "RIVN",
        "expiry": date(2026, 5, 22),
        "type": "call",
        "strike": 15.50,
    }


def test_parse_occ_put():
    p = los.parse_occ_symbol("TSLA260522P00340000")
    assert p == {
        "ticker": "TSLA",
        "expiry": date(2026, 5, 22),
        "type": "put",
        "strike": 340.00,
    }


def test_parse_occ_short_ticker():
    p = los.parse_occ_symbol("F260620C00012000")
    assert p["ticker"] == "F"
    assert p["strike"] == 12.00
    assert p["type"] == "call"


def test_parse_occ_invalid_returns_none():
    assert los.parse_occ_symbol("NOTANOPTION") is None
    assert los.parse_occ_symbol("RIVN260522X00015500") is None  # X is not C or P
    assert los.parse_occ_symbol("RIVN26052") is None  # too short
    assert los.parse_occ_symbol("") is None


# ── list_long_option_positions ────────────────────────────────────────────

def test_list_long_option_positions_filters_short_and_stock(monkeypatch):
    raw_positions = [
        # Long call (should be included)
        {"symbol": "RIVN260522C00015500", "asset_class": "us_option", "qty": "1", "avg_entry_price": "1.60"},
        # Short put (wheel-managed, should be excluded — qty < 0)
        {"symbol": "TSLA260522P00340000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "4.10"},
        # Stock (should be excluded — wrong asset_class)
        {"symbol": "TSLA", "asset_class": "us_equity", "qty": "10", "avg_entry_price": "367.85"},
        # Long put (should be included)
        {"symbol": "AAPL260530P00200000", "asset_class": "us_option", "qty": "2", "avg_entry_price": "3.50"},
    ]
    monkeypatch.setattr(los, "list_all_positions", lambda: raw_positions)

    longs = los.list_long_option_positions()
    syms = sorted(p["symbol"] for p in longs)
    assert syms == ["AAPL260530P00200000", "RIVN260522C00015500"]


# ── evaluate_position decision logic ──────────────────────────────────────

TODAY = date(2026, 4, 29)


def _pos(symbol="RIVN260522C00015500", qty=1, entry=1.60):
    return {
        "symbol": symbol,
        "asset_class": "us_option",
        "qty": str(qty),
        "avg_entry_price": str(entry),
    }


def test_evaluate_take_profit_at_100pct(monkeypatch):
    """Option at 2x entry → take profit."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 3.20)
    action, pnl, info = los.evaluate_position(_pos(entry=1.60), TODAY)
    assert action == "take_profit"
    assert pnl >= 1.00


def test_evaluate_stop_loss_at_50pct_loss(monkeypatch):
    """Option at 0.5x entry → stop loss."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 0.80)
    action, pnl, info = los.evaluate_position(_pos(entry=1.60), TODAY)
    assert action == "stop_loss"
    assert pnl <= -0.50


def test_evaluate_time_exit_when_close_to_expiry_and_underwater(monkeypatch):
    """Within 3 days of expiry AND in the red → time_exit."""
    expiry_close = "RIVN260501C00015500"  # May 1, 2026
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.40)  # -12%
    action, pnl, info = los.evaluate_position(
        _pos(symbol=expiry_close, entry=1.60), TODAY
    )
    assert action == "time_exit"


def test_evaluate_time_exit_NOT_triggered_when_profitable(monkeypatch):
    """Within 3 days of expiry but in profit → keep holding (don't force-close gainer)."""
    expiry_close = "RIVN260501C00015500"  # May 1, 2026 = 2 days away
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.80)  # +12.5%
    action, pnl, info = los.evaluate_position(
        _pos(symbol=expiry_close, entry=1.60), TODAY
    )
    assert action == "hold"


def test_evaluate_hold_when_in_normal_range(monkeypatch):
    """Mid-range P&L, plenty of time → hold."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.40)  # -12.5%
    action, pnl, info = los.evaluate_position(_pos(entry=1.60), TODAY)
    assert action == "hold"


def test_evaluate_skip_unparseable():
    """Bad symbol → skip_unparseable, no API calls."""
    pos = {"symbol": "GARBAGE", "qty": "1", "avg_entry_price": "1.00"}
    action, pnl, info = los.evaluate_position(pos, TODAY)
    assert action == "skip_unparseable"


def test_evaluate_skip_no_entry():
    """Missing avg_entry_price → skip_no_entry."""
    pos = {"symbol": "RIVN260522C00015500", "qty": "1"}
    action, pnl, info = los.evaluate_position(pos, TODAY)
    assert action == "skip_no_entry"


def test_evaluate_skip_no_price(monkeypatch):
    """Quote endpoint returns None → skip_no_price."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: None)
    action, pnl, info = los.evaluate_position(_pos(), TODAY)
    assert action == "skip_no_price"


# ── Boundary: exactly at 100% / -50% ──────────────────────────────────────

def test_evaluate_take_profit_inclusive_at_exactly_100pct(monkeypatch):
    """Right at the 100% threshold should trigger take_profit (>=, not >)."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 2.00)
    action, _, _ = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "take_profit"


def test_evaluate_stop_loss_inclusive_at_exactly_minus50pct(monkeypatch):
    """Right at the -50% threshold should trigger stop_loss (<=, not <)."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 0.50)
    action, _, _ = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "stop_loss"


def test_evaluate_just_under_take_profit_holds(monkeypatch):
    """At +99% gain → still hold."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.99)
    action, _, _ = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "hold"


def test_evaluate_just_above_stop_loss_holds(monkeypatch):
    """At -49% loss → still hold."""
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 0.51)
    action, _, _ = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "hold"
