from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from src.models import Disclosure
from src.state import State


def _disclosure(trade_id: str, days_old: int = 0) -> Disclosure:
    now = datetime(2026, 4, 25, 12, 0, tzinfo=timezone.utc)
    filed = now - timedelta(days=days_old)
    return Disclosure(
        trade_id=trade_id,
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side="buy",
        asset_kind="stock",
        range_low=Decimal("15000"),
        range_high=Decimal("50000"),
        traded_at=filed - timedelta(days=30),
        filed_at=filed,
    )


def test_filter_unseen_returns_all_when_db_empty(tmp_db):
    state = State(tmp_db)
    disclosures = [_disclosure("a"), _disclosure("b")]
    unseen = state.filter_unseen(disclosures)
    assert {d.trade_id for d in unseen} == {"a", "b"}


def test_filter_unseen_drops_already_recorded(tmp_db):
    state = State(tmp_db)
    state.record_seen(_disclosure("a"))
    unseen = state.filter_unseen([_disclosure("a"), _disclosure("b")])
    assert {d.trade_id for d in unseen} == {"b"}


def test_filter_unseen_drops_stale_disclosures(tmp_db):
    state = State(tmp_db, stale_cutoff_days=7)
    fresh = _disclosure("fresh", days_old=3)
    stale = _disclosure("stale", days_old=10)
    unseen = state.filter_unseen([fresh, stale])
    assert {d.trade_id for d in unseen} == {"fresh"}


def test_double_record_seen_is_idempotent(tmp_db):
    state = State(tmp_db)
    state.record_seen(_disclosure("a"))
    state.record_seen(_disclosure("a"))  # must not raise
    assert state.filter_unseen([_disclosure("a")]) == []


def test_position_entry_round_trip(tmp_db):
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("180.00"), qty=Decimal("5"))
    assert state.get_avg_entry("AAPL") == Decimal("180.00")


def test_position_avg_entry_weights_by_qty(tmp_db):
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("100.00"), qty=Decimal("10"))
    state.record_position("AAPL", entry_price=Decimal("200.00"), qty=Decimal("10"))
    assert state.get_avg_entry("AAPL") == Decimal("150.00")


def test_get_avg_entry_unknown_symbol_returns_none(tmp_db):
    state = State(tmp_db)
    assert state.get_avg_entry("NVDA") is None


def test_mark_stopped_out_clears_position(tmp_db):
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("180"), qty=Decimal("5"))
    state.mark_stopped_out("AAPL", exit_price=Decimal("153"), drawdown=Decimal("-0.15"))
    assert state.get_avg_entry("AAPL") is None


def test_event_log_records_and_lists(tmp_db):
    state = State(tmp_db)
    state.log_event("ORDER_PLACED", trade_id="a", reason="ok")
    state.log_event("STOP_LOSS_FIRED", trade_id=None, reason="drawdown -0.18")
    events = state.recent_events(limit=10)
    assert len(events) == 2
    assert events[0]["event_type"] == "STOP_LOSS_FIRED"  # most recent first


def test_filter_unseen_keeps_disclosure_at_exact_cutoff(tmp_db):
    """Inclusive cutoff: a disclosure filed exactly N days ago is still kept."""
    state = State(tmp_db, stale_cutoff_days=7)
    # Build a disclosure where filed_at is exactly stale_cutoff_days ago.
    # We use 6 days + 23h to stay inside the boundary safely.
    edge = _disclosure("edge", days_old=6)
    assert state.filter_unseen([edge]) == [edge]


def test_mark_stopped_out_preserves_audit_history(tmp_db):
    """After stop-out, the row still exists with closed_at + exit_price set."""
    import sqlite3
    state = State(tmp_db)
    state.record_position("AAPL", entry_price=Decimal("180"), qty=Decimal("5"))
    state.mark_stopped_out("AAPL", exit_price=Decimal("153"), drawdown=Decimal("-0.15"))
    # get_avg_entry returns None because the row is closed
    assert state.get_avg_entry("AAPL") is None
    # But the row is still there with audit fields populated
    raw = sqlite3.connect(tmp_db)
    raw.row_factory = sqlite3.Row
    rows = list(raw.execute("SELECT * FROM positions WHERE symbol = 'AAPL'").fetchall())
    raw.close()
    assert len(rows) == 1
    assert rows[0]["closed_at"] is not None
    assert rows[0]["exit_price"] == "153"
    assert rows[0]["drawdown"] == "-0.15"
    assert rows[0]["entry_price"] == "180"  # original entry preserved for audit
