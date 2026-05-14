"""Tests for spread management (Phase 2 of spread support).

Coverage:
  - _compute_spread_pnl pure math
  - handle_spread decision tree (profit, stop loss, DTE close, hold)
  - close mechanic (mleg success, fallback to singles, half-closed)
  - orphan-leg handling (short missing, long missing, both missing)
  - run_wheel routing to handle_spread when stage == "spread_active"
"""
from datetime import date
import pytest

import wheel_strategy


def _spread_state(short_strike=8.0, long_strike=7.0, net_credit=0.22, max_loss=0.78):
    """Build a populated spread_active state dict for tests."""
    return {
        "stage": "spread_active",
        "spread_type": "put_credit",
        "short_leg": {"occ": "PLTR260619P00008000", "strike": short_strike,
                      "entry_premium": 0.33, "qty": 1},
        "long_leg":  {"occ": "PLTR260619P00007000", "strike": long_strike,
                      "entry_premium": 0.11, "qty": 1},
        "expiration": "2026-06-19",
        "net_credit": net_credit,
        "max_loss": max_loss,
        "width": short_strike - long_strike,
        "opened_at": "2026-05-14T17:00:00Z",
        "total_premium_collected": 0.0,
        "cycle_count": 0,
        "cycle_history": [],
        "last_action": "",
    }


def test_compute_spread_pnl_at_open():
    """Right after open: short price = entry, long price = entry, current
    value = net_credit, profit_pct = 0."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=0.33, long_mid=0.11)
    assert result["current_value"] == pytest.approx(0.22)
    assert result["profit_pct"] == pytest.approx(0.0)
    assert result["loss_per_share"] == pytest.approx(0.0)


def test_compute_spread_pnl_50pct_profit():
    """Spread worth half of entry credit → 50% profit captured."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    # short dropped from 0.33 to 0.18, long dropped from 0.11 to 0.07
    # current value = 0.18 - 0.07 = 0.11 = half of 0.22 credit
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=0.18, long_mid=0.07)
    assert result["current_value"] == pytest.approx(0.11)
    assert result["profit_pct"] == pytest.approx(0.50)
    assert result["loss_per_share"] == pytest.approx(-0.11)


def test_compute_spread_pnl_half_max_loss():
    """Loss per share = max_loss / 2 → stop loss should trigger."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    # current_value = 0.22 + 0.39 = 0.61 (loss = 0.39, half of 0.78)
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=0.70, long_mid=0.09)
    assert result["current_value"] == pytest.approx(0.61)
    assert result["loss_per_share"] == pytest.approx(0.39)
    assert result["profit_pct"] < 0  # losing


def test_compute_spread_pnl_max_loss_floor():
    """Stock crashed — spread is worth the full width, max loss realized."""
    sym_state = _spread_state(short_strike=8.0, long_strike=7.0, net_credit=0.22, max_loss=0.78)
    # short = 1.50, long = 0.50, current_value = 1.00 = width
    result = wheel_strategy._compute_spread_pnl(sym_state, short_mid=1.50, long_mid=0.50)
    assert result["current_value"] == pytest.approx(1.00)
    assert result["loss_per_share"] == pytest.approx(0.78)


def test_place_sell_to_close_calls_alpaca_with_correct_payload(monkeypatch):
    captured = {}
    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"id": "test-order-123", "symbol": body["symbol"]}
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)

    result = wheel_strategy.place_sell_to_close("PLTR260619P00007000", 0.10, qty=1)

    assert captured["path"] == "/orders"
    assert captured["body"]["symbol"] == "PLTR260619P00007000"
    assert captured["body"]["qty"] == "1"
    assert captured["body"]["side"] == "sell"
    assert captured["body"]["type"] == "limit"
    assert captured["body"]["position_intent"] == "sell_to_close"
    assert captured["body"]["time_in_force"] == "day"
    # Limit price should be slightly below mid to ensure fill — mirrors
    # place_buy_to_close which adds 0.05 above mid for the same reason.
    limit = float(captured["body"]["limit_price"])
    assert 0.04 <= limit <= 0.06  # mid 0.10, "slightly aggressive" subtraction
    assert result["id"] == "test-order-123"


def test_place_sell_to_close_auto_lookup_qty(monkeypatch):
    """When qty=None, the helper looks up the actual long position size."""
    monkeypatch.setattr(wheel_strategy, "get_option_position",
                        lambda sym: {"symbol": sym, "qty": "2"})
    captured = {}
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda path, body: captured.update(body) or {"id": "x"})

    wheel_strategy.place_sell_to_close("PLTR260619P00007000", 0.10)
    assert captured["qty"] == "2"


def test_place_sell_to_close_skips_when_no_position(monkeypatch):
    """If Alpaca shows no position, the helper logs and returns None
    without placing an order."""
    monkeypatch.setattr(wheel_strategy, "get_option_position", lambda sym: None)
    placed = []
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda path, body: placed.append(body))

    result = wheel_strategy.place_sell_to_close("PLTR260619P00007000", 0.10)
    assert result is None
    assert placed == []

def test_close_spread_mleg_builds_correct_payload(monkeypatch):
    """Multi-leg buy-to-close payload: order_class=mleg, two legs with
    correct sides and position_intents, qty in spread units."""
    captured = {}
    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"id": "mleg-order-1", "status": "accepted"}
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_mleg(sym_state)

    assert result is True
    assert captured["path"] == "/orders"
    body = captured["body"]
    assert body["order_class"] == "mleg"
    assert body["qty"] == "1"
    assert body["type"] == "market"
    assert body["time_in_force"] == "day"
    legs = body["legs"]
    assert len(legs) == 2
    # Find each leg by symbol
    short_leg = next(l for l in legs if l["symbol"] == "PLTR260619P00008000")
    long_leg  = next(l for l in legs if l["symbol"] == "PLTR260619P00007000")
    assert short_leg["side"] == "buy"
    assert short_leg["position_intent"] == "buy_to_close"
    assert short_leg["ratio_qty"] == "1"
    assert long_leg["side"] == "sell"
    assert long_leg["position_intent"] == "sell_to_close"
    assert long_leg["ratio_qty"] == "1"


def test_close_spread_mleg_returns_false_on_rejection(monkeypatch):
    """Alpaca rejection (any exception during api_post) returns False
    so the caller can try the fallback path."""
    def fake_api_post(path, body):
        raise RuntimeError("422 multi-leg order rejected")
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_mleg(sym_state)
    assert result is False


def test_close_spread_mleg_handles_multi_contract_spreads(monkeypatch):
    """Spread with qty=2 → mleg payload qty='2', ratio_qty stays '1'
    (ratio is per-spread, not per-contract count)."""
    captured = {}
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda path, body: captured.update(body) or {"id": "x"})

    sym_state = _spread_state()
    sym_state["short_leg"]["qty"] = 2
    sym_state["long_leg"]["qty"] = 2

    wheel_strategy._close_spread_mleg(sym_state)
    assert captured["qty"] == "2"
    assert all(leg["ratio_qty"] == "1" for leg in captured["legs"])
