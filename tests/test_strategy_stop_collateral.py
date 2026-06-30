"""R31 — conservative/aggressive stop must not naked a covered call.

run_one_cycle's stop used close_all(SYMBOL) (DELETE /positions/{sym}), which
liquidates EVERY share including those locked as covered-call collateral
(wheel stage 2) — leaving a naked short call (unlimited risk). The stop now
sells only the freely-available shares via a bounded sell order, mirroring the
manual path, and holds (alerts) when every share is CC collateral.
"""
import pytest

import config
import strategy as strat


def _stop_state(qty=10, avg=100.0, stop=95.0):
    return {
        "entry_price": avg, "avg_cost": avg, "position_qty": qty,
        "total_cost": avg * qty, "stop_price": stop,
        "high_water_mark": avg, "trailing_active": False,
        "ladder_1_done": False, "ladder_2_done": False, "ladder_3_done": False,
    }


@pytest.fixture
def cons_mode():
    strat.apply_mode("manual")
    yield
    strat.apply_mode(config.DEFAULT_MODE)


def _wire(monkeypatch, state, positions, price):
    monkeypatch.setattr(strat, "_load_state", lambda: state)
    monkeypatch.setattr(strat, "_save_state", lambda s: None)
    monkeypatch.setattr(strat, "get_latest_price", lambda s: price)
    monkeypatch.setattr(strat, "get_stock_positions", lambda: positions)
    monkeypatch.setattr(strat, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(strat, "log_event", lambda *a, **k: None)
    orders = []
    monkeypatch.setattr(strat, "place_order",
                        lambda *a, **k: orders.append(a) or {"id": "o"})
    closed = []
    monkeypatch.setattr(strat, "close_all", lambda s: closed.append(s))
    return orders, closed


def test_stop_normal_sells_all_free_no_close_all(monkeypatch, cons_mode):
    state = _stop_state(qty=10, stop=95.0)
    positions = [{"symbol": "TSLA", "qty": "10", "qty_available": "10",
                  "avg_entry_price": "100"}]
    orders, closed = _wire(monkeypatch, state, positions, price=90.0)
    strat.run_one_cycle()
    assert orders == [("TSLA", 10, "sell")]
    assert closed == []                    # never DELETE the whole position
    assert state["position_qty"] == 0


def test_stop_blocked_when_all_shares_are_cc_collateral(monkeypatch, cons_mode):
    state = _stop_state(qty=10, stop=95.0)
    # 110 held, 0 free → all locked as covered-call collateral
    positions = [{"symbol": "TSLA", "qty": "110", "qty_available": "0",
                  "avg_entry_price": "100"}]
    orders, closed = _wire(monkeypatch, state, positions, price=90.0)
    strat.run_one_cycle()
    assert orders == []                    # nothing sold
    assert closed == []                    # CC stays covered
    assert state["position_qty"] == 10     # state unchanged


def test_stop_sells_only_free_portion(monkeypatch, cons_mode):
    state = _stop_state(qty=50, stop=95.0)
    # 150 held, only 30 free (120 locked under CCs)
    positions = [{"symbol": "TSLA", "qty": "150", "qty_available": "30",
                  "avg_entry_price": "100"}]
    orders, closed = _wire(monkeypatch, state, positions, price=90.0)
    strat.run_one_cycle()
    assert orders == [("TSLA", 30, "sell")]
    assert closed == []
    assert state["position_qty"] == 20     # 50 tracked − 30 sold


def test_run_one_cycle_skips_incomplete_state(monkeypatch, cons_mode):
    """R27: a state file missing avg_cost must skip the cycle gracefully, not
    raise KeyError and crash into #errors."""
    monkeypatch.setattr(strat, "_load_state",
                        lambda: {"position_qty": 10, "entry_price": 100.0})  # no avg_cost
    monkeypatch.setattr(strat, "_save_state", lambda s: None)
    monkeypatch.setattr(strat, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(strat, "log_event", lambda *a, **k: None)
    orders = []
    monkeypatch.setattr(strat, "place_order", lambda *a, **k: orders.append(a))
    monkeypatch.setattr(strat, "get_latest_price", lambda s: 90.0)
    strat.run_one_cycle()  # must not raise
    assert orders == []
