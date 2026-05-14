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
