from decimal import Decimal

import httpx
import pytest
import respx

from src.alpaca_client import AlpacaClient
from src.models import OrderIntent


@pytest.fixture
def client(paper_env) -> AlpacaClient:
    return AlpacaClient()


@respx.mock
def test_submit_stock_order_uses_notional(client):
    route = respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        return_value=httpx.Response(
            200,
            json={"id": "order-123", "status": "accepted", "filled_avg_price": None, "filled_qty": "0"},
        )
    )
    intent = OrderIntent(symbol="AAPL", side="buy", notional_usd=Decimal("1000"), asset_kind="stock")
    fill = client.submit(intent)
    assert fill.order_id == "order-123"
    assert fill.status == "pending"
    body = route.calls[-1].request.read().decode()
    assert '"symbol": "AAPL"' in body or '"symbol":"AAPL"' in body
    assert '"notional"' in body


@respx.mock
def test_submit_option_order_uses_qty(client):
    respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        return_value=httpx.Response(200, json={"id": "ord", "status": "accepted",
                                                "filled_avg_price": None, "filled_qty": "0"})
    )
    intent = OrderIntent(
        symbol="AAPL241220C00200000",
        side="buy",
        notional_usd=Decimal("0"),
        qty=2,
        asset_kind="option",
    )
    fill = client.submit(intent)
    assert fill.status == "pending"


@respx.mock
def test_submit_handles_rejection(client):
    respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        return_value=httpx.Response(422, json={"message": "insufficient buying power"})
    )
    intent = OrderIntent(symbol="AAPL", side="buy", notional_usd=Decimal("1000"))
    fill = client.submit(intent)
    assert fill.status == "rejected"
    assert "insufficient buying power" in (fill.reason or "")


@respx.mock
def test_submit_retries_on_5xx_then_succeeds(client):
    respx.post("https://paper-api.alpaca.markets/v2/orders").mock(
        side_effect=[
            httpx.Response(503, json={"message": "service unavailable"}),
            httpx.Response(200, json={"id": "ord-ok", "status": "accepted",
                                       "filled_avg_price": None, "filled_qty": "0"}),
        ]
    )
    intent = OrderIntent(symbol="AAPL", side="buy", notional_usd=Decimal("1000"))
    fill = client.submit(intent)
    assert fill.status == "pending"
    assert fill.order_id == "ord-ok"


@respx.mock
def test_is_market_open(client):
    respx.get("https://paper-api.alpaca.markets/v2/clock").mock(
        return_value=httpx.Response(200, json={"is_open": True})
    )
    assert client.is_market_open() is True


@respx.mock
def test_list_positions_returns_dataclasses(client):
    respx.get("https://paper-api.alpaca.markets/v2/positions").mock(
        return_value=httpx.Response(200, json=[
            {
                "symbol": "AAPL",
                "qty": "5",
                "avg_entry_price": "180.00",
                "current_price": "190.00",
                "market_value": "950.00",
                "unrealized_plpc": "0.0556",
            }
        ])
    )
    positions = client.list_positions()
    assert len(positions) == 1
    assert positions[0].symbol == "AAPL"
    assert positions[0].qty == Decimal("5")


@respx.mock
def test_close_position_success(client):
    respx.delete("https://paper-api.alpaca.markets/v2/positions/AAPL").mock(
        return_value=httpx.Response(200, json={"id": "close-order-1", "status": "accepted"})
    )
    result = client.close_position("AAPL")
    assert result.status == "pending"
    assert result.order_id == "close-order-1"


@respx.mock
def test_close_position_rejected(client):
    respx.delete("https://paper-api.alpaca.markets/v2/positions/UNKNOWN").mock(
        return_value=httpx.Response(404, json={"message": "position does not exist"})
    )
    result = client.close_position("UNKNOWN")
    assert result.status == "rejected"
    assert "position does not exist" in (result.reason or "")


@respx.mock
def test_find_option_contract_picks_closest_strike(client):
    from datetime import date, timedelta
    far_expiry = (date.today() + timedelta(days=60)).isoformat()
    respx.get("https://paper-api.alpaca.markets/v2/options/contracts").mock(
        return_value=httpx.Response(200, json={
            "option_contracts": [
                {"symbol": "AAPL_FAR_STRIKE",   "strike_price": "210.00", "expiration_date": far_expiry},
                {"symbol": "AAPL_CLOSE_STRIKE", "strike_price": "201.00", "expiration_date": far_expiry},
                {"symbol": "AAPL_OK_STRIKE",    "strike_price": "205.00", "expiration_date": far_expiry},
            ]
        })
    )
    # target_strike=200, max_deviation=10% (so 180-220 is allowed); closest to 200 wins
    result = client.find_option_contract(
        underlying="AAPL",
        option_type="call",
        target_strike=Decimal("200"),
        target_expiry=None,
        min_days_to_expiry=30,
        max_strike_deviation_pct=Decimal("0.10"),
    )
    assert result == "AAPL_CLOSE_STRIKE"  # 201 is closest to 200


@respx.mock
def test_find_option_contract_filters_short_expiries(client):
    from datetime import date, timedelta
    too_soon = (date.today() + timedelta(days=10)).isoformat()
    far_enough = (date.today() + timedelta(days=45)).isoformat()
    respx.get("https://paper-api.alpaca.markets/v2/options/contracts").mock(
        return_value=httpx.Response(200, json={
            "option_contracts": [
                {"symbol": "TOO_SOON",   "strike_price": "200.00", "expiration_date": too_soon},
                {"symbol": "FAR_ENOUGH", "strike_price": "200.00", "expiration_date": far_enough},
            ]
        })
    )
    result = client.find_option_contract(
        underlying="AAPL",
        option_type="call",
        target_strike=Decimal("200"),
        target_expiry=None,
        min_days_to_expiry=30,
        max_strike_deviation_pct=Decimal("0.10"),
    )
    assert result == "FAR_ENOUGH"
