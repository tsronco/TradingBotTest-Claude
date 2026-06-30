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


@pytest.fixture
def apply_sm_mode():
    """Apply a spread-management posture for the test, auto-revert after.

    The conservative/aggressive and sm500/sm1000/sm2000 accounts were retired
    2026-06-29, but their `handle_spread` posture branches still exist in the
    engine (2× credit stop + immediate underlying tripwire for the old SM
    posture; spread-management-off for the old cons/agg posture). This fixture
    keeps that engine coverage alive by translating the retired mode names onto
    a surviving base mode and arming the corresponding module globals directly:

      * "sm500"/"sm1000"/"sm2000" → manual base + SM management posture
        (SPREAD_STOP_CREDIT_MULT=2.0, tripwire armed at all DTEs, no confirm
        window) — exercises the SM branch of handle_spread.
      * "conservative"/"aggressive" → live base (spread management off, no
        tripwire) — exercises the management-disabled branch.
      * "manual"/"live" → applied directly.
    """
    import config
    applied = []

    def _apply(mode_name: str):
        if mode_name in ("sm500", "sm1000", "sm2000"):
            wheel_strategy.apply_mode("manual")
            # Recreate the retired SM management posture on the engine globals.
            wheel_strategy.SPREAD_MANAGEMENT = True
            wheel_strategy.SPREAD_STOP_CREDIT_MULT = 2.0
            wheel_strategy.SPREAD_UNDERLYING_TRIPWIRE = True
            wheel_strategy.SPREAD_TRIPWIRE_DTE = None          # arm at all DTEs
            wheel_strategy.SPREAD_TRIPWIRE_CONFIRM_MINUTES = 0  # close on first touch
        elif mode_name in ("conservative", "aggressive"):
            # Old auto-execute posture: spread management off, no tripwire.
            wheel_strategy.apply_mode("live")
            wheel_strategy.SPREAD_MANAGEMENT = False
            wheel_strategy.SPREAD_STOP_CREDIT_MULT = None
            wheel_strategy.SPREAD_UNDERLYING_TRIPWIRE = False
        else:
            wheel_strategy.apply_mode(mode_name)
        applied.append(mode_name)

    yield _apply
    if applied:
        wheel_strategy.apply_mode(config.DEFAULT_MODE)


@pytest.fixture(autouse=True)
def _legacy_spread_baseline():
    """Pin the legacy spread-management posture the generic handle_spread tests
    were written against — 50% profit / 50%-of-max-loss stop, no credit-multiple
    stop, no underlying tripwire, no settle window. This used to be the ambient
    default (conservative); it shifted when DEFAULT_MODE became manual (0.75 stop
    + tripwire + 20-min settle) after the 2026-06-29 account sunset. Tests that
    need a specific posture (manual/live via apply_mode, SM via apply_sm_mode)
    re-set these in their body, which runs after this fixture.
    """
    import config
    wheel_strategy.apply_mode("manual")
    wheel_strategy.SPREAD_EARLY_CLOSE_PCT = 0.50
    wheel_strategy.SPREAD_STOP_LOSS_PCT = 0.50
    wheel_strategy.SPREAD_DTE_FLOOR = 2
    wheel_strategy.SPREAD_STOP_CREDIT_MULT = None
    wheel_strategy.SPREAD_UNDERLYING_TRIPWIRE = False
    wheel_strategy.SPREAD_SETTLE_MINUTES = 0
    wheel_strategy.SPREAD_TRIPWIRE_DTE = None
    wheel_strategy.SPREAD_TRIPWIRE_CONFIRM_MINUTES = 0
    yield
    wheel_strategy.apply_mode(config.DEFAULT_MODE)


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
    # close_cost == credit → break-even (executable cost to BTC = short_ask - long_bid)
    result = wheel_strategy._compute_spread_pnl(sym_state, close_cost=0.22)
    assert result["current_value"] == pytest.approx(0.22)
    assert result["profit_pct"] == pytest.approx(0.0)
    assert result["loss_per_share"] == pytest.approx(0.0)


def test_compute_spread_pnl_50pct_profit():
    """Spread worth half of entry credit → 50% profit captured."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    # executable cost to buy-to-close dropped to 0.11 = half of 0.22 credit
    result = wheel_strategy._compute_spread_pnl(sym_state, close_cost=0.11)
    assert result["current_value"] == pytest.approx(0.11)
    assert result["profit_pct"] == pytest.approx(0.50)
    assert result["loss_per_share"] == pytest.approx(-0.11)


def test_compute_spread_pnl_half_max_loss():
    """Loss per share = max_loss / 2 → stop loss should trigger."""
    sym_state = _spread_state(net_credit=0.22, max_loss=0.78)
    # close_cost = 0.61 → loss = 0.61 - 0.22 = 0.39, half of 0.78 max loss
    result = wheel_strategy._compute_spread_pnl(sym_state, close_cost=0.61)
    assert result["current_value"] == pytest.approx(0.61)
    assert result["loss_per_share"] == pytest.approx(0.39)
    assert result["profit_pct"] < 0  # losing


def test_compute_spread_pnl_max_loss_floor():
    """Stock crashed — spread is worth the full width, max loss realized."""
    sym_state = _spread_state(short_strike=8.0, long_strike=7.0, net_credit=0.22, max_loss=0.78)
    # close_cost = 1.00 = full width (spread at max loss)
    result = wheel_strategy._compute_spread_pnl(sym_state, close_cost=1.00)
    assert result["current_value"] == pytest.approx(1.00)
    assert result["loss_per_share"] == pytest.approx(0.78)


def test_reconcile_spread_fill_overwrites_from_actual_legs(monkeypatch):
    """Decision-time net_credit is replaced with the real fill (F sm500
    2026-05-18: stored 0.075 vs actually filled 0.0496)."""
    sym_state = _spread_state(net_credit=0.075, max_loss=0.925)  # width 1.0
    sym_state["open_order_id"] = "ord-1"
    monkeypatch.setattr(wheel_strategy, "get_order", lambda oid: {
        "id": oid, "status": "filled", "legs": [
            {"symbol": "PLTR260619P00008000", "side": "sell", "filled_avg_price": "0.0798"},
            {"symbol": "PLTR260619P00007000", "side": "buy",  "filled_avg_price": "0.0302"},
        ],
    })
    monkeypatch.setattr(wheel_strategy, "log", lambda *a, **k: None)

    wheel_strategy._reconcile_spread_fill(sym_state)

    assert sym_state["net_credit"] == pytest.approx(0.0496)
    assert sym_state["max_loss"] == pytest.approx(0.9504)  # width 1.0 - 0.0496


def test_reconcile_spread_fill_no_clobber_when_legs_missing(monkeypatch):
    """Order present but no leg fills → keep decision-time values."""
    sym_state = _spread_state(net_credit=0.075, max_loss=0.925)
    sym_state["open_order_id"] = "ord-1"
    monkeypatch.setattr(wheel_strategy, "get_order", lambda oid: {"status": "filled"})
    monkeypatch.setattr(wheel_strategy, "log", lambda *a, **k: None)

    wheel_strategy._reconcile_spread_fill(sym_state)

    assert sym_state["net_credit"] == pytest.approx(0.075)
    assert sym_state["max_loss"] == pytest.approx(0.925)


def test_reconcile_spread_fill_no_clobber_when_no_order(monkeypatch):
    """get_order None (404) → keep decision-time values, no crash."""
    sym_state = _spread_state(net_credit=0.075, max_loss=0.925)
    sym_state["open_order_id"] = "ord-1"
    monkeypatch.setattr(wheel_strategy, "get_order", lambda oid: None)
    monkeypatch.setattr(wheel_strategy, "log", lambda *a, **k: None)

    wheel_strategy._reconcile_spread_fill(sym_state)

    assert sym_state["net_credit"] == pytest.approx(0.075)


def test_reconcile_spread_fill_no_clobber_on_nonpositive_credit(monkeypatch):
    """A fill that nets <= 0 credit is not written (would pin profit_pct)."""
    sym_state = _spread_state(net_credit=0.075, max_loss=0.925)
    sym_state["open_order_id"] = "ord-1"
    monkeypatch.setattr(wheel_strategy, "get_order", lambda oid: {
        "legs": [
            {"symbol": "PLTR260619P00008000", "filled_avg_price": "0.03"},
            {"symbol": "PLTR260619P00007000", "filled_avg_price": "0.05"},
        ],
    })
    monkeypatch.setattr(wheel_strategy, "log", lambda *a, **k: None)

    wheel_strategy._reconcile_spread_fill(sym_state)

    assert sym_state["net_credit"] == pytest.approx(0.075)


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
    """Multi-leg buy-to-close payload: order_class=mleg, two legs with correct
    sides/position_intents, qty in spread units, and a MARKETABLE LIMIT (R5)
    priced at the net debit = short_ask − long_bid (positive = debit paid)."""
    captured = {}
    def fake_api_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {"id": "mleg-order-1", "status": "accepted"}
    monkeypatch.setattr(wheel_strategy, "api_post", fake_api_post)
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda occ: {
        "PLTR260619P00008000": {"bid": 0.30, "ask": 0.40},  # short
        "PLTR260619P00007000": {"bid": 0.05, "ask": 0.10},  # long
    }[occ])

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_mleg(sym_state)

    assert result is True
    assert captured["path"] == "/orders"
    body = captured["body"]
    assert body["order_class"] == "mleg"
    assert body["qty"] == "1"
    assert body["type"] == "limit"                       # R5: not market
    assert body["limit_price"] == "0.35"                 # short_ask 0.40 − long_bid 0.05
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


def test_close_spread_mleg_missing_quote_defers_to_fallback(monkeypatch):
    """No usable quote → return False so the individual-leg fallback runs."""
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda p, b: pytest.fail("must not POST without a quote"))
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda occ: None)
    assert wheel_strategy._close_spread_mleg(_spread_state()) is False


def test_close_spread_mleg_terminal_status_is_failure(monkeypatch):
    """A 200 response with a terminal non-filled status (e.g. 'rejected') is
    NOT a successful close (R7) — return False so state isn't deleted."""
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda occ: {"bid": 0.30, "ask": 0.40})
    monkeypatch.setattr(wheel_strategy, "api_post",
                        lambda p, b: {"id": "x", "status": "rejected"})
    assert wheel_strategy._close_spread_mleg(_spread_state()) is False


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
                        lambda path, body: captured.update(body) or {"id": "x", "status": "accepted"})
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda occ: {"bid": 0.30, "ask": 0.40})

    sym_state = _spread_state()
    sym_state["short_leg"]["qty"] = 2
    sym_state["long_leg"]["qty"] = 2

    wheel_strategy._close_spread_mleg(sym_state)
    assert captured["qty"] == "2"
    assert all(leg["ratio_qty"] == "1" for leg in captured["legs"])


def test_close_spread_legs_individually_both_succeed(monkeypatch):
    """Happy path: buy-to-close short, then sell-to-close long. Both succeed,
    priced MARKETABLE (R6): BTC short at the ask, STC long at the bid."""
    calls = []
    monkeypatch.setattr(wheel_strategy, "place_buy_to_close",
                        lambda sym, price, qty=None: calls.append(("btc", sym, price)) or {"id": "a"})
    monkeypatch.setattr(wheel_strategy, "place_sell_to_close",
                        lambda sym, price, qty=None: calls.append(("stc", sym, price)) or {"id": "b"})
    # Mock get_option_quote so the helper can compute marketable limit prices
    monkeypatch.setattr(wheel_strategy, "get_option_quote",
                        lambda sym: {"bid": 0.30, "ask": 0.32})

    sym_state = _spread_state()
    result = wheel_strategy._close_spread_legs_individually(sym_state)

    assert result is True
    assert calls[0][0] == "btc"  # short closed first
    assert calls[0][1] == "PLTR260619P00008000"
    assert calls[0][2] == pytest.approx(0.32)  # BTC at the ask (marketable)
    assert calls[1][0] == "stc"
    assert calls[1][1] == "PLTR260619P00007000"
    assert calls[1][2] == pytest.approx(0.30)  # STC at the bid (marketable)


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
        "PLTR260619P00008000": {"bid": 0.10, "ask": 0.12},
        "PLTR260619P00007000": {"bid": 0.04, "ask": 0.06},
    }[sym])
    # Executable BTC cost = short_ask 0.12 - long_bid 0.04 = 0.08;
    # profit_pct = (0.22 - 0.08) / 0.22 = 0.64 ≥ 0.50 → early close
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "early_close_50pct")]


def test_handle_spread_wide_quotes_no_false_profit_close(monkeypatch):
    """Regression (F sm500 2026-05-18): a wide bid/ask whose MID implies a
    big profit must NOT trigger an early close. The decision uses the
    executable BTC cost (short_ask - long_bid), so a spread that can only
    be bought back at a loss is held, not falsely closed at 'profit'."""
    state = {"PLTR": _far_expiry_state()}  # net_credit 0.22, max_loss 0.78
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # MID would say current_value = 0.22 - 0.20 = 0.02 → ~91% "profit" (the bug).
    # Executable cost = short_ask 0.40 - long_bid 0.02 = 0.38 → a real loss of
    # 0.16/sh (< 0.39 stop threshold) → must HOLD, not close.
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.04, "ask": 0.40},  # mid 0.22
        "PLTR260619P00007000": {"bid": 0.02, "ask": 0.38},  # mid 0.20
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [], "wide-quote mid must not produce a false profit close"


def test_handle_spread_crossed_quote_skips_cycle(monkeypatch):
    """Degenerate/crossed quote (short_ask <= long_bid → close_cost <= 0)
    must NOT decide anything — skip the cycle, no false profit close."""
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # short_ask 0.05 <= long_bid 0.06 → close_cost = -0.01 → skip
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.03, "ask": 0.05},
        "PLTR260619P00007000": {"bid": 0.06, "ask": 0.08},
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [], "degenerate crossed quote must not trigger any close"


def test_handle_spread_stop_loss_triggers_close(monkeypatch):
    """Mid-based loss per share >= 50% of max_loss → stop_loss_pct.

    The stop is judged on the MID (2026-05-30 fix), not the worst-case
    executable cost, so the bid/ask width can't fake a loss.
    """
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # short_mid 0.72 - long_mid 0.09 = 0.63 close_cost_mid
    # loss_mid = 0.63 - 0.22 = 0.41 >= 50% of 0.78 max_loss (0.39)
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.71, "ask": 0.73},   # mid 0.72
        "PLTR260619P00007000": {"bid": 0.08, "ask": 0.10},   # mid 0.09
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == [("PLTR", "stop_loss_pct")]


def test_handle_spread_stop_does_not_fire_on_wide_bidask(monkeypatch):
    """The bid/ask width alone must NOT trip the stop (the MU bug).

    Mid loss is tiny, but the worst-case executable cost (short_ask - long_bid)
    is huge; the old code stopped out on that executable cost moments after a
    bad fill. The mid-based stop holds.
    """
    state = {"PLTR": _far_expiry_state()}
    monkeypatch.setattr(wheel_strategy, "get_positions", lambda: [
        {"symbol": "PLTR260619P00008000", "asset_class": "us_option", "qty": "-1", "avg_entry_price": "-0.33"},
        {"symbol": "PLTR260619P00007000", "asset_class": "us_option", "qty": "1", "avg_entry_price": "0.11"},
    ])
    # short_ask - long_bid = 0.80 - 0.02 = 0.78 (worst case, would trip old stop)
    # short_mid - long_mid = 0.45 - 0.11 = 0.34 → loss_mid 0.12, under 0.39. HOLD.
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.10, "ask": 0.80},   # mid 0.45
        "PLTR260619P00007000": {"bid": 0.02, "ask": 0.20},   # mid 0.11
    }[sym])
    monkeypatch.setattr(wheel_strategy, "get_latest_price", lambda sym: 9.0)
    closes = []
    monkeypatch.setattr(wheel_strategy, "_close_spread",
                        lambda state, ticker, reason: closes.append((ticker, reason)))

    wheel_strategy.handle_spread(state, "PLTR", account={"cash": "10000"})
    assert closes == []  # bid/ask width alone did not trip the stop


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
    # Executable BTC cost = short_ask 0.12 - long_bid 0.04 = 0.08
    # → profit_pct = (0.22 - 0.08)/0.22 = 0.64 ≥ 0.50
    monkeypatch.setattr(wheel_strategy, "get_option_quote", lambda sym: {
        "PLTR260619P00008000": {"bid": 0.10, "ask": 0.12},
        "PLTR260619P00007000": {"bid": 0.04, "ask": 0.06},
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
    the three threshold globals from config. SPREAD_STOP_LOSS_PCT
    loosened 0.50 → 0.75 on 2026-05-22 after a same-day MU whipsaw
    stop on a routine 1% intraday move."""
    import config
    wheel_strategy.apply_mode("manual")
    assert wheel_strategy.SPREAD_MANAGEMENT is True
    assert wheel_strategy.SPREAD_EARLY_CLOSE_PCT == 0.50
    assert wheel_strategy.SPREAD_STOP_LOSS_PCT == 0.75
    assert wheel_strategy.SPREAD_DTE_FLOOR == 2


def test_apply_mode_live_keeps_spread_management_off():
    wheel_strategy.apply_mode("live")
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
    """If SPREAD_MANAGEMENT is False (e.g. on live mode), a spread_active
    entry is left alone — log heartbeat only, no handler call."""
    import json
    wheel_strategy.apply_mode("live")
    assert wheel_strategy.SPREAD_MANAGEMENT is False

    state = {"_meta": {}, "PLTR": _spread_state()}
    state_file = tmp_path / "wheel_state_live.json"
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


def _seeded_sm_spread_state():
    """Minimal state dict for an active sm1000 spread.

    short P14 @ 0.30 credit (gross), long P13 @ 0.10 → net_credit 0.20,
    width 1.00, max_loss 0.80. Stop at 2x credit = close_cost >= 0.40."""
    return {
        "_meta": {},
        "AMD": {
            "stage": "spread_active",
            "spread_type": "put_credit",
            "expiration": "2099-12-31",   # far future — DTE branch can't fire
            "net_credit": 0.20,
            "max_loss": 0.80,
            "width": 1.0,
            "short_leg": {"occ": "AMD2099P00014000", "strike": 14.0, "premium": 0.30},
            "long_leg":  {"occ": "AMD2099P00013000", "strike": 13.0, "premium": 0.10},
            "open_order_id": None,
        },
    }


def test_handle_spread_sm_stop_fires_at_2x_credit(monkeypatch, apply_sm_mode):
    apply_sm_mode("sm1000")  # arms SPREAD_STOP_CREDIT_MULT=2.0

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # close_cost = short_ask - long_bid = 0.50 - 0.05 = 0.45 → >= 0.20*2.0 → STOP
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.45, "ask": 0.50},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 15.0)  # above short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed["hit"] == ("AMD", "stop_loss_2x_credit")


def test_handle_spread_sm_stop_does_not_fire_below_2x_credit(monkeypatch, apply_sm_mode):
    apply_sm_mode("sm1000")

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # close_cost = 0.30 - 0.05 = 0.25 → < 0.40 → no stop
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 15.0)

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed


def test_handle_spread_non_sm_mode_still_uses_50pct_max_loss(monkeypatch, apply_sm_mode):
    """Manual mode (spread_management on, spread_stop_credit_mult None)
    must keep the legacy 50%-of-max-loss behavior — byte-unaffected."""
    apply_sm_mode("manual")
    assert ws.SPREAD_STOP_CREDIT_MULT is None  # sanity

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # close_cost = 0.45 → loss_per_share = 0.45-0.20 = 0.25 < 0.80*0.50 = 0.40 → no stop
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.45, "ask": 0.50},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 15.0)

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed  # manual's 50%-of-max-loss didn't fire either


def test_handle_spread_sm_underlying_tripwire_put_credit(monkeypatch, apply_sm_mode):
    """Put credit spread: stock trading <= short strike → close immediately."""
    apply_sm_mode("sm1000")

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    # Quote is fine, 2x stop NOT triggered, but stock crossed short strike.
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 13.95)  # below $14

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed["hit"] == ("AMD", "underlying_tripwire")


def test_handle_spread_sm_underlying_tripwire_not_fired_above_strike(monkeypatch, apply_sm_mode):
    apply_sm_mode("sm1000")

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 14.05)  # above $14

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed


def _manual_tripwire_mocks(monkeypatch, stock_price):
    """Wire positions + non-degenerate quotes + a stock price for a manual
    spread tripwire test. Short strike is $14 (from _seeded_sm_spread_state)."""
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: stock_price)


def _near_expiry_manual_state():
    """Seeded manual spread expiring inside the tripwire DTE gate (≤2 days)."""
    from datetime import date as _d, timedelta as _td
    state = _seeded_sm_spread_state()
    state["AMD"]["expiration"] = (_d.today() + _td(days=1)).isoformat()
    return state


def test_handle_spread_manual_tripwire_not_armed_far_from_expiry(monkeypatch, apply_sm_mode):
    """Manual (2026-06-16): far from expiry, a touch of the short strike is
    noise — the tripwire isn't even armed (the QQQ 9-DTE case). No close, and
    no breach timestamp is recorded."""
    apply_sm_mode("manual")
    assert ws.SPREAD_TRIPWIRE_DTE == 2
    assert ws.SPREAD_TRIPWIRE_CONFIRM_MINUTES == 60

    state = _seeded_sm_spread_state()  # expiration 2099-12-31 → far future
    _manual_tripwire_mocks(monkeypatch, 13.95)  # below short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed
    assert state["AMD"].get("tripwire_breach_since") is None


def test_handle_spread_manual_tripwire_pending_on_first_touch(monkeypatch, apply_sm_mode):
    """Manual, near expiry: first touch through the strike records the breach
    and HOLDS — it doesn't close on the first cycle (the MU intraday-wick case)."""
    apply_sm_mode("manual")

    state = _near_expiry_manual_state()
    _manual_tripwire_mocks(monkeypatch, 13.95)  # below short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed
    assert state["AMD"]["tripwire_breach_since"] is not None


def test_handle_spread_manual_tripwire_confirms_after_window(monkeypatch, apply_sm_mode):
    """Manual, near expiry: a breach that has held longer than the confirmation
    window closes the spread."""
    from datetime import datetime, timezone, timedelta
    apply_sm_mode("manual")

    state = _near_expiry_manual_state()
    past = datetime.now(timezone.utc) - timedelta(minutes=61)
    state["AMD"]["tripwire_breach_since"] = past.isoformat().replace("+00:00", "Z")
    _manual_tripwire_mocks(monkeypatch, 13.95)  # still below short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed["hit"] == ("AMD", "underlying_tripwire")


def test_handle_spread_manual_tripwire_resets_on_recovery(monkeypatch, apply_sm_mode):
    """Manual, near expiry: a pending breach is cleared the moment the stock
    recovers above the short strike — the confirmation clock restarts cleanly
    on any later breach (exactly what saved MU/QQQ when they bounced back)."""
    from datetime import datetime, timezone, timedelta
    apply_sm_mode("manual")

    state = _near_expiry_manual_state()
    past = datetime.now(timezone.utc) - timedelta(minutes=30)
    state["AMD"]["tripwire_breach_since"] = past.isoformat().replace("+00:00", "Z")
    _manual_tripwire_mocks(monkeypatch, 14.25)  # recovered above short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed
    assert state["AMD"]["tripwire_breach_since"] is None


def test_handle_spread_sm_tripwire_still_immediate_at_all_dte(monkeypatch, apply_sm_mode):
    """SM modes are byte-unaffected by the manual noise-tolerance change: the
    DTE gate is inactive (None) and the confirmation window is 0, so a touch of
    the short strike closes immediately at any DTE — the original behavior."""
    apply_sm_mode("sm1000")
    assert ws.SPREAD_TRIPWIRE_DTE is None
    assert ws.SPREAD_TRIPWIRE_CONFIRM_MINUTES == 0

    state = _seeded_sm_spread_state()  # far-future expiry
    _manual_tripwire_mocks(monkeypatch, 13.95)  # below short strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed["hit"] == ("AMD", "underlying_tripwire")


def test_handle_spread_conservative_tripwire_inactive(monkeypatch, apply_sm_mode):
    """Conservative/aggressive get neither the tripwire nor spread management —
    SPREAD_UNDERLYING_TRIPWIRE stays off there (byte-unaffected)."""
    apply_sm_mode("conservative")
    assert ws.SPREAD_UNDERLYING_TRIPWIRE is False

    state = _seeded_sm_spread_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: 13.95)  # below strike

    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
        lambda st, t, reason: closed.setdefault("hit", (t, reason)))

    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed  # conservative: tripwire never armed


# ── R8/R9: tripwire-pending defers ONLY the loss-stop; DTE-floor price guard ──

def _wire_spread(monkeypatch, short_q, long_q, stock_price):
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": short_q,
        "AMD2099P00013000": long_q,
    }[occ])
    monkeypatch.setattr(ws, "get_latest_price", lambda s: stock_price)


def test_tripwire_pending_still_takes_profit(monkeypatch, apply_sm_mode):
    """R8: a 50%-profit close must still fire while a tripwire breach is pending
    (the real bug — a winner shouldn't be blocked by a strike wick)."""
    apply_sm_mode("manual")
    state = _near_expiry_manual_state()  # ~1 DTE, short strike 14
    # close_cost exec = short_ask 0.08 − long_bid 0.01 = 0.07; net_credit 0.20 →
    # profit_pct 0.65 ≥ 0.50. Stock 13.95 breaches the strike (pending).
    _wire_spread(monkeypatch, {"bid": 0.04, "ask": 0.08}, {"bid": 0.01, "ask": 0.02}, 13.95)
    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
                        lambda st, t, reason: closed.setdefault("hit", (t, reason)))
    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert closed.get("hit") == ("AMD", "early_close_50pct")


def test_tripwire_pending_defers_loss_stop(monkeypatch, apply_sm_mode):
    """R8: the loss-stop IS deferred while a breach is pending (noise tolerance
    preserved) — the spread is held, not stopped out, on the wick."""
    apply_sm_mode("manual")
    state = _near_expiry_manual_state()
    # mid loss well past the stop: close_cost_mid = 0.90 − 0.05 = 0.85; loss_mid
    # 0.65. But pending defers the stop. Profit is negative (exec 0.95 − 0.02).
    _wire_spread(monkeypatch, {"bid": 0.85, "ask": 0.95}, {"bid": 0.02, "ask": 0.08}, 13.95)
    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
                        lambda st, t, reason: closed.setdefault("hit", (t, reason)))
    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed
    assert state["AMD"]["tripwire_breach_since"] is not None


def test_tripwire_pending_defers_dte_floor(monkeypatch, apply_sm_mode):
    """R8: the DTE-floor is ALSO deferred while pending — at ≤2 DTE it's the same
    signal as the tripwire, and the confirmation window exists to let the wick
    recover (the MU case). It must not nullify that window."""
    apply_sm_mode("manual")
    state = _near_expiry_manual_state()  # ~1 DTE
    # neutral quotes (no profit, no degenerate); stock 13.95 ITM + pending.
    _wire_spread(monkeypatch, {"bid": 0.25, "ask": 0.30}, {"bid": 0.05, "ask": 0.10}, 13.95)
    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
                        lambda st, t, reason: closed.setdefault("hit", (t, reason)))
    ws.handle_spread(state, "AMD", account={"cash": 1000})
    assert "hit" not in closed  # DTE-floor did NOT fire during pending


def test_dte_floor_price_fetch_guarded(monkeypatch, apply_sm_mode):
    """R9: a network error fetching the price in the DTE-floor block must not
    crash the symbol cycle (it used to propagate and skip the close)."""
    apply_sm_mode("manual")
    monkeypatch.setattr(ws, "SPREAD_UNDERLYING_TRIPWIRE", False)  # isolate the DTE-floor path
    state = _near_expiry_manual_state()
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])

    def boom(_):
        raise RuntimeError("network down")
    monkeypatch.setattr(ws, "get_latest_price", boom)
    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
                        lambda st, t, reason: closed.setdefault("hit", (t, reason)))
    ws.handle_spread(state, "AMD", account={"cash": 1000})  # must not raise
    assert "hit" not in closed


def test_handle_spread_invalid_net_credit_skips_not_crash(monkeypatch, apply_sm_mode):
    """R10: a corrupted state with net_credit=None must skip the cycle with a
    warning, not crash the symbol and leave the spread unmanaged."""
    apply_sm_mode("manual")
    state = _seeded_sm_spread_state()
    state["AMD"]["net_credit"] = None
    monkeypatch.setattr(ws, "get_positions", lambda: [
        {"symbol": "AMD2099P00014000", "asset_class": "us_option"},
        {"symbol": "AMD2099P00013000", "asset_class": "us_option"},
    ])
    monkeypatch.setattr(ws, "get_option_quote", lambda occ: {
        "AMD2099P00014000": {"bid": 0.25, "ask": 0.30},
        "AMD2099P00013000": {"bid": 0.05, "ask": 0.10},
    }[occ])
    closed = {}
    monkeypatch.setattr(ws, "_close_spread",
                        lambda st, t, r: closed.setdefault("hit", (t, r)))
    ws.handle_spread(state, "AMD", account={"cash": 1000})  # must not raise
    assert "hit" not in closed
    assert "AMD" in state  # state not deleted


# ── R13: resolve a pending bot-opened spread by client_order_id when the
#         numeric order id is lost (prevents misreading it as "gone") ──────────

def test_resolve_pending_spread_adopted_both_ids_none():
    # Adopted/hand-opened spread (neither id) → existing position/orphan path.
    assert ws._resolve_pending_spread(
        {"open_order_id": None, "open_client_order_id": None}) == "gone"


def test_resolve_pending_spread_uses_client_id_when_numeric_lost(monkeypatch, apply_sm_mode):
    from datetime import datetime
    apply_sm_mode("sm1000")
    sym = {"open_order_id": None, "open_client_order_id": "sm1000-abc",
           "opened_at": datetime.utcnow().isoformat() + "Z"}
    monkeypatch.setattr(ws, "_get_order_by_client_id",
                        lambda c: {"status": "accepted"} if c == "sm1000-abc" else None)
    monkeypatch.setattr(ws, "get_order",
                        lambda oid: (_ for _ in ()).throw(AssertionError("should use client id")))
    assert ws._resolve_pending_spread(sym) == "pending"


def test_resolve_pending_spread_client_id_filled(monkeypatch, apply_sm_mode):
    apply_sm_mode("sm1000")
    sym = {"open_order_id": None, "open_client_order_id": "sm1000-abc"}
    monkeypatch.setattr(ws, "_get_order_by_client_id", lambda c: {"status": "filled"})
    assert ws._resolve_pending_spread(sym) == "filled"


def test_resolve_pending_spread_numeric_id_preferred(monkeypatch, apply_sm_mode):
    apply_sm_mode("sm1000")
    sym = {"open_order_id": "ord-1", "open_client_order_id": "sm1000-abc"}
    monkeypatch.setattr(ws, "get_order",
                        lambda oid: {"status": "filled"} if oid == "ord-1" else None)
    assert ws._resolve_pending_spread(sym) == "filled"
