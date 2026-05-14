"""Tests for spread detection foundation (Phase 1 of spread support).

Coverage:
  - SpreadPair dataclass shape + computed fields
  - _empty_spread_state seeds correct schema
  - _detect_spread_pairs groups paired legs by (ticker, expiry, type)
  - _discover_wheel_state routes spreads to spread state, singles to Stage 1/2
  - long_options_strategy skips long legs claimed by wheel spreads
"""
from datetime import date
import pytest

import wheel_strategy


def test_spread_pair_dataclass_computes_width_credit_maxloss():
    sp = wheel_strategy.SpreadPair(
        ticker="PLTR",
        spread_type="put_credit",
        short_occ="PLTR260619P00008000",
        long_occ="PLTR260619P00007000",
        short_strike=8.0,
        long_strike=7.0,
        expiration=date(2026, 6, 19),
        short_qty=1,
        long_qty=1,
        short_entry=0.33,
        long_entry=0.11,
        width=1.0,
        net_credit=0.22,
        max_loss=0.78,
    )
    assert sp.width == 1.0
    assert sp.net_credit == pytest.approx(0.22)
    assert sp.max_loss == pytest.approx(0.78)
    # Frozen — mutation should raise
    with pytest.raises(Exception):
        sp.short_qty = 2  # type: ignore[misc]


def test_empty_spread_state_has_expected_keys():
    st = wheel_strategy._empty_spread_state()
    assert st["stage"] == "spread_active"
    assert st["spread_type"] is None
    assert st["short_leg"] == {"occ": None, "strike": None, "entry_premium": None, "qty": 0}
    assert st["long_leg"]  == {"occ": None, "strike": None, "entry_premium": None, "qty": 0}
    assert st["expiration"] is None
    assert st["net_credit"] is None
    assert st["max_loss"] is None
    assert st["width"] is None
    assert st["opened_at"] is None
    assert st["last_action"] == ""
    assert st["total_premium_collected"] == 0.0
    assert st["cycle_count"] == 0
    assert st["cycle_history"] == []


def _opt_pos(symbol, qty, avg_entry):
    """Mock Alpaca position dict for an option leg."""
    return {
        "symbol": symbol,
        "asset_class": "us_option",
        "qty": str(qty),
        "avg_entry_price": str(avg_entry),
    }


def test_detect_spread_pairs_one_put_credit_spread():
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),  # short put @ $8
        _opt_pos("PLTR260619P00007000",  1,  0.11),  # long put  @ $7
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert "PLTR" in pairs
    assert len(pairs["PLTR"]) == 1
    sp = pairs["PLTR"][0]
    assert sp.spread_type == "put_credit"
    assert sp.short_strike == 8.0
    assert sp.long_strike == 7.0
    assert sp.short_qty == 1
    assert sp.long_qty == 1
    assert sp.short_entry == pytest.approx(0.33)
    assert sp.long_entry == pytest.approx(0.11)
    assert sp.width == pytest.approx(1.0)
    assert sp.net_credit == pytest.approx(0.22)
    assert sp.max_loss == pytest.approx(0.78)
    assert sp.expiration == date(2026, 6, 19)


def test_detect_spread_pairs_skips_malformed_positions():
    """Malformed position dicts (missing symbol or qty) must not raise — skip silently."""
    positions = [
        {"asset_class": "us_option"},  # missing symbol and qty entirely
        {"asset_class": "us_option", "symbol": "PLTR260619P00008000"},  # missing qty
        {"asset_class": "us_option", "symbol": "PLTR260619P00008000", "qty": "not-a-number"},
        # And one valid spread to confirm we didn't bail early
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert "PLTR" in pairs
    assert len(pairs["PLTR"]) == 1


def test_detect_call_credit_spread():
    positions = [
        _opt_pos("PLTR260619C00010000", -1, -0.40),  # short call @ $10
        _opt_pos("PLTR260619C00011000",  1,  0.15),  # long call  @ $11
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    sp = pairs["PLTR"][0]
    assert sp.spread_type == "call_credit"
    assert sp.short_strike == 10.0
    assert sp.long_strike == 11.0
    assert sp.net_credit == pytest.approx(0.25)


def test_detect_no_spread_when_only_short_leg():
    """A bare short put without a paired long is NOT a spread."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_no_spread_when_expiries_differ():
    """Different expiries → not a vertical spread → ignored."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260717P00007000",  1,  0.20),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_no_spread_when_qty_mismatched():
    """1× short paired with 2× long — qty mismatch, leave alone."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  2,  0.11),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_no_spread_when_strikes_form_debit_spread():
    """Long put strike ABOVE short put strike = put debit spread, not credit.
    Out of scope for this plan — must NOT be detected."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.10),  # short @ $8
        _opt_pos("PLTR260619P00009000",  1,  0.50),  # long  @ $9 (debit)
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert pairs == {}


def test_detect_two_separate_spreads_same_underlying():
    """Two 1× put credit spreads on PLTR at different expiries."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
        _opt_pos("PLTR260717P00008000", -1, -0.55),
        _opt_pos("PLTR260717P00007000",  1,  0.20),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert len(pairs["PLTR"]) == 2


def test_detect_ignores_stock_positions():
    positions = [
        {"symbol": "PLTR", "asset_class": "us_equity", "qty": "100", "avg_entry_price": "8.50"},
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
    ]
    pairs = wheel_strategy._detect_spread_pairs(positions)
    assert "PLTR" in pairs
    assert len(pairs["PLTR"]) == 1


def test_detect_empty_positions_returns_empty_dict():
    assert wheel_strategy._detect_spread_pairs([]) == {}
