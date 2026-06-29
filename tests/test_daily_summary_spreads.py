"""Tests for the daily summary spread-section rendering (Phase 3 of spread support)."""
import json
import pytest

import daily_summary


def _wheel_state_with_spread(tmp_path, mode_state_file: str = "wheel_state_manual.json"):
    """Write a wheel state file containing one spread_active entry + one Stage 1 single."""
    state = {
        "_meta": {"last_checked": "2026-05-14T17:00:00Z"},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0,
                          "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0,
                          "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19",
            "net_credit": 0.22, "max_loss": 0.78, "width": 1.0,
            "opened_at": "2026-05-14T17:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0,
            "cycle_history": [], "last_action": "",
        },
        "BAC": {  # Bare Stage 1 single — must NOT be in the spreads block
            "stage": 1,
            "current_contract": "BAC260522P00050000",
            "contract_entry_price": 0.29,
            "contract_qty": 1,
            "total_premium_collected": 29.0,
            "total_premium_today": 0.0,
            "cycle_count": 1,
            "shares_qty": 0,
        },
    }
    state_file = tmp_path / mode_state_file
    state_file.write_text(json.dumps(state))
    return state_file


def test_summarize_wheel_splits_spreads_from_singles(tmp_path):
    """_summarize_wheel must return both `symbols` (single-leg) and
    `spreads` (spread_active) blocks. A spread_active entry must NOT
    appear under `symbols`."""
    state_file = _wheel_state_with_spread(tmp_path)
    cfg = {"wheel_state_file": str(state_file.name)}
    import daily_summary as ds
    original_root = ds.ROOT
    ds.ROOT = tmp_path
    try:
        result = ds._summarize_wheel(cfg)
    finally:
        ds.ROOT = original_root

    assert result["available"] is True
    assert result["format"] == "multi_stock"
    assert "BAC" in result["symbols"]
    assert "PLTR" not in result["symbols"], "spread_active PLTR must not be in singles"
    assert "spreads" in result
    assert "PLTR" in result["spreads"]
    pltr = result["spreads"]["PLTR"]
    assert pltr["spread_type"] == "put_credit"
    assert pltr["short_strike"] == 8.0
    assert pltr["long_strike"] == 7.0
    assert pltr["net_credit"] == 0.22
    assert pltr["max_loss"] == 0.78
    assert pltr["expiration"] == "2026-06-19"
    assert pltr["short_occ"] == "PLTR260619P00008000"
    assert pltr["long_occ"]  == "PLTR260619P00007000"


def test_summarize_wheel_with_no_spreads_returns_empty_spreads(tmp_path):
    """When state has zero spread_active entries, the spreads block is {}."""
    state = {
        "_meta": {},
        "BAC": {
            "stage": 1, "current_contract": "BAC260522P00050000",
            "contract_entry_price": 0.29, "contract_qty": 1,
            "total_premium_collected": 29.0, "total_premium_today": 0.0,
            "cycle_count": 1, "shares_qty": 0,
        },
    }
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(state))
    cfg = {"wheel_state_file": str(state_file.name)}
    import daily_summary as ds
    original_root = ds.ROOT
    ds.ROOT = tmp_path
    try:
        result = ds._summarize_wheel(cfg)
    finally:
        ds.ROOT = original_root

    assert result["spreads"] == {}


def test_summarize_long_options_excludes_wheel_spread_legs(monkeypatch):
    """The long hedge leg of a spread must NOT appear in the long-options
    listing — it's already shown inside the spread row. Real bug caught
    2026-05-14: AAL $11.50 long put double-rendered both in 'Open Spreads'
    AND as a standalone 'Long Options' position with -$2.00 P&L."""
    monkeypatch.setattr(daily_summary, "_get_positions", lambda cfg: [
        # Long leg of an AAL spread — should be excluded
        {"symbol": "AAL260529P00011500", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "0.12",
         "current_price": "0.10", "market_value": "10"},
        # Unrelated genuine long option — should remain
        {"symbol": "NVDA260620C00500000", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "5.20",
         "current_price": "6.50", "market_value": "650"},
    ])
    result = daily_summary._summarize_long_options(
        {}, exclude_occs={"AAL260529P00011500"}
    )
    assert result["count"] == 1
    assert result["positions"][0]["symbol"] == "NVDA260620C00500000"


def test_summarize_long_options_with_no_exclusion_keeps_all_longs(monkeypatch):
    """Backwards-compat: omitting exclude_occs (or passing None / empty set)
    keeps the previous behavior of listing every long option."""
    monkeypatch.setattr(daily_summary, "_get_positions", lambda cfg: [
        {"symbol": "NVDA260620C00500000", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "5.20",
         "current_price": "6.50", "market_value": "650"},
    ])
    assert daily_summary._summarize_long_options({})["count"] == 1
    assert daily_summary._summarize_long_options({}, exclude_occs=set())["count"] == 1


def test_fetch_spread_pnl_for_summary_computes_correctly(monkeypatch):
    """For a put credit spread: short_mid - long_mid = current_value,
    (net_credit - current_value) / net_credit = profit_pct."""
    spread = {
        "short_occ": "PLTR260619P00008000",
        "long_occ":  "PLTR260619P00007000",
        "net_credit": 0.22,
        "max_loss":   0.78,
        "short_qty":  1,
    }
    quotes = {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},  # mid 0.18
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},  # mid 0.07
    }
    # current_value = 0.18 - 0.07 = 0.11, profit_pct = (0.22 - 0.11) / 0.22 = 0.50
    result = daily_summary._fetch_spread_pnl_for_summary(spread, quote_fn=lambda occ: quotes[occ])
    assert result["current_value"] == pytest.approx(0.11)
    assert result["profit_pct"] == pytest.approx(0.50)
    assert result["pnl_dollars"] == pytest.approx(11.0)


def test_fetch_spread_pnl_for_summary_handles_missing_quote():
    """If either quote is None (no live quote), helper returns Nones."""
    spread = {
        "short_occ": "PLTR260619P00008000",
        "long_occ":  "PLTR260619P00007000",
        "net_credit": 0.22,
        "max_loss":   0.78,
        "short_qty":  1,
    }
    result = daily_summary._fetch_spread_pnl_for_summary(
        spread, quote_fn=lambda occ: None if occ.endswith("P00008000") else {"bid": 0.06, "ask": 0.08}
    )
    assert result["current_value"] is None
    assert result["profit_pct"] is None
    assert result["pnl_dollars"] is None


def test_embed_renders_spread_section(monkeypatch, tmp_path):
    """When wheel state has one spread_active entry, the daily summary
    embed includes a 'Wheel — Open Spreads' field with the spread details
    and live P&L."""
    state = {
        "_meta": {},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0,
                          "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0,
                          "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19",
            "net_credit": 0.22, "max_loss": 0.78, "width": 1.0,
            "opened_at": "2026-05-14T17:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0,
            "cycle_history": [], "last_action": "",
        },
    }
    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps(state))

    import daily_summary as ds
    monkeypatch.setattr(ds, "ROOT", tmp_path)
    monkeypatch.setattr(ds, "_get_account", lambda cfg: {"cash": "10000", "equity": "10000", "portfolio_value": "10000"})
    monkeypatch.setattr(ds, "_get_positions", lambda cfg: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    monkeypatch.setattr(ds, "_summarize_strategy", lambda cfg: {"available": False})
    monkeypatch.setattr(ds, "_summarize_long_options", lambda cfg, exclude_occs=None: {"available": False, "count": 0})
    monkeypatch.setattr(ds, "_summarize_held_stocks", lambda cfg, tracked: {"available": False})
    import wheel_strategy
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda occ: {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},
    }[occ])

    captured = {}
    monkeypatch.setattr(ds, "send_embed",
                        lambda ch, title, **kw: captured.update({"title": title, **kw}))

    import config
    config.MODES["manual"]["wheel_state_file"] = "wheel_state_manual.json"

    ds.run_daily_summary("manual")

    fields = captured.get("fields", [])
    spread_field = next((f for f in fields if "spread" in f["name"].lower()), None)
    assert spread_field is not None, "no 'Open Spreads' field found in embed"
    value = spread_field["value"]
    assert "PLTR" in value
    assert "$8" in value or "8.00" in value
    assert "$7" in value or "7.00" in value
    assert "50%" in value or "50.0%" in value or "0.50" in value, \
        "expected 50% profit displayed for spread at half credit"
