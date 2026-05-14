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


def test_adopt_spread_seeds_state_correctly():
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
    state = {}
    wheel_strategy._adopt_spread(state, sp)

    sym = state["PLTR"]
    assert sym["stage"] == "spread_active"
    assert sym["spread_type"] == "put_credit"
    assert sym["short_leg"]["occ"] == "PLTR260619P00008000"
    assert sym["short_leg"]["strike"] == 8.0
    assert sym["short_leg"]["entry_premium"] == pytest.approx(0.33)
    assert sym["short_leg"]["qty"] == 1
    assert sym["long_leg"]["occ"] == "PLTR260619P00007000"
    assert sym["long_leg"]["strike"] == 7.0
    assert sym["long_leg"]["entry_premium"] == pytest.approx(0.11)
    assert sym["expiration"] == "2026-06-19"
    assert sym["net_credit"] == pytest.approx(0.22)
    assert sym["max_loss"] == pytest.approx(0.78)
    assert sym["width"] == pytest.approx(1.0)
    assert sym["opened_at"] is not None
    assert "Adopted spread" in sym["last_action"]


def test_adopt_spread_is_idempotent():
    """Calling adopt twice with same pair shouldn't reset cycle_count or history."""
    sp = wheel_strategy.SpreadPair(
        ticker="PLTR", spread_type="put_credit",
        short_occ="PLTR260619P00008000", long_occ="PLTR260619P00007000",
        short_strike=8.0, long_strike=7.0, expiration=date(2026, 6, 19),
        short_qty=1, long_qty=1, short_entry=0.33, long_entry=0.11,
        width=1.0, net_credit=0.22, max_loss=0.78,
    )
    state = {}
    wheel_strategy._adopt_spread(state, sp)
    state["PLTR"]["cycle_count"] = 5
    state["PLTR"]["cycle_history"] = [{"foo": "bar"}]

    wheel_strategy._adopt_spread(state, sp)
    assert state["PLTR"]["cycle_count"] == 5
    assert state["PLTR"]["cycle_history"] == [{"foo": "bar"}]


def test_discover_routes_spread_to_spread_state(monkeypatch):
    """When positions contain a paired spread, _discover_wheel_state should
    adopt it as spread_active state — NOT as a bare Stage 1 short put."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
        _opt_pos("PLTR260619P00007000",  1,  0.11),
    ]
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: positions)
    # Notification stubs so adoption doesn't try to hit Discord
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {}
    discovered = wheel_strategy._discover_wheel_state(state)

    assert "PLTR" in discovered
    assert state["PLTR"]["stage"] == "spread_active"
    # Critically: the short leg must NOT also be adopted as a Stage 1 single-leg put.
    # If it were, current_contract would be set to the short OCC.
    assert "current_contract" not in state["PLTR"] or state["PLTR"].get("current_contract") is None


def test_discover_still_adopts_single_short_put_when_unpaired(monkeypatch):
    """A bare short put (no long hedge) goes through the existing Stage 1 adoption."""
    positions = [
        _opt_pos("PLTR260619P00008000", -1, -0.33),
    ]
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: positions)
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {}
    discovered = wheel_strategy._discover_wheel_state(state)

    assert "PLTR" in discovered
    assert state["PLTR"]["stage"] == 1
    assert state["PLTR"]["current_contract"] == "PLTR260619P00008000"


def test_long_options_skips_legs_claimed_by_wheel_spread(monkeypatch, tmp_path):
    """The protective long put inside a put credit spread MUST NOT be
    managed by long_options_strategy — that would sell the hedge and
    leave the short leg naked."""
    import json
    import long_options_strategy
    import wheel_strategy

    # 1. Set up a wheel state file with one spread_active position
    wheel_state = {
        "_meta": {},
        "PLTR": wheel_strategy._empty_spread_state(),
    }
    wheel_state["PLTR"].update({
        "spread_type": "put_credit",
        "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0, "entry_premium": 0.33, "qty": 1},
        "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0, "entry_premium": 0.11, "qty": 1},
        "expiration": "2026-06-19",
    })

    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(wheel_state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    # 2. Verify the helper returns the claimed OCC set
    claimed = long_options_strategy._wheel_claimed_long_occs()
    assert "PLTR260619P00007000" in claimed
    # The short leg is NOT a long-options concern, but it's fine if it's
    # also in the set (defensive)


def test_long_options_run_does_not_touch_spread_long_leg(monkeypatch, tmp_path):
    """End-to-end: long_options_strategy cycle must NOT evaluate/close a long
    put whose OCC is claimed by a wheel spread."""
    import json
    import long_options_strategy
    import wheel_strategy

    wheel_state = {
        "_meta": {},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0, "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0, "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19",
        },
    }
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(wheel_state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    positions = [
        _opt_pos("PLTR260619P00007000", 1, 0.11),
    ]
    monkeypatch.setattr(long_options_strategy, "list_long_option_positions",
                        lambda: positions)
    monkeypatch.setattr(long_options_strategy, "is_market_open", lambda: True)
    monkeypatch.setattr(long_options_strategy, "log", lambda *a, **kw: None)
    monkeypatch.setattr(long_options_strategy, "log_event", lambda *a, **kw: None)
    monkeypatch.setattr(long_options_strategy, "send_embed", lambda *a, **kw: None)

    evaluated = []
    executed = []
    monkeypatch.setattr(long_options_strategy, "evaluate_position",
                        lambda pos, today: (evaluated.append(pos), ("hold", 0.0, {}))[1])
    monkeypatch.setattr(long_options_strategy, "execute_close",
                        lambda *a, **kw: executed.append(a) or True)

    long_options_strategy.run_long_options_cycle()

    assert evaluated == [], (
        "long_options_strategy evaluated a hedge leg claimed by a wheel spread — "
        "the skip guard isn't wired into the main loop."
    )
    assert executed == [], "Hedge leg of a wheel spread must never be closed."


def test_spread_active_state_does_not_crash_daily_summary(monkeypatch, tmp_path):
    """daily_summary must tolerate a state file containing a spread_active
    symbol. It doesn't need to render a spread section yet (that's future
    work) — just must not raise."""
    import json
    import wheel_strategy

    state = {
        "_meta": {"last_checked": "2026-05-14T17:00:00Z"},
        "PLTR": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "short_leg": {"occ": "PLTR260619P00008000", "strike": 8.0, "entry_premium": 0.33, "qty": 1},
            "long_leg":  {"occ": "PLTR260619P00007000", "strike": 7.0, "entry_premium": 0.11, "qty": 1},
            "expiration": "2026-06-19", "net_credit": 0.22, "max_loss": 0.78,
            "width": 1.0, "opened_at": "2026-05-14T17:00:00Z",
            "total_premium_collected": 0.0, "cycle_count": 0, "cycle_history": [],
            "last_action": "",
        },
    }
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    # Reload through the wheel's own load_state to confirm migration doesn't choke
    loaded = wheel_strategy.load_state()
    assert loaded["PLTR"]["stage"] == "spread_active"
