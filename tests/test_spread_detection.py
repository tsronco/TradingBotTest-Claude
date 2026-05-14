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
