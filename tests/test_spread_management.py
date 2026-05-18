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
    assert any("spread closed" in title.lower() for ch, title, kw in embeds)


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


def _stock_pos(symbol, qty):
    return {"symbol": symbol, "asset_class": "us_equity",
            "qty": str(qty), "avg_entry_price": "10.0"}


def test_orphan_short_missing_closes_long(monkeypatch):
    """Short leg gone from Alpaca, long leg still present → STC the
    long, delete state, embed says 'short leg gone'."""
    captured = []
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: captured.append(("stc", sym)) or {"id": "x"})
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: captured.append(("btc", sym)) or {"id": "x"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.05, "ask": 0.07})
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((title, kw.get("description", ""))))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    positions = [
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "0.11"},
    ]

    wheel_strategy._handle_orphan_leg(state, "PLTR", positions)

    assert ("stc", "PLTR260619P00007000") in captured
    assert ("btc", "PLTR260619P00008000") not in captured
    assert "PLTR" not in state
    assert any("short leg gone" in d.lower() for t, d in embeds)


def test_orphan_long_missing_closes_short(monkeypatch):
    """Long leg gone from Alpaca, short leg still present → BTC the
    short, delete state, embed says 'long leg gone'."""
    captured = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: captured.append(sym) or {"id": "x"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: captured.append(("BAD", sym)))
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((title, kw.get("description", ""))))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    positions = [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option",
         "qty": "-1", "avg_entry_price": "-0.33"},
    ]

    wheel_strategy._handle_orphan_leg(state, "PLTR", positions)

    assert "PLTR260619P00008000" in captured
    assert "PLTR" not in state
    assert any("long leg gone" in d.lower() for t, d in embeds)


def test_orphan_both_missing_clears_state(monkeypatch):
    """Both legs gone (closed externally between cycles) → no orders,
    delete state, embed says 'fully closed externally'."""
    orders = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda *a, **kw: orders.append("btc"))
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda *a, **kw: orders.append("stc"))
    embeds = []
    monkeypatch.setattr(wheel_strategy, "send_embed",
                        lambda ch, title, **kw: embeds.append((title, kw.get("description", ""))))
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    wheel_strategy._handle_orphan_leg(state, "PLTR", positions=[])

    assert orders == []
    assert "PLTR" not in state
    assert any("fully closed externally" in d.lower() for t, d in embeds)


def test_orphan_returns_early_when_both_legs_present(monkeypatch):
    """Sanity: if both legs are still in positions, the orphan handler
    must NOT do anything. (handle_spread is supposed to gate this, but
    test the helper standalone.)"""
    orders = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda *a, **kw: orders.append("btc"))
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda *a, **kw: orders.append("stc"))
    monkeypatch.setattr(wheel_strategy, "send_embed", lambda *a, **kw: None)
    monkeypatch.setattr(wheel_strategy, "log_event", lambda *a, **kw: None)

    state = {"PLTR": _spread_state()}
    positions = [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option",
         "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option",
         "qty": "1", "avg_entry_price": "0.11"},
    ]
    wheel_strategy._handle_orphan_leg(state, "PLTR", positions)

    assert orders == []
    assert "PLTR" in state, "state must not be touched when both legs present"


from datetime import date as _date_type, timedelta as _timedelta


def _far_expiry_state(**kwargs):
    """Spread state with expiration well in the future (no DTE trigger risk)."""
    s = _spread_state(**kwargs)
    far = _date_type.today() + _timedelta(days=30)
    s["expiration"] = far.isoformat()
    return s


def _near_expiry_state(days_to_expiry=2, **kwargs):
    s = _spread_state(**kwargs)
    near = _date_type.today() + _timedelta(days=days_to_expiry)
    s["expiration"] = near.isoformat()
    return s


def test_handle_spread_profit_50pct_triggers_close(monkeypatch):
    """Spread at 50% profit → _close_spread called with early_close_50pct."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},  # mid 0.18
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},  # mid 0.07
    }[sym])
    # Profit calc: current_value = 0.18 - 0.07 = 0.11, credit was 0.22 → 50% profit
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "early_close_50pct")]


def test_handle_spread_stop_loss_triggers_close(monkeypatch):
    """Loss per share >= 50% of max_loss → stop_loss_50pct."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # current_value = 0.70 - 0.09 = 0.61. loss = 0.61 - 0.22 = 0.39 = 50% of 0.78
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.69, "ask": 0.71},
        "PLTR260619P00007000": {"bid": 0.08, "ask": 0.10},
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "stop_loss_50pct")]


def test_handle_spread_dte_floor_with_itm_triggers_close(monkeypatch):
    """DTE <=2 AND short put ITM → dte_floor_itm close."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=2)}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # Not at profit, not at stop loss — pure DTE close case
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.30, "ask": 0.32},
        "PLTR260619P00007000": {"bid": 0.10, "ask": 0.12},
    }[sym])
    # Stock price 7.50 < short strike 8.0 → ITM (put credit short ITM)
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 7.50)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "dte_floor_itm")]


def test_handle_spread_dte_floor_when_otm_holds(monkeypatch):
    """DTE <=2 but short put OTM → hold, no close."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=2)}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.30, "ask": 0.32},
        "PLTR260619P00007000": {"bid": 0.10, "ask": 0.12},
    }[sym])
    # Stock price 9.0 > short strike 8.0 → OTM (safe)
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == []


def test_handle_spread_call_credit_dte_itm(monkeypatch):
    """For call_credit spreads, ITM means stock > short_strike."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=2)}
    state["PLTR"]["spread_type"] = "call_credit"
    state["PLTR"]["short_leg"] = {"occ": "PLTR260619C00010000", "strike": 10.0,
                                   "entry_premium": 0.40, "qty": 1}
    state["PLTR"]["long_leg"]  = {"occ": "PLTR260619C00011000", "strike": 11.0,
                                   "entry_premium": 0.15, "qty": 1}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619C00010000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.40"},
        {"symbol": "PLTR260619C00011000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.15"},
    ])
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619C00010000": {"bid": 0.40, "ask": 0.42},
        "PLTR260619C00011000": {"bid": 0.15, "ask": 0.17},
    }[sym])
    # Stock 10.50 > short strike 10.0 → ITM for short call
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 10.50)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "dte_floor_itm")]


def test_handle_spread_no_triggers_holds(monkeypatch):
    """All triggers negative → hold, no close, no state change."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # Profit ~20%, not at 50%
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.25, "ask": 0.27},
        "PLTR260619P00007000": {"bid": 0.08, "ask": 0.10},
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == []
    assert "PLTR" in state


def test_handle_spread_orphan_routes_to_handler(monkeypatch):
    """Only one leg present on Alpaca → _handle_orphan_leg fires, NOT _close_spread."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        # only the long leg present
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    orphan_calls = []
    close_calls = []
    monkeypatch.setattr(wheel_strategy, "_handle_orphan_leg",
                        lambda state, ticker, positions: orphan_calls.append(ticker))
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: close_calls.append(ticker))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert orphan_calls == ["PLTR"]
    assert close_calls == []


def test_handle_spread_profit_takes_priority_over_dte(monkeypatch):
    """If a spread is BOTH at 50% profit AND at DTE <=2 with ITM short,
    profit takes priority (better outcome for the trader)."""
    state = {"PLTR": _near_expiry_state(days_to_expiry=1)}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # current_value = 0.11 = 50% of credit
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.17, "ask": 0.19},
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},
    }[sym])
    # Stock 7.5 < short strike 8.0 → ITM, but profit trigger fires first
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 7.5)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "early_close_50pct")]


def test_apply_mode_manual_enables_spread_management():
    """apply_mode('manual') sets SPREAD_MANAGEMENT to True and reads
    the three threshold globals from config."""
    import config
    wheel_strategy.apply_mode("manual")
    assert wheel_strategy.SPREAD_MANAGEMENT is True
    assert wheel_strategy.SPREAD_EARLY_CLOSE_PCT == 0.50
    assert wheel_strategy.SPREAD_STOP_LOSS_PCT == 0.50
    assert wheel_strategy.SPREAD_DTE_FLOOR == 2


def test_apply_mode_conservative_keeps_spread_management_off():
    wheel_strategy.apply_mode("conservative")
    assert wheel_strategy.SPREAD_MANAGEMENT is False


def test_run_wheel_routes_spread_to_handle_spread(monkeypatch, tmp_path):
    """Integration: when run_wheel sees a spread_active state entry on
    manual mode, it calls handle_spread (and not handle_stage1/2)."""
    import json
    wheel_strategy.apply_mode("manual")
    state = {"_meta": {}, "PLTR": _spread_state()}
    state_file = tmp_path / "wheel_state_manual.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))

    monkeypatch.setattr(wheel_strategy, "is_market_open", lambda: True)
    monkeypatch.setattr(wheel_strategy, "get_account",
                        lambda: {"cash": "10000", "options_buying_power": "10000"})
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    # Stub auto-discovery so SYMBOLS stays as just PLTR
    monkeypatch.setattr(wheel_strategy, "_discover_wheel_state",
                        lambda state: {"PLTR"})

    handled = []
    monkeypatch.setattr(wheel_strategy, "handle_spread",
                        lambda state, ticker, account: handled.append(ticker))
    stage1_handled = []
    stage2_handled = []
    monkeypatch.setattr(wheel_strategy, "handle_stage1",
                        lambda *a, **kw: stage1_handled.append(True))
    monkeypatch.setattr(wheel_strategy, "handle_stage2",
                        lambda *a, **kw: stage2_handled.append(True))

    wheel_strategy.run_wheel()

    assert handled == ["PLTR"]
    assert stage1_handled == []
    assert stage2_handled == []


def test_run_wheel_with_spread_management_off_skips_spread(monkeypatch, tmp_path):
    """If SPREAD_MANAGEMENT is False (e.g. on conservative mode), a
    spread_active entry is left alone — log heartbeat only, no handler call."""
    import json
    wheel_strategy.apply_mode("conservative")
    assert wheel_strategy.SPREAD_MANAGEMENT is False

    state = {"_meta": {}, "PLTR": _spread_state()}
    state_file = tmp_path / "wheel_state.json"
    state_file.write_text(json.dumps(state))
    monkeypatch.setattr(wheel_strategy, "STATE_FILE", str(state_file))
    monkeypatch.setattr(wheel_strategy, "is_market_open", lambda: True)
    monkeypatch.setattr(wheel_strategy, "get_account",
                        lambda: {"cash": "100000", "options_buying_power": "100000"})
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    monkeypatch.setattr(wheel_strategy, "_discover_wheel_state",
                        lambda state: {"PLTR"})

    handled = []
    monkeypatch.setattr(wheel_strategy, "handle_spread",
                        lambda state, ticker, account: handled.append(ticker))

    wheel_strategy.run_wheel()
    assert handled == [], "handle_spread must not be called when SPREAD_MANAGEMENT=False"


import wheel_strategy as ws


def _active_spread_state(open_order_id="ord-1"):
    ss = ws._empty_spread_state()
    ss["spread_type"] = "put_credit"
    ss["short_leg"] = {"occ": "SOFI260605P00014000", "strike": 14.0,
                       "entry_premium": 0.30, "qty": 1}
    ss["long_leg"] = {"occ": "SOFI260605P00013000", "strike": 13.0,
                      "entry_premium": 0.20, "qty": 1}
    ss["expiration"] = "2026-06-05"
    ss["net_credit"] = 0.10
    ss["max_loss"] = 0.90
    ss["width"] = 1.0
    ss["opened_at"] = "2026-05-18T14:27:00Z"
    ss["open_order_id"] = open_order_id
    return ss


def test_handle_spread_pending_order_skips_no_close_no_delete(monkeypatch):
    """The exact loop bug: open order unfilled, no leg positions. Must NOT
    fire the orphan/'closed externally' path and must NOT delete state."""
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 48.0)
    called = {"positions": 0, "orphan": 0}
    monkeypatch.setattr(ws, "get_positions",
                        lambda: called.__setitem__("positions", called["positions"] + 1) or [])
    monkeypatch.setattr(ws, "_handle_orphan_leg",
                        lambda *a, **k: called.__setitem__("orphan", called["orphan"] + 1))
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert "SOFI" in state, "must not delete state while open order pending"
    assert called["orphan"] == 0, "must not reach orphan/closed-externally path"
    assert called["positions"] == 0, "must short-circuit before position fetch"


def test_handle_spread_filled_clears_marker_and_returns(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "filled"})
    monkeypatch.setattr(ws, "get_positions", lambda: [])
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert state["SOFI"]["open_order_id"] is None
    assert state["SOFI"]["stage"] == "spread_active"


def test_handle_spread_stale_cancels_and_clears(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 0.0)  # any age is stale
    cancelled = []
    monkeypatch.setattr(ws, "cancel_order",
                        lambda oid: cancelled.append(oid) or True)
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert cancelled == ["ord-1"]
    assert "SOFI" not in state, "stale open order → cancel + clear state"


def test_handle_spread_stale_cancel_fails_keeps_state(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "new"})
    monkeypatch.setattr(ws, "STALE_AFTER_HOURS", 0.0)
    monkeypatch.setattr(ws, "cancel_order", lambda oid: False)
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert "SOFI" in state, "failed cancel must leave state for retry"


def test_handle_spread_adopted_no_order_id_uses_existing_path(monkeypatch):
    """Manual-mode hand-opened spread: open_order_id None → resolver not
    consulted, existing orphan path runs (isolation guarantee)."""
    ss = _active_spread_state(open_order_id=None)
    state = {"SOFI": ss}
    orphan_called = []
    monkeypatch.setattr(ws, "get_positions", lambda: [])
    monkeypatch.setattr(ws, "_handle_orphan_leg",
                        lambda *a, **k: orphan_called.append(True))
    got_order = []
    monkeypatch.setattr(ws, "get_order", lambda oid: got_order.append(oid))
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert got_order == [], "resolver must not be consulted when no open_order_id"
    assert orphan_called == [True], "existing orphan path must run unchanged"


def test_handle_spread_gone_no_position_accurate_embed_not_closed_externally(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "rejected"})
    monkeypatch.setattr(ws, "get_positions", lambda: [])
    orphan = []
    monkeypatch.setattr(ws, "_handle_orphan_leg",
                        lambda *a, **k: orphan.append(True))
    titles = []
    monkeypatch.setattr(ws, "send_embed",
                        lambda ch, title, **k: titles.append(title))
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert orphan == [], "never-filled order must NOT use the orphan/closed-externally path"
    assert "SOFI" not in state, "state cleared"
    assert any("did not fill" in t for t in titles)
    assert not any("closed externally" in t for t in titles)


def test_handle_spread_gone_with_survivor_leg_uses_orphan_handler(monkeypatch):
    state = {"SOFI": _active_spread_state()}
    monkeypatch.setattr(ws, "get_order", lambda oid: {"status": "canceled"})
    monkeypatch.setattr(ws, "get_positions",
                        lambda: [{"symbol": "SOFI260605P00014000",
                                  "asset_class": "us_option", "qty": "-1"}])
    orphan = []
    monkeypatch.setattr(ws, "_handle_orphan_leg",
                        lambda s, t, p: orphan.append((t, len(p))))
    monkeypatch.setattr(ws, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(ws, "log", lambda *a, **k: None)

    ws.handle_spread(state, "SOFI", {"equity": "2000"})

    assert orphan == [("SOFI", 1)], "survivor leg → existing orphan handler closes it"
