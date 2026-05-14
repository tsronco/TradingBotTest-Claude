"""Tests for the "Held Stocks (not tracked by bot)" section of the daily summary.

This section is a ground-truth check against Alpaca: it shows any us_equity
position the bot ISN'T already managing via strategy.py or wheel_strategy.py.
Defends against the gap where a stock could slip past the bot's symbol lists
(config edit, manual buy between cycles, old wheel assignment, etc.).

Symbols already in strategy or wheel state must be filtered out to avoid
duplicating the existing "Stocks (strategy.py)" block.
"""
import pytest

import daily_summary


# ── _tracked_stock_symbols ────────────────────────────────────────────────


def test_tracked_includes_strategy_multi_stock_symbols():
    strategy = {
        "available": True,
        "format": "multi_stock",
        "symbols": {"F": {"qty": 10}, "BAC": {"qty": 5}},
    }
    wheel = {"available": False}
    assert daily_summary._tracked_stock_symbols(strategy, wheel) == {"F", "BAC"}


def test_tracked_treats_single_stock_strategy_as_tsla():
    strategy = {"available": True, "format": "single_stock", "qty": 10, "avg_cost": 250.0}
    wheel = {"available": False}
    assert daily_summary._tracked_stock_symbols(strategy, wheel) == {"TSLA"}


def test_tracked_includes_wheel_multi_stock_symbols():
    strategy = {"available": False}
    wheel = {
        "available": True,
        "format": "multi_stock",
        "symbols": {"NVDA": {"stage": 1}, "XOM": {"stage": 2}},
    }
    assert daily_summary._tracked_stock_symbols(strategy, wheel) == {"NVDA", "XOM"}


def test_tracked_skips_underscore_keys_in_wheel_symbols():
    """_meta and similar keys must not leak into the tracked set."""
    strategy = {"available": False}
    wheel = {
        "available": True,
        "format": "multi_stock",
        "symbols": {"_meta": {"version": 2}, "TSLA": {"stage": 1}},
    }
    assert daily_summary._tracked_stock_symbols(strategy, wheel) == {"TSLA"}


def test_tracked_legacy_wheel_format_implies_tsla():
    strategy = {"available": False}
    wheel = {"available": True, "format": "legacy_single_stock"}
    assert daily_summary._tracked_stock_symbols(strategy, wheel) == {"TSLA"}


def test_tracked_union_of_strategy_and_wheel():
    strategy = {
        "available": True,
        "format": "multi_stock",
        "symbols": {"F": {}, "TSLA": {}},
    }
    wheel = {
        "available": True,
        "format": "multi_stock",
        "symbols": {"NVDA": {}, "TSLA": {}},
    }
    assert daily_summary._tracked_stock_symbols(strategy, wheel) == {"F", "TSLA", "NVDA"}


def test_tracked_empty_when_neither_available():
    assert daily_summary._tracked_stock_symbols({"available": False}, {"available": False}) == set()


# ── _summarize_held_stocks ────────────────────────────────────────────────


def _equity_pos(symbol, qty=10, entry=20.0, current=22.5):
    """Build a position dict shaped like Alpaca's /v2/positions response."""
    return {
        "symbol":           symbol,
        "asset_class":      "us_equity",
        "qty":               str(qty),
        "avg_entry_price":   str(entry),
        "current_price":     str(current),
        "market_value":      str(qty * current),
        "unrealized_pl":     str((current - entry) * qty),
        "unrealized_plpc":   str((current - entry) / entry),
    }


def test_held_filters_out_tracked_symbols(monkeypatch):
    """Symbols in tracked_symbols must NOT appear in the held list."""
    monkeypatch.setattr(
        daily_summary, "_get_positions",
        lambda cfg: [_equity_pos("F"), _equity_pos("BAC"), _equity_pos("TSLA")],
    )
    result = daily_summary._summarize_held_stocks({}, {"F", "TSLA"})
    assert result["available"] is True
    assert {p["symbol"] for p in result["positions"]} == {"BAC"}
    assert result["count"] == 1


def test_held_skips_options(monkeypatch):
    """us_option positions belong to long_opts/wheel, not held-stocks."""
    monkeypatch.setattr(
        daily_summary, "_get_positions",
        lambda cfg: [
            _equity_pos("F"),
            {"symbol": "TSLA250620C00280000", "asset_class": "us_option", "qty": "1"},
        ],
    )
    result = daily_summary._summarize_held_stocks({}, set())
    assert {p["symbol"] for p in result["positions"]} == {"F"}


def test_held_skips_zero_qty_positions(monkeypatch):
    """Stale zero-qty entries (mid-close) should not display."""
    monkeypatch.setattr(
        daily_summary, "_get_positions",
        lambda cfg: [_equity_pos("F", qty=0), _equity_pos("BAC", qty=5)],
    )
    result = daily_summary._summarize_held_stocks({}, set())
    assert {p["symbol"] for p in result["positions"]} == {"BAC"}


def test_held_returns_pnl_and_market_value(monkeypatch):
    """The section displays P&L in $ and %, plus market value — verify fields."""
    monkeypatch.setattr(
        daily_summary, "_get_positions",
        lambda cfg: [_equity_pos("F", qty=10, entry=10.0, current=11.0)],
    )
    result = daily_summary._summarize_held_stocks({}, set())
    pos = result["positions"][0]
    assert pos["symbol"]       == "F"
    assert pos["qty"]          == 10.0
    assert pos["entry"]        == 10.0
    assert pos["current"]      == 11.0
    assert pos["market_value"] == 110.0
    assert pos["pnl_dollars"]  == 10.0
    assert pos["pnl_pct"]      == pytest.approx(0.10)


def test_held_returns_empty_when_no_stocks(monkeypatch):
    monkeypatch.setattr(daily_summary, "_get_positions", lambda cfg: [])
    result = daily_summary._summarize_held_stocks({}, set())
    assert result["available"] is True
    assert result["count"] == 0
    assert result["positions"] == []


def test_held_graceful_on_alpaca_error(monkeypatch):
    """Position fetch failure shouldn't crash the daily summary."""
    def _raise(cfg):
        raise RuntimeError("alpaca down")
    monkeypatch.setattr(daily_summary, "_get_positions", _raise)
    result = daily_summary._summarize_held_stocks({}, set())
    assert result["available"] is False
    assert "alpaca down" in result.get("error", "")


def test_held_handles_garbage_numeric_fields(monkeypatch):
    """Malformed Alpaca payload (non-numeric strings) is skipped, not crashed."""
    bad = {
        "symbol":         "ZZZ",
        "asset_class":    "us_equity",
        "qty":            "not-a-number",
        "avg_entry_price": "??",
    }
    monkeypatch.setattr(
        daily_summary, "_get_positions",
        lambda cfg: [bad, _equity_pos("F")],
    )
    result = daily_summary._summarize_held_stocks({}, set())
    assert {p["symbol"] for p in result["positions"]} == {"F"}
