"""The agent's own record must be true — 2026-10-26 money-loss review (A4, A5, O1, S1-S3).

The agent learns from its trade history, so a wrong P&L or an inverted fill
teaches it the wrong lesson. These tests pin: fills read from the order (not a
blended position average), intended prices re-signed by structure, realized
P&L from Alpaca's fill log (with overlapping orders split, not double-counted),
unfilled add-ons swept even when their legs are held, close-time underlying
moves, and a grader that can't invent post-close prices.
"""
import pytest

import agent_grading
import agent_trader as at

ZS_SHORT, ZS_LONG = "ZS261120P00200000", "ZS261120P00197500"
ZS_LEGS = [{"asset": "option", "symbol": ZS_SHORT, "side": "sell", "qty": 1},
           {"asset": "option", "symbol": ZS_LONG, "side": "buy", "qty": 1}]
DIS_SHORT, DIS_LONG = "DIS260828P00103000", "DIS260828P00100000"
DIS_LEGS = [{"asset": "option", "symbol": DIS_SHORT, "side": "sell", "qty": 1},
            {"asset": "option", "symbol": DIS_LONG, "side": "buy", "qty": 1}]


def _mleg_order(status="filled", short_px="3.38", long_px="3.63", filled_qty="1"):
    return {"id": "o1", "status": status, "filled_qty": filled_qty, "qty": "1",
            "legs": [{"symbol": ZS_SHORT, "side": "sell", "ratio_qty": "1",
                      "filled_avg_price": short_px},
                     {"symbol": ZS_LONG, "side": "buy", "ratio_qty": "1",
                      "filled_avg_price": long_px}]}


# ── Fills ───────────────────────────────────────────────────────────────────

def test_order_fill_net_reads_the_order_not_the_position():
    # ZS: sold the 200P at 3.38, bought the 197.5P at 3.63 → a $0.25 DEBIT.
    assert at._order_fill_net(_mleg_order()) == pytest.approx(-0.25)
    assert at._order_fill_net({"side": "buy", "filled_avg_price": "3.05"}) == pytest.approx(-3.05)
    assert at._order_fill_net({"side": "sell", "filled_avg_price": "0.76"}) == pytest.approx(0.76)
    assert at._order_fill_net(_mleg_order(short_px=None)) is None
    assert at._order_fill_net(None) is None


def test_intended_price_is_re_signed_by_structure():
    # Stored −0.60 came from the mis-signed +0.60 limit; the spread is a credit.
    assert at._corrected_intended(ZS_LEGS, -0.6) == pytest.approx(0.6)
    debit = [dict(ZS_LEGS[0], side="buy"), dict(ZS_LEGS[1], side="sell")]
    assert at._corrected_intended(debit, -0.65) == pytest.approx(-0.65)
    assert at._corrected_intended(ZS_LEGS, None) is None


def test_refresh_fill_repairs_the_zs_record(monkeypatch):
    pos = {"legs": ZS_LEGS, "open_order_id": "o1", "intended_net_credit": -0.6,
           "fill": {"fill_available": True, "intended_net_credit": -0.6,
                    "actual_net_credit": -0.25, "slippage": 0.35}}
    monkeypatch.setattr(at, "_get_order", lambda oid: _mleg_order())
    at._refresh_fill(pos, [], dry_run=False)
    f = pos["fill"]
    assert f["source"] == "order"
    assert f["intended_net_credit"] == pytest.approx(0.6)
    assert f["actual_net_credit"] == pytest.approx(-0.25)
    assert f["slippage"] == pytest.approx(-0.85)   # was +0.35, "better than asked"


def test_refresh_fill_keeps_old_block_when_order_unreadable():
    pos = {"legs": ZS_LEGS, "open_order_id": "o1", "intended_net_credit": -0.6,
           "fill": {"fill_available": True, "slippage": 0.35}}
    at._refresh_fill(pos, [], dry_run=False)          # conftest: GETs return None
    assert pos["fill"]["slippage"] == 0.35


def test_market_order_open_still_gets_its_actual_fill(monkeypatch):
    pos = {"legs": ZS_LEGS, "open_order_id": "o1", "intended_net_credit": None}
    monkeypatch.setattr(at, "_get_order", lambda oid: _mleg_order())
    at._refresh_fill(pos, [], dry_run=False)
    assert pos["fill"]["actual_net_credit"] == pytest.approx(-0.25)
    assert pos["fill"]["slippage"] is None


# ── Realized P&L from the fill log ─────────────────────────────────────────

def _fill(sym, side, qty, px, ts):
    return {"activity_type": "FILL", "symbol": sym, "side": side, "qty": str(qty),
            "price": str(px), "transaction_time": ts}


def _lesson(legs, opened, closed, est):
    return {"opened_at": opened, "closed_at": closed, "legs": legs,
            "outcome": {"estimated_pnl": est}}


def test_overlapping_orders_split_the_realized_pnl_instead_of_double_counting():
    # Two DIS units opened separately, closed together as a 2-lot. Each lesson
    # used to carry the pair's whole −$57.
    lessons = [_lesson(DIS_LEGS, "2026-08-14T14:12:00Z", "2026-08-17T16:12:00Z", -57.0),
               _lesson(DIS_LEGS, "2026-08-14T15:12:00Z", "2026-08-17T16:12:00Z", -57.0)]
    acts = [
        _fill(DIS_SHORT, "sell", 1, 0.56, "2026-08-14T14:12:30Z"),
        _fill(DIS_LONG, "buy", 1, 0.22, "2026-08-14T14:12:30Z"),
        _fill(DIS_SHORT, "sell", 1, 0.56, "2026-08-14T15:12:30Z"),
        _fill(DIS_LONG, "buy", 1, 0.22, "2026-08-14T15:12:30Z"),
        _fill(DIS_SHORT, "buy", 2, 0.80, "2026-08-17T15:13:00Z"),
        _fill(DIS_LONG, "sell", 2, 0.20, "2026-08-17T15:13:00Z"),
    ]
    assert at._apply_realized(lessons, acts, held_symbols=set()) == 2
    # opens +0.34×100×2 = +68; close (−0.80+0.20)×200 = −120 → −52, half each.
    for l in lessons:
        o = l["outcome"]
        assert o["realized_pnl"] == pytest.approx(-26.0)
        assert o["realized_checked"] is True
        assert o["closed_at_actual"] == "2026-08-17T15:13:00Z"
    assert at._scoreboard({"closed": lessons})["cumulative_realized_pnl"] == pytest.approx(-52.0)


def test_same_contract_traded_twice_at_different_times_is_not_merged():
    a = _lesson(ZS_LEGS[:1], "2026-09-01T14:00:00Z", "2026-09-02T14:00:00Z", -10.0)
    b = _lesson(ZS_LEGS[:1], "2026-09-10T14:00:00Z", "2026-09-11T14:00:00Z", -10.0)
    acts = [_fill(ZS_SHORT, "buy", 1, 1.00, "2026-09-01T14:00:30Z"),
            _fill(ZS_SHORT, "sell", 1, 1.50, "2026-09-02T13:00:00Z"),
            _fill(ZS_SHORT, "buy", 1, 2.00, "2026-09-10T14:00:30Z"),
            _fill(ZS_SHORT, "sell", 1, 1.00, "2026-09-11T13:00:00Z")]
    at._apply_realized([a, b], acts, set())
    # Each lesson owns only its own round trip.
    assert a["outcome"]["realized_pnl"] == pytest.approx(50.0)
    assert b["outcome"]["realized_pnl"] == pytest.approx(-100.0)


def test_realized_skipped_while_a_leg_is_still_held_and_never_on_assignment():
    l = _lesson(ZS_LEGS, "2026-10-21T14:12:00Z", "2026-11-23T14:12:00Z", -40.0)
    assert at._apply_realized([l], [], held_symbols={ZS_SHORT}) == 0
    assert "realized_checked" not in l["outcome"]
    acts = [_fill(ZS_SHORT, "sell", 1, 3.38, "2026-10-21T14:12:30Z"),
            _fill(ZS_LONG, "buy", 1, 3.63, "2026-10-21T14:12:30Z"),
            {"activity_type": "OPASN", "symbol": ZS_SHORT, "transaction_time": "2026-11-20T21:00:00Z"}]
    at._apply_realized([l], acts, set())
    assert l["outcome"]["realized_pnl"] is None
    assert "assigned" in l["outcome"]["realized_basis"]
    # Falls back to the estimate everywhere it's shown.
    assert at._outcome_pnl(l["outcome"]) == -40.0


def test_expired_worthless_legs_count_as_zero_cash():
    l = _lesson(ZS_LEGS, "2026-10-21T14:12:00Z", "2026-11-23T14:12:00Z", -40.0)
    acts = [_fill(ZS_SHORT, "sell", 1, 3.38, "2026-10-21T14:12:30Z"),
            _fill(ZS_LONG, "buy", 1, 3.63, "2026-10-21T14:12:30Z"),
            {"activity_type": "OPEXP", "symbol": ZS_SHORT, "transaction_time": "2026-11-21T05:00:00Z"},
            {"activity_type": "OPEXP", "symbol": ZS_LONG, "transaction_time": "2026-11-21T05:00:00Z"}]
    at._apply_realized([l], acts, set())
    assert l["outcome"]["realized_pnl"] == pytest.approx(-25.0)
    assert l["outcome"]["closed_at_actual"] == "2026-11-21T05:00:00Z"


# ── Trade history shown to the model ───────────────────────────────────────

def test_trade_record_uses_realized_pnl_and_the_actual_fill_direction():
    lesson = {"opened_at": "2026-10-21T14:12:00Z", "closed_at": "2026-11-23T14:12:00Z",
              "legs": ZS_LEGS,
              "fill": {"fill_available": True, "actual_net_credit": -0.25},
              "outcome": {"estimated_pnl": -40.0, "realized_pnl": -25.0,
                          "closed_at_actual": "2026-11-21T05:00:00Z"}}
    r = at._trade_record(lesson)
    assert r["structure"] == "put_credit_spread"
    assert r["premium"] == "paid"            # filled as a debit — it paid
    assert r["net_at_fill"] == pytest.approx(-0.25)
    assert r["pnl"] == -25.0 and r["pnl_basis"] == "realized"
    assert r["closed_at"] == "2026-11-21T05:00:00Z"


def test_build_outcome_uses_close_time_prices_from_the_snapshot():
    pos = {"legs": ZS_LEGS, "opened_at": "2026-10-21T14:12:00Z",
           "entry_context": {"underlyings": {"ZS": 229.79}},
           "last_snapshot": {"unrealized_pl": -40.5, "underlyings": {"ZS": 256.63}}}
    out = at.build_outcome(pos, market={})          # closed name not in this cycle's market
    assert out["underlying_moves"]["ZS"]["pct"] == pytest.approx(11.68, abs=0.01)


# ── Order confirmation + sweep (O1, S3, S6) ────────────────────────────────

def _tracked(oid, opened="2026-10-01T14:12:00Z", **extra):
    return {"legs": ZS_LEGS, "open_order_id": oid, "opened_at": opened,
            "thesis": {"thesis": "t"}, "intended_net_credit": 0.6, **extra}


def test_unfilled_add_on_is_swept_even_though_its_legs_are_held(monkeypatch):
    cancels = []
    monkeypatch.setattr(at, "_get_order",
                        lambda oid: {"status": "accepted", "filled_qty": "0", "qty": "1"})
    monkeypatch.setattr(at, "_cancel_order", lambda oid: cancels.append(oid))
    tracked = {"add": _tracked("add")}
    swept = at._confirm_prior_orders(tracked, min_age_minutes=60)
    assert cancels == ["add"] and "add" not in tracked
    assert swept[0]["status"] == "accepted" and "never filled" in swept[0]["note"]


def test_young_unfilled_order_is_left_alone(monkeypatch):
    monkeypatch.setattr(at, "_get_order",
                        lambda oid: {"status": "accepted", "filled_qty": "0", "qty": "1"})
    monkeypatch.setattr(at, "_cancel_order", lambda oid: pytest.fail("cancelled a fresh order"))
    tracked = {"new": _tracked("new", opened=at._now_iso())}
    assert at._confirm_prior_orders(tracked, min_age_minutes=60) == []
    assert "new" in tracked


def test_filled_and_partially_filled_orders_are_kept(monkeypatch):
    orders = {"f": {"status": "filled", "filled_qty": "1", "qty": "1"},
              "p": {"status": "partially_filled", "filled_qty": "1", "qty": "3"}}
    cancels = []
    monkeypatch.setattr(at, "_get_order", lambda oid: orders[oid])
    monkeypatch.setattr(at, "_cancel_order", lambda oid: cancels.append(oid))
    tracked = {"f": _tracked("f"), "p": _tracked("p")}
    assert at._confirm_prior_orders(tracked, min_age_minutes=60) == []
    assert tracked["f"]["order_confirmed"] and tracked["p"]["order_confirmed"]
    assert cancels == ["p"]                      # the resting remainder only
    assert tracked["p"]["partial_fill"]["filled_qty"] == 1.0


def test_self_context_lists_cancelled_orders():
    state = {"positions": {}, "closed": [],
             "_meta": {"last_swept": [{"legs": "x", "note": "never filled"}]}}
    assert at.build_self_context(state)["unfilled_orders_cancelled"][0]["legs"] == "x"


def test_open_orders_summary_distinguishes_unknown_from_none():
    assert at._open_orders_summary(None) is None
    assert at._open_orders_summary([]) == []
    out = at._open_orders_summary([{"id": "o9", "type": "limit", "limit_price": "0.40",
                                    "status": "new", "legs": [
                                        {"side": "buy", "ratio_qty": "1", "symbol": ZS_SHORT},
                                        {"side": "sell", "ratio_qty": "1", "symbol": ZS_LONG}]}])
    assert out[0]["legs"] == f"buy 1 {ZS_SHORT}; sell 1 {ZS_LONG}"


# ── Reconcile end to end ───────────────────────────────────────────────────

def test_reconcile_grades_with_realized_pnl_and_backfills_old_lessons(monkeypatch):
    seen = {}

    def fake_grade(record, outcome, client=None, model=None):
        seen["outcome"] = dict(outcome)
        return {"loss_type": "anticipated", "lesson": "l", "graded": True}

    monkeypatch.setattr(agent_grading, "grade_position", fake_grade)
    monkeypatch.setattr(at, "_announce_lesson", lambda lesson: None)
    monkeypatch.setattr(at, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(at, "_get_order", lambda oid: {"status": "filled", "filled_qty": "1"})
    acts = [_fill(DIS_SHORT, "sell", 1, 0.56, "2026-08-14T14:12:30Z"),
            _fill(DIS_LONG, "buy", 1, 0.22, "2026-08-14T14:12:30Z"),
            _fill(DIS_SHORT, "buy", 1, 0.80, "2026-08-17T15:13:00Z"),
            _fill(DIS_LONG, "sell", 1, 0.20, "2026-08-17T15:13:00Z"),
            _fill(ZS_SHORT, "sell", 1, 3.38, "2026-10-21T14:12:30Z"),
            _fill(ZS_LONG, "buy", 1, 3.63, "2026-10-21T14:12:30Z"),
            _fill(ZS_SHORT, "buy", 1, 0.10, "2026-10-23T15:00:00Z"),
            _fill(ZS_LONG, "sell", 1, 0.05, "2026-10-23T15:00:00Z")]
    monkeypatch.setattr(at, "_fetch_activities", lambda after: acts)
    old = _lesson(DIS_LEGS, "2026-08-14T14:12:00Z", "2026-08-17T16:12:00Z", -57.0)
    state = {"positions": {"z": _tracked("z", opened="2026-10-21T14:12:00Z",
                                         last_snapshot={"unrealized_pl": -40.5,
                                                        "underlyings": {"ZS": 256.6}})},
             "closed": [old], "_meta": {}}
    summary = {"closed": 0}
    at._reconcile_and_grade(state, [], {}, client=None, summary=summary)
    assert not state["positions"]
    assert old["outcome"]["realized_pnl"] == pytest.approx(-26.0)        # backfilled
    new = state["closed"][-1]
    assert new["outcome"]["realized_pnl"] == pytest.approx(-30.0)        # −25 open, −5 close
    assert seen["outcome"]["realized_pnl"] == pytest.approx(-30.0)       # grader saw it
    assert "_position" not in new and summary["graded"] == 1


def test_grader_is_told_not_to_invent_post_close_prices():
    assert "Never claim what the stock or option" in agent_grading.GRADER_SYSTEM
    assert agent_grading._default_grade()["loss_type"] is None


def test_missing_fills_leave_the_lesson_for_a_retry():
    l = _lesson(ZS_LEGS, "2026-10-21T14:12:00Z", "2026-11-23T14:12:00Z", -40.0)
    acts = [_fill(ZS_SHORT, "sell", 1, 3.38, "2026-10-21T14:12:30Z")]   # long leg missing
    assert at._apply_realized([l], acts, set()) == 0
    assert "realized_checked" not in l["outcome"]
