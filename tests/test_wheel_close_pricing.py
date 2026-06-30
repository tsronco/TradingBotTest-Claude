"""R4 — wheel 50%-close decides on the quote mid and buys to close marketable.

The early-close used get_option_last_price (last TRADE) for BOTH the 50%-profit
DECISION and the buy-to-close limit. On an illiquid contract that price is
stale: the trigger can miss/misfire, and a BTC limit at stale-last+$0.05 can sit
below the ask and never fill — yet state was cleared to "closed" and (on
cons/agg) a new put was sold → false state / double short. _close_mark_and_limit
now returns the quote MID for the decision and the ASK (marketable) for the BTC.
"""
import pytest

import wheel_strategy as ws


def test_mark_uses_quote_mid_and_limit_uses_ask(monkeypatch):
    monkeypatch.setattr(ws, "get_option_quote", lambda c: {"bid": 0.10, "ask": 0.20})
    mark, limit = ws._close_mark_and_limit("X260101P00010000")
    assert mark == 0.15    # decision priced off the MID
    assert limit == 0.20   # buy-to-close priced MARKETABLE (the ask)


def test_falls_back_to_last_trade_when_no_quote(monkeypatch):
    monkeypatch.setattr(ws, "get_option_quote", lambda c: None)
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: 0.12)
    mark, limit = ws._close_mark_and_limit("X260101P00010000")
    assert mark == 0.12
    assert limit == 0.12


def test_one_sided_quote_falls_back_to_last(monkeypatch):
    # bid missing → no usable mid → fall back to last trade for both.
    monkeypatch.setattr(ws, "get_option_quote", lambda c: {"bid": None, "ask": 0.20})
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: 0.09)
    mark, limit = ws._close_mark_and_limit("X260101P00010000")
    assert mark == 0.09
    assert limit == 0.09


def test_none_when_no_price_at_all(monkeypatch):
    monkeypatch.setattr(ws, "get_option_quote", lambda c: None)
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: None)
    assert ws._close_mark_and_limit("X260101P00010000") == (None, None)


def test_quote_mid_triggers_close_a_stale_last_would_miss(monkeypatch):
    # entry 0.30, conservative closes at <= 50% (0.15). Live mid is 0.15
    # (trigger), but the stale last trade is 0.25 (would NOT trigger).
    ws.apply_mode("manual")
    try:
        monkeypatch.setattr(ws, "get_option_quote", lambda c: {"bid": 0.10, "ask": 0.20})
        monkeypatch.setattr(ws, "get_option_last_price", lambda c: 0.25)
        mark, limit = ws._close_mark_and_limit("X260101P00010000")
        sym_state = {"contract_entry_price": 0.30}
        assert ws.check_early_close(sym_state, mark) is True    # mid 0.15 triggers
        assert ws.check_early_close(sym_state, 0.25) is False   # stale last would miss
        assert limit == 0.20                                     # fills at the ask
    finally:
        import config
        ws.apply_mode(config.DEFAULT_MODE)
