"""Unit tests for the wheel state machine — focus on Stage 2 / assignment paths.

These tests mock every Alpaca API call (so no network, no real account, no
Discord webhooks) and verify the transitions:

  Stage 1: pending → just_filled → tracking → 50%-close → expired_worthless → assigned
  Stage 2: pending → just_filled → tracking → 50%-close → expired_worthless → call_assigned
"""
import wheel_strategy as ws


# ── Helpers ──────────────────────────────────────────────────────────────

def _account(cash=100000):
    return {"cash": str(cash), "portfolio_value": str(cash)}


def _filled_order(price=4.10):
    return {"id": "order-x", "status": "filled", "filled_avg_price": str(price)}


def _pending_order():
    return {"id": "order-x", "status": "new", "filled_avg_price": None}


def _option_position(market_value=-365.0):
    """A short put position. Negative market_value because we sold to open."""
    return {"qty": "-1", "avg_entry_price": "4.10", "market_value": str(market_value)}


def _stock_position_100(symbol="TSLA", avg=340.0):
    return {"qty": "100", "avg_entry_price": str(avg)}


def _option_contract(symbol_ticker, strike=340, option_type="put", expiry="2026-05-22"):
    occ_symbol = f"{symbol_ticker}260522{'P' if option_type=='put' else 'C'}{int(strike)*1000:08d}"
    return {
        "symbol": occ_symbol,
        "strike_price": str(float(strike)),
        "expiration_date": expiry,
        "close_price": "4.10",
    }


# ── Stage 1: order placement, pending, filled ────────────────────────────

def test_stage1_no_contract_sells_new_put(monkeypatch, fresh_symbol_state):
    """Stage 1 + no contract → calls _sell_new_put."""
    placed = []

    def fake_find(sym, opt_type, target, *_):
        return _option_contract("TSLA", strike=340, option_type=opt_type)

    def fake_place(option_symbol, limit_price):
        placed.append({"symbol": option_symbol, "limit_price": limit_price})
        return {"id": "abc-123"}

    monkeypatch.setattr(ws, "find_best_contract", fake_find)
    monkeypatch.setattr(ws, "place_sell_to_open", fake_place)

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=380.0, account=_account(100000))

    assert len(placed) == 1
    assert fresh_symbol_state["current_contract"] is not None
    assert fresh_symbol_state["contract_strike"] == 340.0
    assert fresh_symbol_state["contract_type"] == "put"
    assert fresh_symbol_state["stage"] == 1


def test_stage1_pending_order_skips_cycle(monkeypatch, fresh_symbol_state):
    """Order placed but not filled → state unchanged, no further action."""
    fresh_symbol_state["current_contract"] = "TSLA260522P00340000"
    fresh_symbol_state["contract_order_id"] = "pending-abc"
    fresh_symbol_state["contract_entry_price"] = None

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "get_order", lambda oid: _pending_order())

    place_called = []
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda *a, **kw: place_called.append(a) or {"id": "x"})

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=380.0, account=_account())

    assert place_called == []  # no new put placed
    assert fresh_symbol_state["current_contract"] == "TSLA260522P00340000"  # unchanged
    assert "Awaiting fill" in fresh_symbol_state["last_action"]


def test_stage1_just_filled_records_entry_price(monkeypatch, fresh_symbol_state):
    """Order transitioned to filled → entry_price recorded, no other action."""
    fresh_symbol_state["current_contract"] = "TSLA260522P00340000"
    fresh_symbol_state["contract_order_id"] = "filled-abc"
    fresh_symbol_state["contract_entry_price"] = None

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "get_order", lambda oid: _filled_order(price=4.10))

    place_called = []
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda *a, **kw: place_called.append(a) or {"id": "x"})

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=380.0, account=_account())

    assert fresh_symbol_state["contract_entry_price"] == 4.10
    assert fresh_symbol_state["current_contract"] == "TSLA260522P00340000"  # unchanged
    assert place_called == []


def test_stage1_position_open_recovers_entry_price(monkeypatch, fresh_symbol_state):
    """When position exists but entry_price was never recorded, look it up."""
    fresh_symbol_state["current_contract"] = "TSLA260522P00340000"
    fresh_symbol_state["contract_order_id"] = "filled-abc"
    fresh_symbol_state["contract_entry_price"] = None

    monkeypatch.setattr(ws, "get_option_position", lambda c: _option_position())
    monkeypatch.setattr(ws, "get_order", lambda oid: _filled_order(price=4.10))
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: 3.65)

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=380.0, account=_account())

    assert fresh_symbol_state["contract_entry_price"] == 4.10  # recovered!


def test_stage1_position_open_at_50pct_profit_closes_early(monkeypatch, fresh_symbol_state):
    """Put price dropped to ≤ 50% of entry → buy-to-close + sell new put."""
    fresh_symbol_state["current_contract"] = "TSLA260522P00340000"
    fresh_symbol_state["contract_order_id"] = "abc"
    fresh_symbol_state["contract_entry_price"] = 4.10

    closes = []
    sells  = []

    monkeypatch.setattr(ws, "get_option_position", lambda c: _option_position())
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: 2.00)  # < 50% of 4.10
    monkeypatch.setattr(ws, "place_buy_to_close",
                        lambda c, p: closes.append((c, p)) or {"id": "close-1"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=340))
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p: sells.append((c, p)) or {"id": "new-put"})

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=380.0, account=_account(100000))

    assert len(closes) == 1
    assert len(sells) == 1  # new put sold immediately after close
    # Premium captured: (4.10 - 2.00) * 100 = $210
    assert fresh_symbol_state["total_premium_collected"] == 210.0


# ── Stage 1: assignment transition (stage 1 → stage 2) ───────────────────

def test_stage1_assignment_transitions_to_stage2(monkeypatch, fresh_symbol_state):
    """Put expired ITM, broker assigned us 100 shares → flip to Stage 2."""
    fresh_symbol_state["current_contract"] = "TSLA260522P00340000"
    fresh_symbol_state["contract_order_id"] = "abc"
    fresh_symbol_state["contract_entry_price"] = 4.10

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    # Order is "filled" status (already long-filled), but contract is now gone:
    # set order to canceled-equivalent so _resolve_pending_contract returns "gone"
    monkeypatch.setattr(ws, "get_order",
                        lambda oid: {"id": oid, "status": "expired", "filled_avg_price": "4.10"})
    monkeypatch.setattr(ws, "get_stock_position", lambda s: _stock_position_100("TSLA", avg=340.0))

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=320.0, account=_account())

    assert fresh_symbol_state["stage"] == 2
    assert fresh_symbol_state["shares_qty"] == 100
    assert fresh_symbol_state["cost_basis_per_share"] == 340.0
    assert fresh_symbol_state["current_contract"] is None  # cleared, ready to sell call
    # Cycle history should record the assignment
    assert any(h["outcome"] == "assigned" for h in fresh_symbol_state["cycle_history"])


def test_stage1_expired_worthless_sells_new_put(monkeypatch, fresh_symbol_state):
    """Put expired worthless (no shares) → collect premium, sell new put."""
    fresh_symbol_state["current_contract"] = "TSLA260522P00340000"
    fresh_symbol_state["contract_order_id"] = "abc"
    fresh_symbol_state["contract_entry_price"] = 4.10

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "get_order",
                        lambda oid: {"id": oid, "status": "expired", "filled_avg_price": "4.10"})
    monkeypatch.setattr(ws, "get_stock_position", lambda s: None)
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=340))

    sells = []
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p: sells.append((c, p)) or {"id": "new-put"})

    ws.handle_stage1("TSLA", fresh_symbol_state, stock_price=380.0, account=_account(100000))

    assert fresh_symbol_state["stage"] == 1  # still stage 1
    assert fresh_symbol_state["total_premium_collected"] == 410.0  # $4.10 * 100
    assert fresh_symbol_state["cycle_count"] == 1
    assert len(sells) == 1  # new put placed
    assert any(h["outcome"] == "expired_worthless" for h in fresh_symbol_state["cycle_history"])


# ── Stage 2: covered call lifecycle ──────────────────────────────────────

def _stage2_state():
    """Helper: pre-loaded Stage 2 state representing 'we just got assigned'."""
    state = ws._empty_symbol_state()
    state["stage"] = 2
    state["shares_qty"] = 100
    state["cost_basis_per_share"] = 340.0
    state["total_cost"] = 34000.0
    return state


def test_stage2_no_contract_sells_new_call(monkeypatch):
    """Stage 2 + no current call → sells a covered call above cost basis."""
    state = _stage2_state()

    sells = []
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=375, option_type="call"))
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p: sells.append((c, p)) or {"id": "new-call"})

    ws.handle_stage2("TSLA", state, stock_price=345.0, account=_account())

    assert len(sells) == 1
    assert state["contract_type"] == "call"
    assert state["contract_strike"] >= 340.0  # never below cost basis


def test_stage2_call_assigned_returns_to_stage1(monkeypatch):
    """Call expired ITM, shares were called away → back to Stage 1."""
    state = _stage2_state()
    state["current_contract"] = "TSLA260522C00375000"
    state["contract_order_id"] = "call-abc"
    state["contract_entry_price"] = 2.50
    state["contract_strike"] = 375.0

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "get_order",
                        lambda oid: {"id": oid, "status": "expired", "filled_avg_price": "2.50"})
    # Shares are gone (qty < 100)
    monkeypatch.setattr(ws, "get_stock_position", lambda s: None)
    # Will then try to sell a new put
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=315, option_type="put"))
    monkeypatch.setattr(ws, "place_sell_to_open", lambda c, p: {"id": "new-put"})

    ws.handle_stage2("TSLA", state, stock_price=380.0, account=_account())

    assert state["stage"] == 1
    assert state["shares_qty"] == 0
    assert state["cost_basis_per_share"] is None
    assert state["total_premium_collected"] == 250.0  # $2.50 × 100
    assert any(h["outcome"] == "assigned" and h["type"] == "call"
               for h in state["cycle_history"])


def test_stage2_call_expired_worthless_sells_new_call(monkeypatch):
    """Call expired worthless (we still have shares) → sell another call."""
    state = _stage2_state()
    state["current_contract"] = "TSLA260522C00375000"
    state["contract_order_id"] = "call-abc"
    state["contract_entry_price"] = 2.50
    state["contract_strike"] = 375.0

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "get_order",
                        lambda oid: {"id": oid, "status": "expired", "filled_avg_price": "2.50"})
    # Still own 100 shares
    monkeypatch.setattr(ws, "get_stock_position",
                        lambda s: _stock_position_100("TSLA", avg=340.0))
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=375, option_type="call"))
    monkeypatch.setattr(ws, "place_sell_to_open", lambda c, p: {"id": "new-call"})

    ws.handle_stage2("TSLA", state, stock_price=350.0, account=_account())

    assert state["stage"] == 2  # still stage 2
    assert state["shares_qty"] == 100  # still own shares
    assert state["total_premium_collected"] == 250.0


def test_stage2_50pct_close_buys_back_then_sells_new_call(monkeypatch):
    """Call dropped to ≤50% of entry → buy-to-close + sell new call."""
    state = _stage2_state()
    state["current_contract"] = "TSLA260522C00375000"
    state["contract_order_id"] = "call-abc"
    state["contract_entry_price"] = 2.50
    state["contract_strike"] = 375.0

    closes = []
    sells  = []

    monkeypatch.setattr(ws, "get_option_position", lambda c: _option_position())
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: 1.20)  # < 50% of 2.50
    monkeypatch.setattr(ws, "place_buy_to_close",
                        lambda c, p: closes.append((c, p)) or {"id": "close-call"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=375, option_type="call"))
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p: sells.append((c, p)) or {"id": "new-call"})

    ws.handle_stage2("TSLA", state, stock_price=345.0, account=_account())

    assert len(closes) == 1
    assert len(sells) == 1
    # Captured premium: (2.50 - 1.20) * 100 = $130
    assert state["total_premium_collected"] == 130.0


def test_stage2_call_strike_never_below_cost_basis(monkeypatch):
    """The find_best_contract result is rejected if its strike < cost basis."""
    state = _stage2_state()  # cost basis = 340.0

    sells = []
    # Force find_best_contract to return a contract BELOW cost basis
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=320, option_type="call"))
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p: sells.append((c, p)) or {"id": "x"})

    ws.handle_stage2("TSLA", state, stock_price=345.0, account=_account())

    # Should refuse — no order placed
    assert sells == []
    assert state["current_contract"] is None  # nothing was recorded


# ── State migration & init ───────────────────────────────────────────────

def test_migrate_legacy_single_stock_state():
    """Old format (top-level stage) should migrate cleanly to multi-stock."""
    legacy = {
        "stage": 1,
        "current_contract": "TSLA260522P00340000",
        "contract_entry_price": 4.10,
        "total_premium_collected": 85.0,
        "cycle_count": 1,
        "cycle_history": [],
        "last_checked": "2026-04-28T12:00:00Z",
    }
    migrated = ws._migrate_state(legacy)
    assert "_meta" in migrated
    assert "TSLA" in migrated
    assert migrated["TSLA"]["current_contract"] == "TSLA260522P00340000"
    assert migrated["TSLA"]["contract_entry_price"] == 4.10
    assert migrated["_meta"]["last_checked"] == "2026-04-28T12:00:00Z"
    assert "stage" not in migrated  # top-level stage is gone


def test_migrate_already_multistock_unchanged():
    """Multi-stock state passes through unchanged."""
    multi = {
        "_meta": {"last_checked": "..."},
        "TSLA": {"stage": 1, "current_contract": "x"},
        "BAC": {"stage": 1, "current_contract": None},
    }
    out = ws._migrate_state(multi)
    assert out is multi  # same reference, no transformation


def test_empty_symbol_state_has_required_fields():
    """A fresh symbol state has every field handle_stage1 expects."""
    s = ws._empty_symbol_state()
    required = [
        "stage", "current_contract", "contract_order_id", "contract_entry_price",
        "contract_entry_date", "contract_expiration", "contract_type", "contract_strike",
        "cost_basis_per_share", "shares_qty", "total_cost", "total_premium_collected",
        "total_premium_today", "cycle_count", "cycle_history", "last_action",
    ]
    for field in required:
        assert field in s, f"missing field: {field}"
    assert s["stage"] == 1
    assert s["cycle_count"] == 0
    assert s["total_premium_collected"] == 0.0


# ── Insufficient cash ────────────────────────────────────────────────────

def test_stage1_insufficient_cash_does_not_place_order(monkeypatch, fresh_symbol_state):
    """If cash < strike * 100, refuse to sell put."""
    sells = []
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p: sells.append((c, p)) or {"id": "x"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=340))

    ws.handle_stage1("TSLA", fresh_symbol_state,
                      stock_price=380.0,
                      account=_account(cash=10000))  # only $10k, need $34k

    assert sells == []
    assert "Insufficient cash" in fresh_symbol_state["last_action"]
    assert fresh_symbol_state["current_contract"] is None
