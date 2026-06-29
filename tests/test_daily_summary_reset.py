"""Tests for daily_summary.py --reset-counters logic.

The reset code in wheel_strategy.run_daily_summary() (lines 1454-1457) never
fires in production because daily-summary.yml runs `python daily_summary.py`,
not `python wheel_strategy.py summary`. The result was Discord embeds where
"Premium today" permanently equalled "Total premium" — the daily counter was
never zeroed.

These tests cover the new --reset-counters flag on daily_summary.py:
  - Zeros total_premium_today for every symbol (multi-stock format)
  - Leaves total_premium_collected (lifetime) untouched
  - Handles legacy single-stock format
  - Skips underscore-prefixed keys (e.g. _meta) and non-dict values
  - Without the flag, the reset helper is never called (protects local
    manual runs like `python daily_summary.py --mode conservative` on
    Tim's laptop)
"""
import json

import pytest

import daily_summary


def _write_state(path, data):
    path.write_text(json.dumps(data))


def _multi_stock_state():
    return {
        "_meta": {"version": 2, "last_save": "2026-05-13"},
        "TSLA": {
            "stage": 1,
            "total_premium_collected": 1500.0,
            "total_premium_today": 225.0,
            "cycle_count": 5,
        },
        "NVDA": {
            "stage": 2,
            "total_premium_collected": 800.0,
            "total_premium_today": 82.0,
            "cycle_count": 3,
        },
        "XOM": {
            "stage": 1,
            "total_premium_collected": 1206.0,
            "total_premium_today": 67.0,
            "cycle_count": 4,
        },
    }


@pytest.fixture
def state_in_tmp(tmp_path, monkeypatch):
    """Redirect daily_summary.ROOT so the helper reads/writes inside tmp_path."""
    monkeypatch.setattr(daily_summary, "ROOT", tmp_path)
    return tmp_path


# ── _reset_wheel_today_counters helper ────────────────────────────────────


def test_reset_zeroes_today_in_multi_stock(state_in_tmp):
    """Every symbol's total_premium_today gets set to 0.0."""
    state_path = state_in_tmp / "wheel_state.json"
    _write_state(state_path, _multi_stock_state())

    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})

    updated = json.loads(state_path.read_text())
    for sym in ("TSLA", "NVDA", "XOM"):
        assert updated[sym]["total_premium_today"] == 0.0, \
            f"{sym} total_premium_today should be 0.0 after reset"


def test_reset_preserves_lifetime_premium(state_in_tmp):
    """total_premium_collected (lifetime) must NOT be modified by reset."""
    state_path = state_in_tmp / "wheel_state.json"
    _write_state(state_path, _multi_stock_state())

    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})

    updated = json.loads(state_path.read_text())
    assert updated["TSLA"]["total_premium_collected"] == 1500.0
    assert updated["NVDA"]["total_premium_collected"] == 800.0
    assert updated["XOM"]["total_premium_collected"] == 1206.0


def test_reset_preserves_other_symbol_fields(state_in_tmp):
    """Reset only touches total_premium_today — stage, cycle_count, etc. survive."""
    state_path = state_in_tmp / "wheel_state.json"
    _write_state(state_path, _multi_stock_state())

    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})

    updated = json.loads(state_path.read_text())
    assert updated["TSLA"]["stage"] == 1
    assert updated["TSLA"]["cycle_count"] == 5
    assert updated["NVDA"]["stage"] == 2
    assert updated["NVDA"]["cycle_count"] == 3


def test_reset_handles_legacy_single_stock(state_in_tmp):
    """Legacy top-level format (conservative pre-multistock) also gets reset."""
    state_path = state_in_tmp / "wheel_state.json"
    _write_state(state_path, {
        "stage": 2,
        "current_contract": "TSLA250620C00280000",
        "total_premium_collected": 4200.0,
        "total_premium_today": 300.0,
        "cycle_count": 10,
        "cost_basis_per_share": 250.0,
    })

    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})

    updated = json.loads(state_path.read_text())
    assert updated["total_premium_today"] == 0.0
    assert updated["total_premium_collected"] == 4200.0
    assert updated["stage"] == 2
    assert updated["current_contract"] == "TSLA250620C00280000"
    assert updated["cycle_count"] == 10


def test_reset_skips_underscore_keys(state_in_tmp):
    """_meta and any other underscore-prefixed top-level keys must not be mutated."""
    state_path = state_in_tmp / "wheel_state.json"
    state = _multi_stock_state()
    state["_lock"] = "held"
    state["_version_counter"] = 42
    _write_state(state_path, state)

    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})

    updated = json.loads(state_path.read_text())
    assert updated["_meta"] == {"version": 2, "last_save": "2026-05-13"}
    assert updated["_lock"] == "held"
    assert updated["_version_counter"] == 42


def test_reset_skips_non_dict_top_level_values(state_in_tmp):
    """Stray non-dict top-level values shouldn't crash the reset."""
    state_path = state_in_tmp / "wheel_state.json"
    state = _multi_stock_state()
    state["stray_scalar"] = 99.9
    _write_state(state_path, state)

    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})

    updated = json.loads(state_path.read_text())
    assert updated["stray_scalar"] == 99.9
    assert updated["TSLA"]["total_premium_today"] == 0.0


def test_reset_noop_when_state_file_missing(state_in_tmp):
    """Missing state file → silent no-op, no crash, no file created."""
    daily_summary._reset_wheel_today_counters({"wheel_state_file": "wheel_state.json"})
    assert not (state_in_tmp / "wheel_state.json").exists()


# ── run_daily_summary dispatch ────────────────────────────────────────────


def _stub_summary_dependencies(monkeypatch):
    """Stub out all external dependencies of run_daily_summary so tests can
    exercise the reset_counters branch without hitting Alpaca/Discord/disk."""
    monkeypatch.setattr(daily_summary, "_get_account",
                        lambda cfg: {"cash": "0", "portfolio_value": "0", "equity": "0"})
    monkeypatch.setattr(daily_summary, "_summarize_strategy",
                        lambda cfg: {"available": False})
    monkeypatch.setattr(daily_summary, "_summarize_wheel",
                        lambda cfg: {"available": False})
    monkeypatch.setattr(daily_summary, "_summarize_long_options",
                        lambda cfg, exclude_occs=None: {"available": False, "count": 0})
    monkeypatch.setattr(daily_summary, "_summarize_held_stocks",
                        lambda cfg, tracked: {"available": False, "count": 0})
    monkeypatch.setattr(daily_summary, "send_embed",
                        lambda *a, **kw: None)
    monkeypatch.setattr(daily_summary, "log_event",
                        lambda *a, **kw: None)


def test_run_daily_summary_invokes_reset_when_flag_set(state_in_tmp, monkeypatch):
    """run_daily_summary(..., reset_counters=True) must call the reset helper."""
    calls = []
    monkeypatch.setattr(daily_summary, "_reset_wheel_today_counters",
                        lambda cfg: calls.append(cfg))
    _stub_summary_dependencies(monkeypatch)

    daily_summary.run_daily_summary("manual", reset_counters=True)
    assert len(calls) == 1, "reset must fire exactly once when flag is True"


def test_run_daily_summary_skips_reset_by_default(state_in_tmp, monkeypatch):
    """Without the flag, the helper is never called.

    Protects local invocations: `python daily_summary.py --mode conservative`
    on Tim's laptop should be a pure read of the state, never a write.
    """
    calls = []
    monkeypatch.setattr(daily_summary, "_reset_wheel_today_counters",
                        lambda cfg: calls.append(cfg))
    _stub_summary_dependencies(monkeypatch)

    daily_summary.run_daily_summary("manual")
    assert calls == [], "reset must NOT fire when flag is omitted"

    daily_summary.run_daily_summary("manual", reset_counters=False)
    assert calls == [], "reset must NOT fire when flag is False"
