from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from src.models import Disclosure, FillResult, OrderIntent
from src.trader import Trader


def _stock_disclosure(trade_id: str = "t1", side: str = "buy",
                      range_high: str = "50000") -> Disclosure:
    return Disclosure(
        trade_id=trade_id,
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side=side,
        asset_kind="stock",
        range_low=Decimal("15000"),
        range_high=Decimal(range_high),
        traded_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        filed_at=datetime(2026, 4, 24, tzinfo=timezone.utc),
    )


def test_trader_submits_order_for_new_disclosure(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="o1", status="filled",
                                             filled_avg_price=Decimal("180"),
                                             filled_qty=Decimal("5"))
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["ordered"] == 1
    alpaca.submit.assert_called_once()
    intent: OrderIntent = alpaca.submit.call_args[0][0]
    assert intent.symbol == "AAPL"
    assert intent.notional_usd == Decimal("1000")  # tier 2 ($15K-$50K -> $1000)


def test_trader_skips_already_seen_disclosure(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    state.record_seen(_stock_disclosure())  # already seen
    alpaca = MagicMock()
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["ordered"] == 0
    alpaca.submit.assert_not_called()


def test_trader_records_position_on_filled(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="o1", status="filled",
                                             filled_avg_price=Decimal("180"),
                                             filled_qty=Decimal("5"))
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    trader.run_disclosure_cycle()

    assert state.get_avg_entry("AAPL") == Decimal("180")


def test_trader_logs_skip_on_no_buying_power(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="", status="rejected",
                                             reason="insufficient buying power")
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["skipped"] == 1
    events = state.recent_events()
    assert any(e["event_type"] == "ORDER_REJECTED" for e in events)


def test_trader_circuit_breaker_halts_at_max_daily_trades(tmp_db, paper_env, monkeypatch):
    import config
    monkeypatch.setattr(config, "MAX_DAILY_TRADES", 2)
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.return_value = FillResult(order_id="o", status="filled",
                                             filled_avg_price=Decimal("100"), filled_qty=Decimal("10"))
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [
        _stock_disclosure(trade_id=f"t{i}") for i in range(5)
    ]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["ordered"] == 2
    assert summary["circuit_broken"] == 3


def test_trader_increments_errors_on_alpaca_exception(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    alpaca.submit.side_effect = RuntimeError("network exploded")
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.return_value = [_stock_disclosure()]

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["errors"] == 1
    assert summary["ordered"] == 0
    events = state.recent_events()
    assert any(e["event_type"] == "TRADE_ERROR" for e in events)


def test_trader_increments_errors_on_scraper_failure(tmp_db, paper_env):
    from src.state import State
    state = State(tmp_db)
    alpaca = MagicMock()
    scraper = MagicMock()
    scraper.fetch_recent_disclosures.side_effect = RuntimeError("playwright crash")

    trader = Trader(state=state, alpaca=alpaca, scraper=scraper)
    summary = trader.run_disclosure_cycle()

    assert summary["errors"] == 1
    assert summary["new"] == 0
    events = state.recent_events()
    assert any(e["event_type"] == "SCRAPER_ERROR" for e in events)
