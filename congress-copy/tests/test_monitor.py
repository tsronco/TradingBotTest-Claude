from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from src.models import FillResult, Position
from src.monitor import Monitor


def _position(symbol: str, current: str, entry: str) -> Position:
    return Position(
        symbol=symbol,
        qty=Decimal("5"),
        avg_entry_price=Decimal(entry),
        current_price=Decimal(current),
        market_value=Decimal(current) * Decimal(5),
        unrealized_pl_pct=(Decimal(current) - Decimal(entry)) / Decimal(entry),
    )


def test_monitor_no_op_when_market_closed(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = False
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["checked"] == 0
    alpaca.list_positions.assert_not_called()


def test_monitor_stops_out_position_below_threshold(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("100"), qty=Decimal("5"))
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    alpaca.list_positions.return_value = [_position("AAPL", current="80", entry="100")]
    alpaca.close_position.return_value = FillResult(order_id="x", status="pending")
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["stopped_out"] == 1
    alpaca.close_position.assert_called_once_with("AAPL")
    assert state.get_avg_entry("AAPL") is None


def test_monitor_does_not_stop_out_above_threshold(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("100"), qty=Decimal("5"))
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    alpaca.list_positions.return_value = [_position("AAPL", current="90", entry="100")]
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["stopped_out"] == 0
    alpaca.close_position.assert_not_called()


def test_monitor_uses_state_avg_entry_when_available(tmp_db, paper_env):
    """If our state DB has a different cost basis (e.g. multiple buys), trust it."""
    from src.state import State
    state = State(tmp_db)
    # Two buys: avg = 150
    state.record_position("AAPL", entry_price=Decimal("100"), qty=Decimal("10"))
    state.record_position("AAPL", entry_price=Decimal("200"), qty=Decimal("10"))
    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    # Alpaca shows 150 cost, current 130 → -13.3% drawdown, NOT stopped out
    alpaca.list_positions.return_value = [_position("AAPL", current="130", entry="150")]
    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()
    assert summary["stopped_out"] == 0


def test_monitor_continues_after_one_position_errors(tmp_db, paper_env):
    """One bad symbol must not prevent stop-loss enforcement on others."""
    from src.state import State
    state = State(tmp_db)
    state.record_position("BAD", entry_price=Decimal("100"), qty=Decimal("1"))
    state.record_position("GOOD", entry_price=Decimal("100"), qty=Decimal("1"))

    alpaca = MagicMock()
    alpaca.is_market_open.return_value = True
    alpaca.list_positions.return_value = [
        _position("BAD", current="80", entry="100"),   # would trigger stop
        _position("GOOD", current="79", entry="100"),  # would trigger stop
    ]

    # close_position raises on BAD, succeeds on GOOD
    def close_side_effect(symbol):
        if symbol == "BAD":
            raise RuntimeError("simulated network error")
        return FillResult(order_id="ok", status="pending")

    alpaca.close_position.side_effect = close_side_effect

    monitor = Monitor(state=state, alpaca=alpaca)
    summary = monitor.run_monitor_cycle()

    assert summary["checked"] == 2
    assert summary["stopped_out"] == 1   # GOOD got closed
    assert summary["errors"] == 1        # BAD logged an error
    # Both close_position calls were attempted
    assert alpaca.close_position.call_count == 2
    events = state.recent_events()
    assert any(e["event_type"] == "MONITOR_POSITION_ERROR" for e in events)
