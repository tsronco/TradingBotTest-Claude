"""R2 — drift reconciliation must re-baseline the trail on an average-down.

When the user manually adds shares at a lower price (averages down), the drift
reconciliation in _manual_run_symbol used to reset qty/avg/stop but leave a
stale (higher) high_water_mark + trailing_active. The trailing block (which
only ever RAISES the stop) would then snap the stop back above the new cost
basis and liquidate the shares the user just added. Now an average-down
re-baselines the trail; an average-up keeps its ratcheted trail.
"""
import pytest

import config
import strategy as strat


@pytest.fixture
def manual_mode():
    strat.apply_mode("manual")
    yield
    strat.apply_mode(config.DEFAULT_MODE)


def _wire(monkeypatch, price):
    monkeypatch.setattr(strat, "get_latest_price", lambda s: price)
    monkeypatch.setattr(strat, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(strat, "log_event", lambda *a, **k: None)
    orders = []
    monkeypatch.setattr(strat, "place_order",
                        lambda *a, **k: orders.append(a) or {"id": "o"})
    return orders


def _state(avg=15.0, qty=10, stop=14.25, hwm=20.0, trailing=True):
    return {
        "entry_price": avg, "avg_cost": avg, "position_qty": qty,
        "total_cost": avg * qty, "stop_price": stop,
        "high_water_mark": hwm, "trailing_active": trailing,
        "initial_qty": qty, "ladder_done": [False, False, False],
    }


def test_average_down_does_not_spuriously_stop(monkeypatch, manual_mode):
    # Old trailing stop $14.25 (from HWM $20). User averages down to $12 over 20
    # shares. Price $11.50 is above the new 10%-stop ($10.80) but below the old
    # trailing stop — pre-fix that would have stopped out.
    sym_state = _state(avg=15.0, qty=10, stop=14.25, hwm=20.0, trailing=True)
    orders = _wire(monkeypatch, price=11.5)

    out = strat._manual_run_symbol("SNAP", sym_state, alpaca_qty=20, alpaca_avg_cost=12.0)

    assert orders == []                              # NOT spuriously stopped out
    assert out["trailing_active"] is False           # trail re-baselined
    assert out["high_water_mark"] == 12.0
    assert out["entry_price"] == 12.0
    assert out["stop_price"] == pytest.approx(10.8)  # 12 × (1 - 0.10)
    assert out["position_qty"] == 20


def test_average_up_keeps_trailing_ratchet(monkeypatch, manual_mode):
    # Averaging UP (15 → 16) must NOT reset the trail — that would give back a
    # locked-in gain. The trailing stop keeps ratcheting on the new high.
    sym_state = _state(avg=15.0, qty=10, stop=19.0, hwm=20.0, trailing=True)
    orders = _wire(monkeypatch, price=21.0)

    out = strat._manual_run_symbol("SNAP", sym_state, alpaca_qty=20, alpaca_avg_cost=16.0)

    assert orders == []
    assert out["trailing_active"] is True            # preserved
    assert out["high_water_mark"] == 21.0            # ratcheted up on the new high
    assert out["stop_price"] == pytest.approx(19.95)  # 21 × (1 - 0.05)


def test_no_drift_leaves_trail_untouched(monkeypatch, manual_mode):
    # Same qty/avg → no reconciliation branch; trail state is preserved.
    sym_state = _state(avg=15.0, qty=10, stop=19.0, hwm=20.0, trailing=True)
    orders = _wire(monkeypatch, price=21.0)

    out = strat._manual_run_symbol("SNAP", sym_state, alpaca_qty=10, alpaca_avg_cost=15.0)

    assert out["trailing_active"] is True
    assert out["high_water_mark"] == 21.0  # still trails up on the new high


def test_initial_qty_rebaselines_when_position_grows(monkeypatch, manual_mode):
    """R20: when the managed (free) share count grows — e.g. covered-call
    collateral released back to freely-sellable — initial_qty re-baselines so
    ladder sizing scales to the real position, not the stale starting count."""
    sym_state = {
        "entry_price": 15.0, "avg_cost": 15.0, "position_qty": 10,
        "total_cost": 150.0, "stop_price": 13.5,
        "high_water_mark": 15.0, "trailing_active": False,
        "initial_qty": 10, "ladder_done": [False, False, False],
    }
    orders = _wire(monkeypatch, price=14.5)  # above stop, below entry → no action
    out = strat._manual_run_symbol("SNAP", sym_state, alpaca_qty=110, alpaca_avg_cost=15.0)
    assert out["initial_qty"] == 110  # re-baselined to the real managed position
    assert out["position_qty"] == 110
    assert orders == []
