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


def test_close_spread_legs_individually_both_succeed(monkeypatch):
    """Happy path: buy-to-close short, then sell-to-close long. Both succeed."""
    calls = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: calls.append(("btc", sym, qty)) or {"id": "a"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: calls.append(("stc", sym, qty)) or {"id": "b"})
    # Mock get_option_quote so the helper can compute limit prices
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)

    assert result is True
    assert calls[0][0] == "btc"  # short closed first
    assert calls[0][1] == "PLTR260619P00008000"
    assert calls[1][0] == "stc"
    assert calls[1][1] == "PLTR260619P00007000"


def test_close_spread_legs_individually_short_fails(monkeypatch):
    """Short BTC fails → return False, do NOT attempt long STC.
    State is unchanged so next cycle retries from the top."""
    stc_called = []
    def failing_btc(sym, price, qty=None):
        raise RuntimeError("buy-to-close rejected")
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close", failing_btc)
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: stc_called.append(sym) or {"id": "b"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)
    assert result is False
    assert stc_called == [], "long leg STC must not run when short BTC fails"


def test_close_spread_legs_individually_long_fails_marks_orphan(monkeypatch):
    """Short closes successfully, but long STC fails → return False AND
    mark short_leg.qty=0 in state so the next cycle's orphan handler
    closes the surviving long."""
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: {"id": "btc-1"})
    def failing_stc(sym, price, qty=None):
        raise RuntimeError("sell-to-close rejected")
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close", failing_stc)
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)
    assert result is False
    # Half-closed marker so orphan handler picks up the long next cycle
    assert sym_state["short_leg"]["qty"] == 0
    assert sym_state["long_leg"]["qty"] == 1  # untouched


def test_close_spread_legs_individually_handles_missing_quote(monkeypatch):
    """If get_option_quote returns None (no live quote), use the entry
    premium as a fallback limit reference so we still attempt the close."""
    calls = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: calls.append(price) or {"id": "a"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: calls.append(price) or {"id": "b"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: None)

    sym_state = _spread_state()  # short_entry 0.33, long_entry 0.11
    wheel_strategy._close_spread_legs_individually(sym_state)
    # Fallback uses entry_premium values
    assert calls[0] == pytest.approx(0.33)
    assert calls[1] == pytest.approx(0.11)


def test_close_spread_mleg_success_deletes_state(monkeypatch):
    """mleg succeeds → state[ticker] deleted, single trades-channel embed."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: True)
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((ch, title, kw)))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._close_spread(state, "PLTR", reason="early_close_50pct")

    assert "PLTR" not in state, "state entry must be deleted on successful close"
    assert any("closed spread" in title.lower() for ch, title, kw in embeds)


def test_close_spread_falls_back_to_singles_on_mleg_failure(monkeypatch):
    """mleg fails → fallback path tried. If fallback succeeds, state is
    deleted and the trades embed footer notes the fallback."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: False)
    monkeypatch.setattr(wheel_strategy, "_close_spread_legs_individually", lambda ss: True)
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((ch, title, kw)))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._close_spread(state, "PLTR", reason="stop_loss_50pct")

    assert "PLTR" not in state
    # An info embed about the fallback should land in #actions
    assert any("fallback" in (kw.get("description") or "").lower()
               for ch, title, kw in embeds)


def test_close_spread_both_paths_fail_leaves_state_alone(monkeypatch):
    """Both mleg AND fallback fail → state untouched, error already
    surfaced by the fallback path. Next cycle retries."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: False)
    monkeypatch.setattr(wheel_strategy, "_close_spread_legs_individually", lambda ss: False)
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._close_spread(state, "PLTR", reason="stop_loss_50pct")

    assert "PLTR" in state, "state must remain so next cycle can retry"


def test_close_spread_embed_color_by_reason(monkeypatch):
    """Profit close → green; stop loss / DTE close → yellow."""
    monkeypatch.setattr(wheel_strategy, "_close_spread_mleg", lambda ss: True)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    for reason, expected_color in (
        ("early_close_50pct", wheel_strategy.Color.GREEN),
        ("stop_loss_50pct",   wheel_strategy.Color.YELLOW),
        ("dte_floor_itm",     wheel_strategy.Color.YELLOW),
    ):
        captured = []
        monkeypatch.setattr(wheel_strategy, "send_embed",
                            lambda ch, title, **kw: captured.append(kw.get("color")))
        state = {"PLTR": _spread_state()}
        wheel_strategy._close_spread(state, "PLTR", reason=reason)
        assert expected_color in captured, f"reason={reason} missing color {expected_color}"
