"""Unit tests for the wheel state machine — focus on Stage 2 / assignment paths.

These tests mock every Alpaca API call (so no network, no real account, no
Discord webhooks) and verify the transitions:

  Stage 1: pending → just_filled → tracking → 50%-close → expired_worthless → assigned
  Stage 2: pending → just_filled → tracking → 50%-close → expired_worthless → call_assigned
"""
import wheel_strategy as ws


# ── Helpers ──────────────────────────────────────────────────────────────

def _account(cash=100000, options_buying_power=None):
    """Mock account dict. options_buying_power defaults to cash (matches
    a brand-new account with nothing reserved). Tests that exercise the
    insufficient-BP branch can pass a lower options_buying_power explicitly."""
    if options_buying_power is None:
        options_buying_power = cash
    return {
        "cash": str(cash),
        "options_buying_power": str(options_buying_power),
        "portfolio_value": str(cash),
    }


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
                        lambda c, p, qty=1: closes.append((c, p)) or {"id": "close-1"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=340))
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "new-put"})

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
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "new-put"})

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
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "new-call"})

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
    monkeypatch.setattr(ws, "place_sell_to_open", lambda c, p, qty=1: {"id": "new-put"})

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
    monkeypatch.setattr(ws, "place_sell_to_open", lambda c, p, qty=1: {"id": "new-call"})

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
                        lambda c, p, qty=1: closes.append((c, p)) or {"id": "close-call"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=375, option_type="call"))
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "new-call"})

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
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "x"})

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


# ── Strike rounding & quote pricing ──────────────────────────────────────

def test_strike_increment_under_25_is_one_dollar():
    assert ws.strike_increment(10) == 1.0
    assert ws.strike_increment(12.50) == 1.0
    assert ws.strike_increment(24.99) == 1.0


def test_strike_increment_25_and_above_is_five_dollars():
    assert ws.strike_increment(25) == 5.0
    assert ws.strike_increment(40) == 5.0
    assert ws.strike_increment(376) == 5.0


def test_round_strike_low_priced_uses_one_dollar():
    """SOFI at ~$12 → 10% OTM = $10.80 → round to $11 (NOT $10 like the old $5 logic)."""
    assert ws.round_strike(10.80, 12) == 11
    assert ws.round_strike(9.30, 10.33) == 9
    assert ws.round_strike(8.55, 9.50) == 9


def test_round_strike_high_priced_still_uses_five_dollars():
    """TSLA at $376 → 10% OTM = $338.40 → round to $340 (same as before)."""
    assert ws.round_strike(338.40, 376) == 340
    assert ws.round_strike(54.00, 60.00) == 55  # KO-like
    assert ws.round_strike(36.00, 40.00) == 35  # BAC-like


def test_compute_limit_price_uses_quote_midpoint(monkeypatch):
    """When live quote is available, limit = midpoint of bid/ask."""
    monkeypatch.setattr(ws, "get_option_quote",
                        lambda c: {"bid": 0.40, "ask": 0.50})
    contract = {"close_price": "0.45"}  # would give $0.44 under old logic
    assert ws.compute_limit_price("BAC260522P00040000", contract) == 0.45  # midpoint


def test_compute_limit_price_falls_back_to_close_98pct(monkeypatch):
    """When no quote available, fall back to close_price × 0.98."""
    monkeypatch.setattr(ws, "get_option_quote", lambda c: None)
    contract = {"close_price": "1.00"}
    assert ws.compute_limit_price("XYZ", contract) == 0.98


def test_compute_limit_price_last_resort_dollar(monkeypatch):
    """No quote AND no close_price → $1.00 last resort."""
    monkeypatch.setattr(ws, "get_option_quote", lambda c: None)
    contract = {}
    assert ws.compute_limit_price("XYZ", contract) == 1.00


# ── Insufficient buying power ────────────────────────────────────────────

def test_stage1_insufficient_bp_does_not_place_order(monkeypatch, fresh_symbol_state):
    """If options_buying_power < strike * 100, refuse to sell put.

    Crucially we check options_buying_power, NOT cash. Cash can be high
    while options BP is depleted by pending orders or existing shorts;
    using cash here would let the wheel try to place orders Alpaca will
    reject with HTTP 403 (which is exactly the bug this test guards
    against — see the INTC 403 incident on 2026-04-30)."""
    sells = []
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "x"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("TSLA", strike=340))

    # Cash is plentiful but options BP is depleted — the realistic Alpaca
    # state when many pending/open option orders are tying up collateral.
    ws.handle_stage1("TSLA", fresh_symbol_state,
                      stock_price=380.0,
                      account=_account(cash=100000, options_buying_power=10000))  # $10k BP, need $34k

    assert sells == []
    assert "Insufficient options BP" in fresh_symbol_state["last_action"]


def test_stage1_uses_options_bp_not_cash(monkeypatch, fresh_symbol_state):
    """Direct regression test for the INTC 403 bug: even when cash is
    huge, if options_buying_power is small the wheel must skip rather
    than try to place an order Alpaca will reject."""
    sells = []
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p, qty=1: sells.append((c, p)) or {"id": "x"})
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("INTC", strike=80))

    # The exact scenario from prod: $97k cash but only $3k options BP.
    # INTC $80 put needs $8k → must be skipped, NOT attempted.
    ws.handle_stage1("INTC", fresh_symbol_state,
                      stock_price=94.0,
                      account=_account(cash=97000, options_buying_power=3000))

    assert sells == []  # NEVER attempted the order
    assert fresh_symbol_state["current_contract"] is None
    assert fresh_symbol_state["current_contract"] is None


# ── place_buy_to_close uses actual position qty ──────────────────────────

def test_place_buy_to_close_closes_full_position_qty(monkeypatch):
    """Regression test for the MARA qty=-4 incident. When the wheel
    decides to close, it must close ALL contracts at that symbol, not
    just one. Otherwise the duplicate-sell-bug fallout (or any external
    multi-contract position) leaves orphan shorts the wheel can't manage."""
    posted = []
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"qty": "-4", "avg_entry_price": "0.40"})
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "x"})

    ws.place_buy_to_close("MARA260508P00011000", 0.20)

    assert len(posted) == 1
    assert posted[0]["qty"] == "4"           # not "1"!
    assert posted[0]["symbol"] == "MARA260508P00011000"
    assert posted[0]["side"] == "buy"
    assert posted[0]["position_intent"] == "buy_to_close"


def test_place_buy_to_close_skips_when_no_position(monkeypatch):
    """If Alpaca shows no position, don't place an order. Guards against
    submitting a phantom buy-to-close after the position was already
    closed by some other path (manual close, expiration, etc.)."""
    posted = []
    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "x"})

    result = ws.place_buy_to_close("XYZ260522P00010000", 0.20)
    assert result is None
    assert posted == []


def test_place_buy_to_close_skips_when_qty_zero(monkeypatch):
    """Defensive: if Alpaca returns a position with qty=0 for any reason,
    don't try to send a qty=0 order (Alpaca would reject)."""
    posted = []
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"qty": "0", "avg_entry_price": "0.40"})
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "x"})

    result = ws.place_buy_to_close("XYZ260522P00010000", 0.20)
    assert result is None
    assert posted == []


def test_place_buy_to_close_explicit_qty_overrides_lookup(monkeypatch):
    """When caller passes an explicit qty, skip the position lookup.
    Lets us do deliberate partial closes if we ever need to."""
    posted = []
    # Would crash if accidentally called — proves we didn't
    def boom(c):
        raise AssertionError("get_option_position should not have been called")
    monkeypatch.setattr(ws, "get_option_position", boom)
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "x"})

    ws.place_buy_to_close("XYZ260522P00010000", 0.20, qty=2)

    assert posted[0]["qty"] == "2"


def test_place_buy_to_close_normal_single_contract_unchanged(monkeypatch):
    """Common case (qty=-1) still works exactly the same — closes 1 contract.
    Just verifies the auto-lookup behaves correctly for the typical case."""
    posted = []
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"qty": "-1", "avg_entry_price": "4.10"})
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "x"})

    ws.place_buy_to_close("TSLA260522P00340000", 2.00)

    assert posted[0]["qty"] == "1"


# ── Multi-contract premium accounting ────────────────────────────────────

def test_stage1_expired_worthless_multi_contract_premium(monkeypatch):
    """If contract_qty=4 (e.g., MARA from the duplicate-sell incident) and
    all 4 expire worthless, premium = entry × 100 × 4, not just × 100."""
    state = ws._empty_symbol_state()
    state["current_contract"]    = "MARA260508P00011000"
    state["contract_order_id"]   = "x"
    state["contract_entry_price"] = 0.40
    state["contract_qty"]        = 4

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)  # expired
    monkeypatch.setattr(ws, "get_stock_position",  lambda s: None)  # no assignment
    monkeypatch.setattr(ws, "get_order", lambda o: {"status": "expired"})
    # Avoid recursion into _sell_new_put — irrelevant to premium math
    monkeypatch.setattr(ws, "_sell_new_put", lambda *a, **kw: None)

    ws.handle_stage1("MARA", state, stock_price=12.0, account=_account())

    # entry $0.40 × 100 × 4 contracts = $160 premium captured
    assert state["total_premium_collected"] == 160.0


def test_stage1_50pct_close_multi_contract_premium(monkeypatch):
    """If contract_qty=4 and 50% close fires, premium captured for all 4."""
    state = ws._empty_symbol_state()
    state["current_contract"]    = "MARA260508P00011000"
    state["contract_order_id"]   = "x"
    state["contract_entry_price"] = 0.40
    state["contract_qty"]        = 4

    # Position exists at half entry price → triggers 50% close
    monkeypatch.setattr(ws, "get_option_position",
                        lambda c: {"qty": "-4", "avg_entry_price": "0.40", "market_value": "-80"})
    monkeypatch.setattr(ws, "get_option_last_price", lambda c: 0.10)  # 75% profit
    posted = []
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "y"})
    monkeypatch.setattr(ws, "_sell_new_put", lambda *a, **kw: None)

    ws.handle_stage1("MARA", state, stock_price=12.0, account=_account())

    # ($0.40 - $0.10) × 100 × 4 = $120 premium captured
    assert state["total_premium_collected"] == 120.0
    # And the buy-to-close order was for qty=4 (not qty=1)
    assert posted[0]["qty"] == "4"


def test_stage1_assigned_captures_actual_shares(monkeypatch):
    """If 4 short puts get assigned at once, capture all 400 shares (NOT 100)."""
    state = ws._empty_symbol_state()
    state["current_contract"]   = "MARA260508P00011000"
    state["contract_order_id"]  = "x"
    state["contract_entry_price"] = 0.40
    state["contract_qty"]       = 4

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    # Alpaca shows 400 shares assigned (4 puts × 100 shares each)
    monkeypatch.setattr(ws, "get_stock_position",
                        lambda s: {"qty": "400", "avg_entry_price": "11.00"})
    monkeypatch.setattr(ws, "get_order", lambda o: {"status": "expired"})

    ws.handle_stage1("MARA", state, stock_price=10.5, account=_account())

    assert state["stage"]                 == 2
    assert state["shares_qty"]            == 400         # not 100!
    assert state["cost_basis_per_share"]  == 11.00
    assert state["total_cost"]            == 4400.00     # 11 × 400


def test_sell_new_call_uses_shares_qty_for_contract_count(monkeypatch):
    """With 400 shares from a quad-assignment, _sell_new_call must sell 4 calls."""
    state = ws._empty_symbol_state()
    state["stage"]               = 2
    state["shares_qty"]          = 400
    state["cost_basis_per_share"] = 11.00

    monkeypatch.setattr(ws, "find_best_contract",
                        lambda *a, **kw: _option_contract("MARA", strike=12, option_type="call"))
    monkeypatch.setattr(ws, "compute_limit_price", lambda *a: 0.50)
    posted = []
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "z"})

    ws._sell_new_call("MARA", state, stock_price=11.5, cost_basis=11.00)

    assert len(posted) == 1
    assert posted[0]["qty"] == "4"  # 400 shares // 100 = 4 calls
    assert posted[0]["side"] == "sell"
    assert state["contract_qty"] == 4


def test_sell_new_call_skips_when_under_100_shares(monkeypatch):
    """Should refuse to sell a covered call with fewer than 100 shares."""
    state = ws._empty_symbol_state()
    state["stage"]               = 2
    state["shares_qty"]          = 50  # not enough to cover any call
    state["cost_basis_per_share"] = 11.00

    posted = []
    monkeypatch.setattr(ws, "api_post",
                        lambda path, body: posted.append(body) or {"id": "z"})

    ws._sell_new_call("MARA", state, stock_price=11.5, cost_basis=11.00)

    assert posted == []  # never placed an order
    assert "50 shares" in state["last_action"]


def test_stage2_call_expired_multi_contract_premium(monkeypatch):
    """If we sold 4 covered calls and all 4 expired worthless, premium is 4× single."""
    state = ws._empty_symbol_state()
    state["stage"]                 = 2
    state["shares_qty"]            = 400
    state["cost_basis_per_share"]  = 11.00
    state["current_contract"]      = "MARA260515C00012000"
    state["contract_order_id"]     = "y"
    state["contract_entry_price"]  = 0.30
    state["contract_qty"]          = 4
    state["contract_strike"]       = 12.0

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)  # expired
    monkeypatch.setattr(ws, "get_stock_position",  lambda s: {"qty": "400", "avg_entry_price": "11.00"})
    monkeypatch.setattr(ws, "get_order", lambda o: {"status": "expired"})
    monkeypatch.setattr(ws, "_sell_new_call", lambda *a, **kw: None)

    ws.handle_stage2("MARA", state, stock_price=11.50, account=_account())

    # $0.30 × 100 × 4 = $120 premium collected
    assert state["total_premium_collected"] == 120.0


def test_stage2_call_assigned_multi_contract_premium(monkeypatch):
    """If 4 covered calls all get assigned, premium captured + back to Stage 1."""
    state = ws._empty_symbol_state()
    state["stage"]                 = 2
    state["shares_qty"]            = 400
    state["cost_basis_per_share"]  = 11.00
    state["current_contract"]      = "MARA260515C00012000"
    state["contract_order_id"]     = "y"
    state["contract_entry_price"]  = 0.30
    state["contract_qty"]          = 4
    state["contract_strike"]       = 12.0

    monkeypatch.setattr(ws, "get_option_position", lambda c: None)
    monkeypatch.setattr(ws, "get_stock_position",  lambda s: None)  # all called away
    monkeypatch.setattr(ws, "get_order", lambda o: {"status": "expired"})
    monkeypatch.setattr(ws, "_sell_new_put", lambda *a, **kw: None)

    ws.handle_stage2("MARA", state, stock_price=12.50, account=_account())

    # $0.30 × 100 × 4 = $120 premium kept
    assert state["total_premium_collected"] == 120.0
    assert state["stage"]                  == 1
    assert state["shares_qty"]             == 0
    assert state["cost_basis_per_share"]   is None


# ── Live BP tracking across same-cycle sells ──────────────────────────────

def test_sell_new_put_decrements_account_options_bp(monkeypatch):
    """After a successful put sale, account[options_buying_power] should
    drop by the collateral amount so the next symbol's BP check sees real
    available BP. Without this fix, two same-cycle sells on a constrained
    account would let symbol 2 pass the BP gate on stale data — Alpaca
    would then 403 the actual order. (Regression test for 2026-04-30 16:09
    incident: PLTR/SOFI/PFE all 403'd after earlier symbols consumed BP.)"""
    state = ws._empty_symbol_state()
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract("BAC", strike=50))
    monkeypatch.setattr(ws, "compute_limit_price", lambda *a: 0.10)
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p, qty=1: {"id": "x"})

    account = _account(cash=100000, options_buying_power=10000)

    ws._sell_new_put("BAC", state, stock_price=53.0, account=account)

    # BAC $50 put = $5,000 collateral. After sale, BP should be $10k − $5k = $5k.
    assert float(account["options_buying_power"]) == 5000.0


def test_sell_new_put_two_consecutive_sales_track_bp_correctly(monkeypatch):
    """Simulates two BAC sales back-to-back in the same cycle. First should
    succeed, second should hit insufficient_bp (because the local snapshot
    decrements after the first). Catches the stale-snapshot bug that
    caused the 16:09 PLTR/SOFI/PFE 403 storm."""
    state1 = ws._empty_symbol_state()
    state2 = ws._empty_symbol_state()
    sells = []
    monkeypatch.setattr(ws, "find_best_contract",
                        lambda sym, t, target, *a: _option_contract(sym, strike=50))
    monkeypatch.setattr(ws, "compute_limit_price", lambda *a: 0.10)
    monkeypatch.setattr(ws, "place_sell_to_open",
                        lambda c, p, qty=1: sells.append(c) or {"id": "x"})

    # Just enough BP for ONE $50P sell (collateral $5,000)
    account = _account(cash=100000, options_buying_power=5000)

    ws._sell_new_put("BAC", state1, stock_price=53.0, account=account)
    ws._sell_new_put("XYZ", state2, stock_price=53.0, account=account)

    # First should fill, second should hit insufficient_bp
    assert len(sells) == 1, f"expected 1 sale, got {len(sells)}"
    assert state1["current_contract"] is not None
    assert state2["current_contract"] is None
    assert "Insufficient" in state2["last_action"]
