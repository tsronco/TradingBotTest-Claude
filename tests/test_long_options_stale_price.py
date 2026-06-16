"""R3 — long-option exits decided off the live quote, not a stale last trade.

evaluate_position used get_option_last_price (last TRADE), which on an illiquid
contract can be hours/days stale: a collapsed long shows a small loss (stop
never fires) and a run-up long shows a phantom +100% (premature take-profit).
It now prefers the live quote MID, falling back to last trade only when no
two-sided quote exists.
"""
from datetime import date

import pytest

import long_options_strategy as los

TODAY = date(2026, 6, 16)


def _pos(symbol="AAL260918C00012000", entry=1.00, qty=1):
    return {"symbol": symbol, "avg_entry_price": str(entry),
            "qty": str(qty), "asset_class": "us_option"}


def test_stop_fires_on_collapsed_quote_despite_stale_high_last(monkeypatch):
    # Live quote shows the long has collapsed to ~0.40 mid (-60%) even though
    # the last trade is stale at entry (1.00). Stop must fire on the quote.
    monkeypatch.setattr(los, "get_option_quote", lambda s: {"bid": 0.38, "ask": 0.42})
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.00)
    action, pnl, info = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "stop_loss"
    assert info["current"] == pytest.approx(0.40)


def test_take_profit_on_quote_mid_despite_stale_low_last(monkeypatch):
    # Live quote mid 2.10 (+110%) though last trade is stale-low at 1.00.
    monkeypatch.setattr(los, "get_option_quote", lambda s: {"bid": 2.05, "ask": 2.15})
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.00)
    action, pnl, info = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "take_profit"
    assert info["current"] == pytest.approx(2.10)


def test_falls_back_to_last_when_no_quote(monkeypatch):
    monkeypatch.setattr(los, "get_option_quote", lambda s: None)
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 1.50)
    action, pnl, info = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert info["current"] == 1.50
    assert action == "hold"  # +50%, below the +100% take-profit


def test_skip_no_price_when_neither_available(monkeypatch):
    monkeypatch.setattr(los, "get_option_quote", lambda s: None)
    monkeypatch.setattr(los, "get_option_last_price", lambda s: None)
    action, pnl, info = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert action == "skip_no_price"


def test_one_sided_quote_falls_back_to_last(monkeypatch):
    # A degenerate one-sided quote (ask only) isn't a usable mid → fall back.
    monkeypatch.setattr(los, "get_option_quote", lambda s: {"bid": None, "ask": 0.50})
    monkeypatch.setattr(los, "get_option_last_price", lambda s: 0.90)
    action, pnl, info = los.evaluate_position(_pos(entry=1.00), TODAY)
    assert info["current"] == 0.90
