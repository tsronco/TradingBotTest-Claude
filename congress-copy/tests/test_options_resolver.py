from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from src.models import Disclosure, OptionDetails, OrderIntent
from src.options_resolver import resolve_option


def _option_disclosure(strike: str = "200", days_to_expiry: int = 60,
                       option_type: str = "call") -> Disclosure:
    expiry = datetime(2026, 4, 25, tzinfo=timezone.utc) + timedelta(days=days_to_expiry)
    return Disclosure(
        trade_id="opt-1",
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side="buy",
        asset_kind="option",
        range_low=Decimal("15000"),
        range_high=Decimal("50000"),
        traded_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        filed_at=datetime(2026, 4, 25, tzinfo=timezone.utc),
        option=OptionDetails(option_type=option_type, strike=Decimal(strike), expiry=expiry),
    )


def test_exact_contract_match():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = "AAPL241220C00200000"
    intent = resolve_option(_option_disclosure(), notional=Decimal("1000"), alpaca=alpaca)
    assert intent is not None
    assert intent.symbol == "AAPL241220C00200000"
    assert intent.fallback_path == "exact_option"
    assert intent.qty == 1


def test_falls_back_to_underlying_when_no_contract():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    intent = resolve_option(_option_disclosure(), notional=Decimal("1000"), alpaca=alpaca)
    assert intent is not None
    assert intent.symbol == "AAPL"
    assert intent.asset_kind == "stock"
    assert intent.side == "buy"
    assert intent.fallback_path == "underlying"
    assert intent.notional_usd == Decimal("1000")


def test_put_falls_back_to_short_underlying():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    intent = resolve_option(
        _option_disclosure(option_type="put"),
        notional=Decimal("1000"),
        alpaca=alpaca,
    )
    assert intent is not None
    assert intent.symbol == "AAPL"
    assert intent.side == "sell"
    assert intent.fallback_path == "underlying"


def test_skip_when_disabled_and_no_match(monkeypatch):
    import config
    monkeypatch.setattr(config, "OPTIONS_UNDERLYING_FALLBACK", False)
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    intent = resolve_option(_option_disclosure(), notional=Decimal("1000"), alpaca=alpaca)
    assert intent is None


def test_sell_side_short_call_is_short_underlying():
    alpaca = MagicMock()
    alpaca.find_option_contract.return_value = None
    disc = _option_disclosure(option_type="call")
    disc = Disclosure(**{**disc.__dict__, "side": "sell"})
    intent = resolve_option(disc, notional=Decimal("1000"), alpaca=alpaca)
    assert intent is not None
    assert intent.side == "sell"


def test_raises_when_disclosure_not_option():
    """Defensive: callers should never pass a stock disclosure to resolve_option."""
    alpaca = MagicMock()
    stock_disclosure = Disclosure(
        trade_id="stock-1",
        politician_slug="josh-gottheimer",
        ticker="AAPL",
        side="buy",
        asset_kind="stock",
        range_low=Decimal("15000"),
        range_high=Decimal("50000"),
        traded_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        filed_at=datetime(2026, 4, 25, tzinfo=timezone.utc),
        option=None,
    )
    with pytest.raises(ValueError):
        resolve_option(stock_disclosure, notional=Decimal("1000"), alpaca=alpaca)
