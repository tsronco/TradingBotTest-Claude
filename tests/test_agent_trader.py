"""Tests for the autonomous agent trader harness.

All Alpaca HTTP and the Anthropic client are mocked (per conftest.py convention)
— no test touches a real service. Covers the pure logic (feasibility gate,
intent → order-payload translation, OCC parsing, state round-trip) and a full
mocked run_cycle for the open / close / reject / refusal paths.
"""
import json

import pytest

import agent_trader as at


# ── Feasibility gate ────────────────────────────────────────────────────────

def _open_intent(**over):
    base = {
        "action": "open",
        "rationale": "test",
        "order_type": "limit",
        "limit_price": 1.25,
        "legs": [{"asset": "option", "symbol": "AAPL260320P00150000",
                  "side": "buy", "qty": 1}],
        "thesis": {
            "thesis": "t", "why_this_structure": "w", "getting_paid": "g",
            "key_risk": "k", "invalidation": "i", "confidence": 3, "rejected": "r",
        },
    }
    base.update(over)
    return base


def test_feasibility_accepts_valid_open():
    ok, reason = at.check_feasibility(_open_intent(), {"equity": 2000})
    assert ok, reason


def test_feasibility_rejects_missing_thesis_on_open():
    ok, reason = at.check_feasibility(_open_intent(thesis=None), {"equity": 2000})
    assert not ok and "thesis" in reason


def test_feasibility_blocks_opens_below_equity_floor():
    # $400 equity is below the $500 floor → opens blocked.
    ok, reason = at.check_feasibility(_open_intent(), {"equity": 400})
    assert not ok and "floor" in reason


def test_feasibility_allows_close_below_equity_floor():
    """The circuit breaker blocks opens, never closes."""
    close = _open_intent(action="close", thesis=None)
    ok, reason = at.check_feasibility(close, {"equity": 400})
    assert ok, reason


def test_feasibility_rejects_bad_leg_fields():
    for bad in (
        {"asset": "crypto", "symbol": "X", "side": "buy", "qty": 1},
        {"asset": "stock", "symbol": "X", "side": "hold", "qty": 1},
        {"asset": "stock", "symbol": "X", "side": "buy", "qty": 0},
        {"asset": "stock", "symbol": "", "side": "buy", "qty": 1},
    ):
        ok, _ = at.check_feasibility(_open_intent(legs=[bad]), {"equity": 2000})
        assert not ok


def test_feasibility_rejects_limit_without_price():
    ok, reason = at.check_feasibility(
        _open_intent(order_type="limit", limit_price=None), {"equity": 2000})
    assert not ok and "limit_price" in reason


def test_feasibility_rejects_no_legs():
    ok, reason = at.check_feasibility(_open_intent(legs=[]), {"equity": 2000})
    assert not ok


# ── Per-trade size cap (max_risk_pct_equity) ────────────────────────────────

_CAP = {"equity_floor": 500, "max_risk_pct_equity": 0.30}


def _long_call(limit, qty=1):
    return _open_intent(
        limit_price=limit,
        legs=[{"asset": "option", "symbol": "TSLA260320C00352500",
               "side": "buy", "qty": qty}])


def _debit_spread(limit, qty=1):
    # net debit paid = limit_price (positive)
    return _open_intent(
        limit_price=limit,
        legs=[{"asset": "option", "symbol": "TSLA260320C00352500",
               "side": "buy", "qty": qty},
              {"asset": "option", "symbol": "TSLA260320C00365000",
               "side": "sell", "qty": qty}])


def _credit_spread(limit, qty=1):
    # net credit received = -limit_price; width = |365 - 352.5| = 12.5
    return _open_intent(
        limit_price=limit,
        legs=[{"asset": "option", "symbol": "TSLA260320P00365000",
               "side": "sell", "qty": qty},
              {"asset": "option", "symbol": "TSLA260320P00352500",
               "side": "buy", "qty": qty}])


def test_intent_max_loss_long_option_is_premium_paid():
    # $3.00 premium × 100 × 2 contracts = $600
    assert at._intent_max_loss(_long_call(3.00, qty=2)) == pytest.approx(600.0)


def test_intent_max_loss_debit_spread_is_net_debit():
    # $2.00 net debit × 100 = $200
    assert at._intent_max_loss(_debit_spread(2.00)) == pytest.approx(200.0)


def test_intent_max_loss_credit_spread_is_width_minus_credit():
    # width 12.5 − credit 0.30 = 12.20 × 100 = $1220
    assert at._intent_max_loss(_credit_spread(-0.30)) == pytest.approx(1220.0)


def test_intent_max_loss_unknowable_cases_and_naked_shorts():
    # Stock market order with no quote to price it → can't bound.
    stock = _open_intent(order_type="market", limit_price=None,
                         legs=[{"asset": "stock", "symbol": "TSLA",
                                "side": "buy", "qty": 10}])
    assert at._intent_max_loss(stock) is None
    # ...but with a live quote it is the full share cost.
    mkt_data = {"TSLA": {"quote": {"ap": 350.0}}}
    assert at._intent_max_loss(stock, mkt_data) == pytest.approx(3500.0)
    # market option order → premium unknown (and rejected as an open anyway)
    mkt = _long_call(3.00)
    mkt["order_type"] = "market"
    mkt["limit_price"] = None
    assert at._intent_max_loss(mkt) is None
    # A lone short put is bounded at strike − credit: 150 − 1.25 → $14,875.
    naked_put = _open_intent(legs=[{"asset": "option", "symbol": "AAPL260320P00150000",
                                    "side": "sell", "qty": 1}])
    assert at._intent_max_loss(naked_put) == pytest.approx(14875.0)
    # A lone short call is unbounded.
    naked_call = _open_intent(legs=[{"asset": "option", "symbol": "AAPL260320C00150000",
                                     "side": "sell", "qty": 1}])
    assert at._intent_max_loss(naked_call) == float("inf")


def test_feasibility_rejects_oversized_open():
    # $600 max loss on a $1130 account (56%) > 30% cap → rejected.
    ok, reason = at.check_feasibility(
        _debit_spread(6.00), {"equity": 1130}, _CAP)
    assert not ok
    assert "max loss" in reason and "30%" in reason


def test_feasibility_allows_within_cap_open():
    # $150 max loss on $1130 (13%) < 30% → allowed.
    ok, reason = at.check_feasibility(
        _debit_spread(1.50), {"equity": 1130}, _CAP)
    assert ok, reason


def test_feasibility_size_cap_scales_with_equity():
    # Same $150 spread: fine at $1130, but on a $400... floor blocks first.
    # On $600 (above floor), $150 is 25% → allowed; $200 is 33% → rejected.
    ok, _ = at.check_feasibility(_debit_spread(1.50), {"equity": 600}, _CAP)
    assert ok
    ok, reason = at.check_feasibility(_debit_spread(2.00), {"equity": 600}, _CAP)
    assert not ok and "max loss" in reason


def test_feasibility_size_cap_applies_to_stock_notional_when_priced():
    # Without a quote the stock order can't be priced, so only Alpaca's buying
    # power gates it; with one, 100 TSLA ≈ $35k on a $600 account is rejected.
    stock = _open_intent(order_type="market", limit_price=None,
                         legs=[{"asset": "stock", "symbol": "TSLA",
                                "side": "buy", "qty": 100}])
    ok, reason = at.check_feasibility(stock, {"equity": 600}, _CAP)
    assert ok, reason
    ok, reason = at.check_feasibility(stock, {"equity": 600}, _CAP,
                                      market={"TSLA": {"quote": {"ap": 350.0}}})
    assert not ok and "max loss" in reason
    one = _open_intent(order_type="market", limit_price=None,
                       legs=[{"asset": "stock", "symbol": "F", "side": "buy", "qty": 10}])
    ok, reason = at.check_feasibility(one, {"equity": 600}, _CAP,
                                      market={"F": {"quote": {"ap": 11.0}}})
    assert ok, reason


def test_feasibility_size_cap_disabled_when_pct_zero():
    off = {"equity_floor": 500, "max_risk_pct_equity": 0}
    ok, reason = at.check_feasibility(_debit_spread(6.00), {"equity": 1130}, off)
    assert ok, reason


def test_mandate_states_the_size_cap():
    # The agent must be told the 30% cap upfront so it sizes correctly, not just
    # get rejected after the fact.
    assert "30%" in at.SYSTEM_MANDATE
    assert "max loss at expiry" in at.SYSTEM_MANDATE


# ── Order-payload translation ───────────────────────────────────────────────

def test_single_stock_order_payload():
    intent = {
        "action": "open", "order_type": "market", "limit_price": None,
        "legs": [{"asset": "stock", "symbol": "AAPL", "side": "buy", "qty": 5}],
    }
    p = at.build_order_payload(intent)
    assert p["symbol"] == "AAPL" and p["qty"] == "5" and p["side"] == "buy"
    assert p["type"] == "market" and "limit_price" not in p


def test_single_option_limit_order_payload():
    intent = {
        "action": "open", "order_type": "limit", "limit_price": 2.5,
        "legs": [{"asset": "option", "symbol": "AAPL260320C00150000",
                  "side": "buy", "qty": 1}],
    }
    p = at.build_order_payload(intent)
    assert p["symbol"] == "AAPL260320C00150000"
    assert p["limit_price"] == "2.50"


def test_multileg_spread_payload_uses_mleg_and_position_intents():
    intent = {
        "action": "open", "order_type": "limit", "limit_price": -0.40,
        "legs": [
            {"asset": "option", "symbol": "AAL260320P00012500", "side": "sell", "qty": 1},
            {"asset": "option", "symbol": "AAL260320P00011500", "side": "buy", "qty": 1},
        ],
    }
    p = at.build_order_payload(intent)
    assert p["order_class"] == "mleg"
    assert p["limit_price"] == "-0.40"
    intents = {leg["symbol"]: leg["position_intent"] for leg in p["legs"]}
    assert intents["AAL260320P00012500"] == "sell_to_open"
    assert intents["AAL260320P00011500"] == "buy_to_open"


def test_multileg_close_uses_close_intents():
    intent = {
        "action": "close", "order_type": "market", "limit_price": None,
        "legs": [
            {"asset": "option", "symbol": "AAL260320P00012500", "side": "buy", "qty": 1},
            {"asset": "option", "symbol": "AAL260320P00011500", "side": "sell", "qty": 1},
        ],
    }
    p = at.build_order_payload(intent)
    intents = {leg["symbol"]: leg["position_intent"] for leg in p["legs"]}
    assert intents["AAL260320P00012500"] == "buy_to_close"
    assert intents["AAL260320P00011500"] == "sell_to_close"


# ── OCC parsing ─────────────────────────────────────────────────────────────

def test_occ_underlying_parsing():
    assert at._occ_underlying("AAPL260320C00150000") == "AAPL"
    assert at._occ_underlying("AAL260320P00012500") == "AAL"
    assert at._occ_underlying("SPY") == "SPY"  # plain stock unchanged


# ── State round-trip ────────────────────────────────────────────────────────

def test_state_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(at, "_state_path", lambda: str(tmp_path / "agent_state.json"))
    s = at.load_state()
    assert s["positions"] == {} and s["closed"] == []
    s["positions"]["O-1"] = {"thesis": {"confidence": 4}}
    at.save_state(s)
    reloaded = at.load_state()
    assert reloaded["positions"]["O-1"]["thesis"]["confidence"] == 4


def test_load_state_refuses_a_corrupt_file_instead_of_wiping_history(tmp_path, monkeypatch):
    # Returning an empty state here used to mean the next save overwrote every
    # closed trade and tracked position. Now the cycle stops and reports it.
    p = tmp_path / "agent_state.json"
    p.write_text("{ not valid json")
    monkeypatch.setattr(at, "_state_path", lambda: str(p))
    with pytest.raises(json.JSONDecodeError):
        at.load_state()


def test_run_cycle_with_corrupt_state_errors_and_leaves_the_file_alone(_wire, tmp_path):
    p = tmp_path / "agent_state.json"
    p.write_text("{ not valid json")
    out = at.run_cycle(client=_FakeClient([]))
    assert out["errors"] == 1
    assert p.read_text() == "{ not valid json"


def test_save_state_is_atomic(tmp_path, monkeypatch):
    p = tmp_path / "agent_state.json"
    monkeypatch.setattr(at, "_state_path", lambda: str(p))
    at.save_state({"positions": {}, "closed": [], "_meta": {}})
    assert json.loads(p.read_text())["positions"] == {}
    assert not (tmp_path / "agent_state.json.tmp").exists()


# ── request_decisions with a mocked Anthropic client ────────────────────────

class _FakeBlock:
    def __init__(self, intents, market_read="read"):
        self.type = "tool_use"
        self.name = "submit_decisions"
        self.input = {"intents": intents, "market_read": market_read}


class _FakeResp:
    def __init__(self, intents, stop_reason="tool_use", market_read="read"):
        self.content = [_FakeBlock(intents, market_read)]
        self.stop_reason = stop_reason


class _FakeClient:
    def __init__(self, intents, stop_reason="tool_use", market_read="read"):
        self._intents = intents
        self._stop = stop_reason
        self._read = market_read
        self.messages = self

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeResp(self._intents, self._stop, self._read)


def test_request_decisions_parses_tool_output():
    client = _FakeClient([_open_intent()], market_read="quiet tape, watching")
    out = at.request_decisions({"account": {}}, client=client)
    assert out["refused"] is False
    assert len(out["intents"]) == 1
    assert out["market_read"] == "quiet tape, watching"
    # Forced tool choice + adaptive thinking wired correctly.
    assert client.last_kwargs["tool_choice"]["name"] == "submit_decisions"
    assert client.last_kwargs["thinking"]["type"] == "adaptive"


def test_request_decisions_handles_refusal():
    client = _FakeClient([], stop_reason="refusal")
    out = at.request_decisions({"account": {}}, client=client)
    assert out["refused"] is True and out["intents"] == []


# ── Full run_cycle (mocked context + client + order placement) ──────────────

class _OrderResp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body or {"id": "ORD-1"}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


@pytest.fixture
def _wire(monkeypatch, tmp_path):
    """Stub context, focus, state path, discord, and order placement for run_cycle."""
    monkeypatch.setattr(at, "_state_path", lambda: str(tmp_path / "agent_state.json"))
    monkeypatch.setattr(at, "gather_breadth", lambda mode="agent": {
        "account": {"equity": 2000.0, "cash": 2000.0},
        "positions": [], "universe": {}, "equity_floor": 500,
    })
    # Focus step is stubbed so decision-path tests stay isolated from phase 1.
    monkeypatch.setattr(at, "request_focus", lambda breadth, client=None, model=None: {
        "focus": [], "market_read": "", "refused": False,
    })
    monkeypatch.setattr(at, "gather_depth",
                        lambda focus, positions, account, mode="agent", **kw: {
                            "account": {"equity": 2000.0, "cash": 2000.0},
                            "positions": [], "market": {}, "equity_floor": 500,
                        })
    monkeypatch.setattr(at, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(at, "log_event", lambda *a, **k: None)
    # Market open by default so the closed-guard doesn't short-circuit (and so
    # tests never hit the real /clock endpoint). Closed-path tests override this.
    monkeypatch.setattr(at.alpaca_data, "is_market_open", lambda mode="agent": True)
    placed = []
    monkeypatch.setattr(at, "place_order",
                        lambda payload: placed.append(payload) or _OrderResp())
    return placed


def test_run_cycle_opens_and_records_thesis(_wire, monkeypatch):
    client = _FakeClient([_open_intent()])
    summary = at.run_cycle(client=client)
    assert summary["opened"] == 1 and summary["errors"] == 0
    state = at.load_state()
    assert "ORD-1" in state["positions"]
    assert state["positions"]["ORD-1"]["thesis"]["confidence"] == 3
    assert len(_wire) == 1  # one order placed


def test_run_cycle_rejects_infeasible_without_placing(_wire):
    client = _FakeClient([_open_intent(thesis=None)])  # open w/o thesis → rejected
    summary = at.run_cycle(client=client)
    assert summary["rejected"] == 1 and summary["opened"] == 0
    assert len(_wire) == 0  # nothing placed


def test_run_cycle_refusal_is_no_trade(_wire):
    client = _FakeClient([], stop_reason="refusal")
    summary = at.run_cycle(client=client)
    assert summary["refused"] is True
    assert summary["opened"] == 0 and len(_wire) == 0


def test_run_cycle_empty_intents_holds(_wire):
    client = _FakeClient([])
    summary = at.run_cycle(client=client)
    assert summary == {"opened": 0, "closed": 0, "rejected": 0, "graded": 0,
                       "refused": False, "errors": 0}


def test_run_cycle_hold_surfaces_market_read(_wire, monkeypatch):
    """A hold cycle must post the model's market read (why it passed), not be silent."""
    held = {}
    monkeypatch.setattr(at, "_announce_hold",
                        lambda read, **k: held.setdefault("read", read))
    client = _FakeClient([], market_read="quiet tape; would act on a pullback in AAPL")
    at.run_cycle(client=client)
    assert held["read"] == "quiet tape; would act on a pullback in AAPL"


def test_run_cycle_trade_does_not_announce_hold(_wire, monkeypatch):
    """When it trades, no hold note fires."""
    called = {"hold": False}
    monkeypatch.setattr(at, "_announce_hold",
                        lambda read, **k: called.__setitem__("hold", True))
    client = _FakeClient([_open_intent()])
    at.run_cycle(client=client)
    assert called["hold"] is False


def test_run_cycle_dry_run_places_nothing(_wire):
    client = _FakeClient([_open_intent()])
    summary = at.run_cycle(client=client, dry_run=True)
    assert summary["opened"] == 0 and len(_wire) == 0


def test_run_cycle_skips_when_market_closed(_wire, monkeypatch):
    """On a holiday/after-close, skip with a heartbeat — NO model call, NO order,
    NO Discord (the confusing 'holding on a closed day' message)."""
    monkeypatch.setattr(at.alpaca_data, "is_market_open", lambda mode="agent": False)
    # A client that WOULD open if consulted — proves the decision call is skipped.
    client = _FakeClient([_open_intent()])
    holds = {}
    monkeypatch.setattr(at, "_announce_hold", lambda *a, **k: holds.setdefault("h", True))
    summary = at.run_cycle(client=client)
    assert summary.get("skipped") == "market_closed"
    assert summary["opened"] == 0 and len(_wire) == 0
    assert not hasattr(client, "last_kwargs")  # the paid model call never happened
    assert "h" not in holds                    # no hold message posted


def test_run_cycle_dry_run_ignores_market_closed(_wire, monkeypatch):
    """dry_run bypasses the market-closed guard so tests/backfills still run."""
    monkeypatch.setattr(at.alpaca_data, "is_market_open", lambda mode="agent": False)
    client = _FakeClient([])
    summary = at.run_cycle(client=client, dry_run=True)
    assert "skipped" not in summary


def test_run_cycle_order_rejection_counts_error(_wire, monkeypatch):
    monkeypatch.setattr(at, "place_order",
                        lambda payload: _OrderResp(status=422, body={"message": "no"}))
    client = _FakeClient([_open_intent()])
    summary = at.run_cycle(client=client)
    assert summary["errors"] == 1 and summary["opened"] == 0


# ── Two-phase scan: breadth quotes, focus selection, depth ──────────────────

class _FocusBlock:
    def __init__(self, focus, market_read="read"):
        self.type = "tool_use"
        self.name = "select_focus"
        self.input = {"focus": focus, "market_read": market_read}


class _FocusResp:
    def __init__(self, focus, stop_reason="tool_use", market_read="read"):
        self.content = [_FocusBlock(focus, market_read)]
        self.stop_reason = stop_reason


class _FocusClient:
    def __init__(self, focus, stop_reason="tool_use", market_read="read"):
        self._focus = focus
        self._stop = stop_reason
        self._read = market_read
        self.messages = self

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FocusResp(self._focus, self._stop, self._read)


def test_request_focus_parses_and_uppercases():
    client = _FocusClient(["aapl", "msft", " ", "nvda"], market_read="tech firm")
    out = at.request_focus({"universe": {}}, client=client)
    assert out["refused"] is False
    assert out["focus"] == ["AAPL", "MSFT", "NVDA"]  # blanks dropped, upper-cased
    assert out["market_read"] == "tech firm"
    assert client.last_kwargs["tool_choice"]["name"] == "select_focus"


def test_request_focus_caps_at_max(monkeypatch):
    monkeypatch.setitem(at._CFG, "max_focus_symbols", 3)
    client = _FocusClient(["A", "B", "C", "D", "E"])
    out = at.request_focus({"universe": {}}, client=client)
    assert out["focus"] == ["A", "B", "C"]


def test_request_focus_handles_refusal():
    client = _FocusClient([], stop_reason="refusal")
    out = at.request_focus({"universe": {}}, client=client)
    assert out["refused"] is True and out["focus"] == []


def test_fallback_focus_ranks_by_absolute_move():
    breadth = {"universe": {
        "AAA": {"change_pct": 0.5},
        "BBB": {"change_pct": -8.0},
        "CCC": {"change_pct": 3.0},
        "DDD": {"change_pct": None},
    }}
    assert at._fallback_focus(breadth, cap=2) == ["BBB", "CCC"]


def test_build_quote_pack_computes_change(monkeypatch):
    monkeypatch.setattr(at.alpaca_data, "get_stock_snapshots",
                        lambda syms, mode="agent", chunk_size=100: {
                            "AAPL": {"latestTrade": {"p": 110.0},
                                     "dailyBar": {"c": 109, "h": 111, "l": 108, "v": 1000},
                                     "prevDailyBar": {"c": 100.0}},
                        })
    pack = at.build_quote_pack(["AAPL"], mode="agent")
    assert pack["AAPL"]["price"] == 110.0
    assert pack["AAPL"]["change_pct"] == 10.0  # (110-100)/100
    assert pack["AAPL"]["day_high"] == 111


def test_build_quote_pack_is_fail_soft(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("data down")
    monkeypatch.setattr(at.alpaca_data, "get_stock_snapshots", _boom)
    assert at.build_quote_pack(["AAPL"]) == {}


def test_gather_depth_always_includes_held(monkeypatch):
    seen = {}
    monkeypatch.setattr(at, "build_market_pack",
                        lambda syms, mode="agent", **kw: (seen.setdefault("syms", syms), seen.update(kw)) and {})
    positions = [{"symbol": "TSLA260320C00300000"}]  # a held option
    at.gather_depth(["AAPL"], positions, {"equity": 2000}, mode="agent")
    # Focus name and the held leg's UNDERLYING are fetched as chains; the leg
    # itself is not a chain symbol (that produced empty "ladder, 0 rows"
    # entries) — it is guaranteed as a row via held_occs instead.
    assert "AAPL" in seen["syms"]
    assert "TSLA" in seen["syms"]
    assert "TSLA260320C00300000" not in seen["syms"]
    assert seen["held_occs"] == ["TSLA260320C00300000"]


def test_run_cycle_falls_back_to_top_movers_on_empty_focus(monkeypatch, tmp_path):
    """If the focus step returns nothing, depth still runs on the top movers."""
    monkeypatch.setattr(at, "_state_path", lambda: str(tmp_path / "agent_state.json"))
    monkeypatch.setattr(at, "gather_breadth", lambda mode="agent": {
        "account": {"equity": 2000.0}, "positions": [],
        "universe": {"AAA": {"change_pct": 1.0}, "BBB": {"change_pct": -9.0}},
        "equity_floor": 500,
    })
    monkeypatch.setattr(at, "request_focus", lambda breadth, client=None, model=None: {
        "focus": [], "market_read": "", "refused": False})
    got = {}
    monkeypatch.setattr(at, "gather_depth",
                        lambda focus, positions, account, mode="agent", **kw:
                        got.setdefault("focus", focus) or {
                            "account": account, "positions": [], "market": {},
                            "equity_floor": 500})
    monkeypatch.setattr(at, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(at, "log_event", lambda *a, **k: None)
    at.run_cycle(client=_FakeClient([]))
    assert got["focus"] == ["BBB", "AAA"]  # deterministic top-mover fallback


# ── Continuity feed (self_context): the model's own recent reasoning ────────

def test_build_self_context_returns_open_theses_and_prev_note():
    state = {
        "_meta": {"last_market_read": "quiet tape, holding DIS"},
        "positions": {
            "O-1": {"opened_at": "2026-08-14T13:00:00Z",
                    "legs": [{"symbol": "DIS260828P00103000", "side": "sell", "qty": 1}],
                    "thesis": {"thesis": "DIS range-bound", "invalidation": "DIS<103",
                               "key_risk": "gap down", "confidence": 3}},
        },
    }
    state["_meta"]["last_cycle_outcome"] = {
        "opened": [], "closed": [],
        "rejected": [{"legs": "sell 1 NVDA...C", "source": "alpaca",
                      "reason": "Alpaca 403: naked short not permitted"}],
    }
    sc = at.build_self_context(state)
    assert sc["previous_cycle_note"] == "quiet tape, holding DIS"
    assert len(sc["open_position_theses"]) == 1
    row = sc["open_position_theses"][0]
    assert row["thesis"] == "DIS range-bound" and row["invalidation"] == "DIS<103"
    assert row["confidence"] == 3
    # The factual outcome (incl. the rejection + reason) is fed forward too.
    assert sc["previous_cycle_outcome"]["rejected"][0]["source"] == "alpaca"
    assert "naked short" in sc["previous_cycle_outcome"]["rejected"][0]["reason"]


def test_self_context_feeds_raw_trade_history_and_scoreboard():
    """The self-learning loop: EVERY closed trade as raw facts (structure, premium
    paid/collected, real P&L) + a running scoreboard — no letter grades, so the
    model sees what actually made/lost money and concludes for itself."""
    state = {
        "_meta": {"seed_capital": 2000},
        "positions": {},
        "closed": [
            {"opened_at": "2026-08-24T14:13:00Z", "closed_at": "2026-09-01T15:12:00Z",
             "legs": [{"symbol": "DIS260918C00111000", "side": "buy", "qty": 1}],
             "outcome": {"estimated_pnl": -240.5, "days_held": 8.2,
                         "underlying_moves": {"DIS": {"entry": 111.4, "now": 110.6, "pct": -0.72}}},
             "grade": {"process_grade": "A", "outcome_grade": "C",
                       "lesson": "cutting at the invalidation was correct discipline"}},
            {"legs": [{"symbol": "SLB260918C00059000", "side": "buy", "qty": 1},
                      {"symbol": "SLB260918C00060000", "side": "sell", "qty": 1}],
             "outcome": {"estimated_pnl": -33.0, "days_held": 4.0}},
        ],
    }
    sc = at.build_self_context(state)
    hist = sc["trade_history"]
    assert len(hist) == 2
    # Raw facts, not grades: structure + premium direction + real P&L.
    assert hist[0]["structure"] == "long_call" and hist[0]["premium"] == "paid"
    assert hist[0]["pnl"] == -240.5 and hist[0]["dte_at_entry"] == 25
    assert hist[1]["structure"] == "call_debit_spread" and hist[1]["premium"] == "paid"
    # No sanitizing letter grades leaked into the feed.
    assert "process_grade" not in hist[0] and "outcome_grade" not in hist[0]
    # Scoreboard shows the aggregate the model must reckon with — but NOT a
    # pre-computed by-structure verdict (it must reach that itself).
    sb = sc["scoreboard"]
    assert sb["total_closed_trades"] == 2 and sb["wins"] == 0 and sb["losses"] == 2
    assert sb["win_rate_pct"] == 0.0 and sb["cumulative_realized_pnl"] == -273.5


def test_trade_history_feeds_the_full_record_up_to_cap(monkeypatch):
    monkeypatch.setitem(at._CFG, "max_history_in_context", 3)
    state = {"_meta": {}, "positions": {}, "closed": [
        {"legs": [{"symbol": f"AAA{i}", "side": "buy", "qty": 1}],
         "outcome": {"estimated_pnl": float(i)}} for i in range(6)
    ]}
    sc = at.build_self_context(state)
    assert len(sc["trade_history"]) == 3          # most recent 3
    assert sc["trade_history"][-1]["pnl"] == 5.0
    assert sc["scoreboard"]["total_closed_trades"] == 6   # scoreboard counts ALL


def test_classify_structure_from_legs():
    assert at._classify_structure(
        [{"symbol": "DIS260918C00111000", "side": "buy", "qty": 1}]) == ("long_call", "paid")
    assert at._classify_structure(
        [{"symbol": "AAPL260320P00150000", "side": "buy", "qty": 1}]) == ("long_put", "paid")
    # Put credit spread (bull put): sell higher strike, buy lower.
    assert at._classify_structure([
        {"symbol": "DIS260828P00103000", "side": "sell", "qty": 1},
        {"symbol": "DIS260828P00100000", "side": "buy", "qty": 1}]) == ("put_credit_spread", "collected")
    # Call debit spread (bull call): buy lower, sell higher.
    assert at._classify_structure([
        {"symbol": "CVS260925C00096000", "side": "buy", "qty": 3},
        {"symbol": "CVS260925C00103000", "side": "sell", "qty": 3}]) == ("call_debit_spread", "paid")
    assert at._classify_structure([{"symbol": "AAPL", "side": "buy", "qty": 10}]) == ("long_stock", "none")


def test_mandate_tells_model_to_study_its_record_and_stay_free():
    m = at.SYSTEM_MANDATE.lower()
    assert "trade_history" in m and "scoreboard" in m
    assert "draw your own conclusions" in m or "find it yourself" in m
    assert "nothing is banned" in m                  # keeps every structure available
    assert "invalidation" in m and "noise, not thesis failure" in m  # exit principle kept


def test_build_self_context_excludes_closed_positions():
    """A closed trade lives in state['closed'], NOT state['positions'] — so its
    thesis must never leak into the continuity feed (no phantom holdings)."""
    state = {
        "_meta": {},
        "positions": {},  # nothing currently held
        "closed": [{"legs": [{"symbol": "DIS260828P00103000"}],
                    "thesis": {"thesis": "old closed DIS trade", "confidence": 4}}],
    }
    sc = at.build_self_context(state)
    assert sc["open_position_theses"] == []
    assert sc["previous_cycle_note"] is None
    # The closed trade's text appears nowhere in the feed.
    assert "old closed DIS trade" not in json.dumps(sc)


def test_run_cycle_feeds_self_context_and_persists_note(_wire, monkeypatch):
    """run_cycle must attach self_context to the decision prompt and persist the
    model's market_read as next cycle's previous_cycle_note."""
    captured = {}

    def _capture(context, client=None, model=None):
        captured["ctx"] = context
        return {"intents": [], "market_read": "holding; watching AAPL", "refused": False}

    monkeypatch.setattr(at, "request_decisions", _capture)
    at.run_cycle(client=_FakeClient([]))
    assert "self_context" in captured["ctx"]
    assert "open_position_theses" in captured["ctx"]["self_context"]
    # The read is persisted for next cycle.
    assert at.load_state()["_meta"]["last_market_read"] == "holding; watching AAPL"


def test_mandate_teaches_how_alpaca_marks_spreads():
    """The mandate must warn that Alpaca marks shorts/spreads at the worst-case
    bid/ask corner, so the model judges P&L from the mid — guards against a
    stale-mark panic close on a wide chain."""
    m = at.SYSTEM_MANDATE.lower()
    assert "unrealized_pl" in m or "mark" in m
    assert "mid" in m and ("worst-case" in m or "worst case" in m)
    assert "width" in m  # defined-risk spread can't lose more than its width
    assert "fair_value" in m  # points the model at the computed annotation


# ── Fair-value annotation: mid-based P&L next to Alpaca's worst-case mark ────

def _opt_pos(symbol, qty, avg_entry, unrealized_pl, asset_class="us_option"):
    return {"symbol": symbol, "qty": str(qty), "avg_entry_price": str(avg_entry),
            "unrealized_pl": str(unrealized_pl), "asset_class": asset_class}


def test_fair_value_short_leg_uses_mid_not_worst_case(monkeypatch):
    """The DIS short 103 put: marked at the 0.63 ask (−$28), but the 0.14×0.63
    mid (0.385) is a small GAIN vs the 0.49 entry."""
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": {"bid": 0.14, "ask": 0.63})
    pos = _opt_pos("DIS260828P00103000", -2, 0.49, -28.0)
    at.annotate_positions_fair_value([pos], mode="agent")
    fv = pos["fair_value"]
    assert fv["leg_mid"] == 0.385
    assert fv["unrealized_pl_mid"] == 21.0     # (0.385-0.49)*-2*100
    assert fv["unrealized_pl_mark"] == -28.0   # Alpaca's worst-case, kept for contrast


def test_fair_value_long_leg_sign(monkeypatch):
    """The DIS long 100 put: marked at the 0.05 bid, mid 0.125 vs 0.195 entry."""
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": {"bid": 0.05, "ask": 0.20})
    pos = _opt_pos("DIS260828P00100000", 2, 0.195, -29.0)
    at.annotate_positions_fair_value([pos], mode="agent")
    assert pos["fair_value"]["unrealized_pl_mid"] == -14.0  # (0.125-0.195)*2*100


def test_fair_value_spread_legs_sum_to_fair_pnl(monkeypatch):
    """Summing the legs' mid P&L gives the spread's true ~breakeven, not −$57."""
    quotes = {"DIS260828P00103000": {"bid": 0.14, "ask": 0.63},
              "DIS260828P00100000": {"bid": 0.05, "ask": 0.20}}
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": quotes[occ])
    positions = [_opt_pos("DIS260828P00103000", -2, 0.49, -28.0),
                 _opt_pos("DIS260828P00100000", 2, 0.195, -29.0)]
    at.annotate_positions_fair_value(positions, mode="agent")
    fair = sum(p["fair_value"]["unrealized_pl_mid"] for p in positions)
    mark = sum(p["fair_value"]["unrealized_pl_mark"] for p in positions)
    assert fair == 7.0 and mark == -57.0  # +$7 fair vs −$57 worst-case mark


def test_fair_value_skips_stocks(monkeypatch):
    called = {"n": 0}
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": called.__setitem__("n", called["n"] + 1))
    pos = {"symbol": "AAPL", "qty": "10", "avg_entry_price": "150",
           "unrealized_pl": "20", "asset_class": "us_equity"}
    at.annotate_positions_fair_value([pos], mode="agent")
    assert "fair_value" not in pos and called["n"] == 0  # no quote fetched for a stock


def test_fair_value_flags_missing_quote_as_unreliable(monkeypatch):
    """A missing quote must be FLAGGED, not silently dropped — the model has to
    know the leftover unrealized_pl is the unreliable worst-case mark."""
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": None)
    pos = _opt_pos("DIS260828P00103000", -2, 0.49, -28.0)
    at.annotate_positions_fair_value([pos], mode="agent")
    fv = pos["fair_value"]
    assert fv["fair_value_available"] is False
    assert "unrealized_pl_mid" not in fv            # no fair number could be computed
    assert fv["unrealized_pl_mark"] == -28.0        # the raw mark is still shown...
    assert "unreliable" in fv["note"].lower()        # ...but explicitly flagged


def test_fair_value_flags_degenerate_quote(monkeypatch):
    """A zero/empty bid+ask is not a usable mid — flag it too, don't compute."""
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": {"bid": 0.0, "ask": 0.0})
    pos = _opt_pos("DIS260828P00103000", -2, 0.49, -28.0)
    at.annotate_positions_fair_value([pos], mode="agent")
    assert pos["fair_value"]["fair_value_available"] is False


def test_fair_value_marks_available_true_on_good_quote(monkeypatch):
    monkeypatch.setattr(at.alpaca_data, "get_option_quote",
                        lambda occ, mode="agent": {"bid": 0.14, "ask": 0.63})
    pos = _opt_pos("DIS260828P00103000", -2, 0.49, -28.0)
    at.annotate_positions_fair_value([pos], mode="agent")
    assert pos["fair_value"]["fair_value_available"] is True


def test_mandate_explains_fair_value_unavailable_flag():
    m = at.SYSTEM_MANDATE.lower()
    assert "fair_value_available" in m and "false" in m


# ── Rejection feedback + error ping + options-level constraint ──────────────

def test_mandate_states_options_level_and_no_naked_shorts():
    """The model must be told its permission level so it never wastes a cycle
    attempting a structure Alpaca will always reject."""
    m = at.SYSTEM_MANDATE.lower()
    assert "level 3" in m
    assert "naked" in m and ("spread" in m or "hedge" in m)


def test_mandate_explains_previous_cycle_outcome():
    m = at.SYSTEM_MANDATE.lower()
    assert "previous_cycle_outcome" in m and "reject" in m


def test_mandate_says_long_option_is_already_defined_risk():
    """Guards against the CVS mistake — bolting a throwaway short leg onto a long
    call to 'make it defined-risk' when a long option already is."""
    m = at.SYSTEM_MANDATE.lower()
    assert "already defined-risk" in m or "already be defined-risk" in m
    assert "throwaway" in m


def test_mandate_requires_rationale_to_match_placed_legs():
    m = at.SYSTEM_MANDATE.lower()
    assert "rationale" in m
    assert "exact structure" in m and "same strikes" in m


def test_run_cycle_records_open_in_outcome(_wire):
    """A successful open is captured in the persisted cycle outcome."""
    at.run_cycle(client=_FakeClient([_open_intent()]))
    oc = at.load_state()["_meta"]["last_cycle_outcome"]
    assert len(oc["opened"]) == 1 and oc["opened"][0]["order_id"] == "ORD-1"
    assert oc["rejected"] == [] and oc["closed"] == []


def test_run_cycle_rejection_pings_errors_and_records_outcome(_wire, monkeypatch):
    """An Alpaca rejection must (a) ping #agent-errors — not stay log-only — and
    (b) be recorded in the outcome so next cycle sees it and won't blindly retry."""
    embeds = []
    monkeypatch.setattr(at, "send_embed",
                        lambda channel, **k: embeds.append((channel, k)))
    monkeypatch.setattr(at, "place_order",
                        lambda p: _OrderResp(status=403,
                                             body={"message": "naked short not permitted"}))
    summary = at.run_cycle(client=_FakeClient([_open_intent()]))
    assert summary["errors"] == 1 and summary["opened"] == 0
    # (a) pinged the errors channel
    assert any(ch == at._CFG["errors_channel"] for ch, _ in embeds)
    # (b) recorded in the persisted outcome with Alpaca's reason
    oc = at.load_state()["_meta"]["last_cycle_outcome"]
    assert len(oc["rejected"]) == 1
    rej = oc["rejected"][0]
    assert rej["source"] == "alpaca" and "403" in rej["reason"]


def test_run_cycle_feasibility_reject_recorded_in_outcome(_wire):
    """An intent the code refuses (open without a thesis) lands in the outcome
    with source=feasibility — so the agent sees its own malformed attempt too."""
    at.run_cycle(client=_FakeClient([_open_intent(thesis=None)]))
    oc = at.load_state()["_meta"]["last_cycle_outcome"]
    assert len(oc["rejected"]) == 1 and oc["rejected"][0]["source"] == "feasibility"


def test_run_cycle_hold_persists_empty_outcome(_wire):
    """A hold cycle persists an empty (but present) outcome — so next cycle's
    feed shows 'nothing executed' rather than a stale prior outcome."""
    at.run_cycle(client=_FakeClient([]))
    oc = at.load_state()["_meta"]["last_cycle_outcome"]
    assert oc == {"opened": [], "closed": [], "rejected": []}


# ── Fill price / slippage capture ───────────────────────────────────────────

def test_intent_net_credit_mleg_and_single_leg():
    # mleg put credit spread, limit −0.295 → +0.295 credit intended
    mleg = {"order_type": "limit", "limit_price": -0.295,
            "legs": [{"symbol": "DIS...P103", "side": "sell", "qty": 1},
                     {"symbol": "DIS...P100", "side": "buy", "qty": 1}]}
    assert at._intent_net_credit(mleg) == 0.295
    # single short option: selling at 1.25 → +1.25 credit
    assert at._intent_net_credit(
        {"order_type": "limit", "limit_price": 1.25,
         "legs": [{"symbol": "X", "side": "sell", "qty": 1}]}) == 1.25
    # single long option: buying at 1.25 → −1.25 (debit paid)
    assert at._intent_net_credit(
        {"order_type": "limit", "limit_price": 1.25,
         "legs": [{"symbol": "X", "side": "buy", "qty": 1}]}) == -1.25
    # market order → no intended price
    assert at._intent_net_credit(
        {"order_type": "market", "limit_price": None,
         "legs": [{"symbol": "X", "side": "buy", "qty": 1}]}) is None


def test_actual_net_credit_from_leg_avg_entries():
    legs = [{"symbol": "DIS260828P00103000", "side": "sell", "qty": 1},
            {"symbol": "DIS260828P00100000", "side": "buy", "qty": 1}]
    # Filled worse than the 0.295 intended: short 0.44 − long 0.20 = 0.24 credit
    positions = [{"symbol": "DIS260828P00103000", "avg_entry_price": "0.44"},
                 {"symbol": "DIS260828P00100000", "avg_entry_price": "0.20"}]
    assert at._actual_net_credit(legs, positions) == 0.24


def test_actual_net_credit_none_if_a_leg_missing():
    legs = [{"symbol": "A", "side": "sell", "qty": 1},
            {"symbol": "B", "side": "buy", "qty": 1}]
    positions = [{"symbol": "A", "avg_entry_price": "0.44"}]  # B not visible yet
    assert at._actual_net_credit(legs, positions) is None


def test_reconcile_computes_fill_and_slippage(monkeypatch):
    """A tracked open with an intended price gets a fill block (intended vs actual
    vs slippage) once its legs are visible on Alpaca."""
    state = at._empty_state()
    state["positions"]["O-1"] = {
        "opened_at": "2026-08-15T13:00:00Z",
        "legs": [{"symbol": "DIS260828P00103000", "side": "sell", "qty": 1},
                 {"symbol": "DIS260828P00100000", "side": "buy", "qty": 1}],
        "thesis": {"confidence": 3}, "intended_net_credit": 0.295,
        "last_snapshot": None,
    }
    alpaca_positions = [
        {"symbol": "DIS260828P00103000", "side": "short", "qty": "-1",
         "avg_entry_price": "0.44", "unrealized_pl": "0", "market_value": "-44",
         "cost_basis": "-44"},
        {"symbol": "DIS260828P00100000", "side": "long", "qty": "1",
         "avg_entry_price": "0.20", "unrealized_pl": "0", "market_value": "20",
         "cost_basis": "20"},
    ]
    at._reconcile_and_grade(state, alpaca_positions, market={},
                            client=None, summary={"closed": 0}, dry_run=True)
    fill = state["positions"]["O-1"]["fill"]
    assert fill["fill_available"] is True
    assert fill["intended_net_credit"] == 0.295
    assert fill["actual_net_credit"] == 0.24
    assert fill["slippage"] == -0.055   # got 0.055 less credit than intended


def test_position_qty_isolated_true_when_qty_matches():
    legs = [{"symbol": "A", "side": "sell", "qty": 1},
            {"symbol": "B", "side": "buy", "qty": 1}]
    positions = [{"symbol": "A", "qty": "-1"}, {"symbol": "B", "qty": "1"}]
    assert at._position_qty_is_isolated({"legs": legs}, positions) is True


def test_position_qty_isolated_false_when_blended():
    """A second unit added → Alpaca qty is 2, this order was 1 → not isolated."""
    legs = [{"symbol": "A", "side": "sell", "qty": 1},
            {"symbol": "B", "side": "buy", "qty": 1}]
    positions = [{"symbol": "A", "qty": "-2"}, {"symbol": "B", "qty": "2"}]
    assert at._position_qty_is_isolated({"legs": legs}, positions) is False


def test_reconcile_flags_blended_quantity_instead_of_faking_slippage(monkeypatch):
    """If the agent added a second unit, the blended avg can't isolate this
    order's fill — reconcile must flag it, not report a meaningless number."""
    state = at._empty_state()
    state["positions"]["O-1"] = {
        "opened_at": "2026-08-15T13:00:00Z",
        "legs": [{"symbol": "DIS260828P00103000", "side": "sell", "qty": 1},
                 {"symbol": "DIS260828P00100000", "side": "buy", "qty": 1}],
        "thesis": {"confidence": 3}, "intended_net_credit": 0.295,
        "last_snapshot": None,
    }
    # Alpaca shows qty -2/+2 (a second unit was opened) with a blended average.
    alpaca_positions = [
        {"symbol": "DIS260828P00103000", "side": "short", "qty": "-2",
         "avg_entry_price": "0.42", "unrealized_pl": "0", "market_value": "-84",
         "cost_basis": "-84"},
        {"symbol": "DIS260828P00100000", "side": "long", "qty": "2",
         "avg_entry_price": "0.18", "unrealized_pl": "0", "market_value": "36",
         "cost_basis": "36"},
    ]
    at._reconcile_and_grade(state, alpaca_positions, market={},
                            client=None, summary={"closed": 0}, dry_run=True)
    fill = state["positions"]["O-1"]["fill"]
    assert fill["fill_available"] is False
    assert "slippage" not in fill and "actual_net_credit" not in fill


def test_run_cycle_open_records_intended_net_credit(_wire):
    """A limit spread open records what it asked for, immediately, in the outcome."""
    intent = _open_intent(order_type="limit", limit_price=-0.40, legs=[
        {"asset": "option", "symbol": "AAL260320P00012500", "side": "sell", "qty": 1},
        {"asset": "option", "symbol": "AAL260320P00011500", "side": "buy", "qty": 1},
    ])
    at.run_cycle(client=_FakeClient([intent]))
    oc = at.load_state()["_meta"]["last_cycle_outcome"]
    assert oc["opened"][0]["intended_net_credit"] == 0.40


# ── Chain trim: strike ladder per expiration (2026-10-21) ───────────────────
# The old nearest-the-money sort, with 4-5 expirations in the 7-45 DTE window,
# handed the model the ATM strike repeated per expiry and nothing beyond ~1% of
# spot — so the OTM credit spread its own record favors was unbuildable from
# the data. The ladder keeps ATM + 2.5/5/10/15% out on each side per expiry.

def _fake_chain(spot=100.0, expiries=("261030", "261120"), strikes=None):
    strikes = strikes or [s for s in range(70, 131, 5)]  # $5 strikes, 70..130
    snaps = {}
    for e in expiries:
        for k in strikes:
            for t in ("C", "P"):
                snaps[f"XYZ{e}{t}{int(k * 1000):08d}"] = {
                    "latestQuote": {"bp": 1.0, "ap": 1.2}, "greeks": {"delta": 0.5}, "impliedVolatility": 0.3,
                }
    return snaps


def test_ladder_reaches_otm_strikes_on_both_sides_every_expiry():
    snaps = _fake_chain()
    out = at._trim_chain(snaps, spot=100.0, keep=1000)
    strikes_by = {}
    for occ in out:
        p = at._occ_parse(occ)
        strikes_by.setdefault((p["expiry"], p["type"]), set()).add(p["strike"])
    assert set(strikes_by) == {(e, t) for e in ("2026-10-30", "2026-11-20") for t in ("C", "P")}
    for key, ks in strikes_by.items():
        # ATM, ±2.5% (rounds to 100 or 105/95 at $5 spacing), ±5%, ±10%, ±15%
        assert 100.0 in ks, key
        assert 85.0 in ks and 115.0 in ks, key           # ~15% out, both sides
        assert 90.0 in ks and 110.0 in ks, key           # ~10% out
        assert min(ks) <= 85.0 and max(ks) >= 115.0, key


def test_ladder_dedupes_when_rungs_collapse_onto_one_strike():
    # $5 strikes on a $20 stock: 2.5% and 5% rungs both round to the $20 strike.
    snaps = _fake_chain(spot=20.0, expiries=("261030",), strikes=[10, 15, 20, 25, 30])
    out = at._trim_chain(snaps, spot=20.0, keep=1000)
    assert len(out) == len(set(out))
    # 5 unique strikes × 2 types — never more rows than distinct contracts.
    assert len(out) <= 10


def test_ladder_cap_drops_far_expirations_not_near_atm():
    snaps = _fake_chain(expiries=("261030", "261120", "261218"))
    out = at._trim_chain(snaps, spot=100.0, keep=20)
    assert len(out) == 20
    exps = {at._occ_parse(o)["expiry"] for o in out}
    assert "2026-10-30" in exps and "2026-12-18" not in exps


def test_trim_without_spot_falls_back_to_leading_slice():
    snaps = _fake_chain()
    out = at._trim_chain(snaps, spot=None, keep=5)
    assert list(out) == list(snaps)[:5]


def test_default_chain_keep_covers_several_expirations_of_ladder():
    # 18 rows per expiry (9 strikes × 2 types) at full rung coverage; the cap
    # must admit a few expirations or the fix is moot.
    assert at._CFG["chain_keep"] >= 54


# ── Strike-request step (2026-10-21) ────────────────────────────────────────
# The model names the chain windows it wants priced; the ladder is the
# fallback. These cover the skeleton, window selection, the forced-tool call,
# the strict-schema rule, and the assembled pack (requested slice vs fallback,
# held legs always present, chain_keep cap).

from datetime import date as _date

_TODAY = _date(2026, 10, 21)


def _chain(spot=100.0, expiries=("261030", "261120"), strikes=None):
    return _fake_chain(spot=spot, expiries=expiries, strikes=strikes)


def test_chain_skeleton_lists_expiries_dte_and_strike_grid():
    sk = at.chain_skeleton(_chain(), spot=100.0, today=_TODAY)
    assert sk["spot"] == 100.0
    assert [e["expiry"] for e in sk["expiries"]] == ["2026-10-30", "2026-11-20"]
    assert sk["expiries"][0]["dte"] == 9 and sk["expiries"][1]["dte"] == 30
    puts = sk["expiries"][0]["puts"]
    assert puts == {"min": 70.0, "max": 130.0, "step": 5.0, "n": 13}
    assert sk["expiries"][0]["calls"]["n"] == 13
    # No prices in the skeleton — that is the whole point.
    assert "bid" not in json.dumps(sk)


def test_select_window_otm_puts_at_a_dte_range():
    win = {"types": ["P"], "dte_min": 20, "dte_max": 45, "moneyness_from_pct": -15, "moneyness_to_pct": -5}
    occs = at._select_window(_chain(), 100.0, win, today=_TODAY)
    parsed = [at._occ_parse(o) for o in occs]
    assert parsed and all(p["type"] == "P" for p in parsed)
    assert {p["expiry"] for p in parsed} == {"2026-11-20"}          # 30 DTE only; 9 DTE excluded
    assert {p["strike"] for p in parsed} == {85.0, 90.0, 95.0}       # 85..95 inclusive
    # Reversed bounds behave the same.
    rev = dict(win, moneyness_from_pct=-5, moneyness_to_pct=-15)
    assert at._select_window(_chain(), 100.0, rev, today=_TODAY) == occs


def test_select_window_empty_when_nothing_matches_or_malformed():
    assert at._select_window(_chain(), 100.0, {"types": ["C"], "dte_min": 60, "dte_max": 90,
                                               "moneyness_from_pct": 0, "moneyness_to_pct": 5}, today=_TODAY) == []
    assert at._select_window(_chain(), 100.0, {"dte_min": "x"}, today=_TODAY) == []


def test_strikes_tool_schema_uses_no_keywords_strict_mode_rejects():
    bad = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
           "minLength", "maxLength", "pattern", "format", "minItems", "maxItems"}
    def walk(n):
        if isinstance(n, dict):
            for k, v in n.items():
                yield k
                yield from walk(v)
        elif isinstance(n, list):
            for v in n:
                yield from walk(v)
    assert not (set(walk(at.STRIKES_TOOL["input_schema"])) & bad)


class _StrikesClient:
    """Fake Anthropic client answering the select_strikes forced tool call.
    (The module-level _FakeResp/_FakeBlock are hard-wired to submit_decisions.)"""

    def __init__(self, requests, stop_reason="tool_use"):
        self.requests, self.stop, self.calls, self.messages = requests, stop_reason, [], self

    def create(self, **kw):
        self.calls.append(kw)
        block = type("B", (), {})()
        block.type, block.name, block.input = "tool_use", "select_strikes", {"requests": self.requests}
        resp = type("R", (), {})()
        resp.content, resp.stop_reason, resp.usage = [block], self.stop, None
        return resp


def test_request_strikes_parses_and_drops_unknown_symbols():
    client = _StrikesClient([
        {"symbol": "xyz", "intent": "otm put credit spread", "types": ["P"], "dte_min": 20,
         "dte_max": 45, "moneyness_from_pct": -15, "moneyness_to_pct": -5},
        {"symbol": "NOPE", "intent": "x", "types": ["C"], "dte_min": 7, "dte_max": 45,
         "moneyness_from_pct": 0, "moneyness_to_pct": 5},
    ])
    out = at.request_strikes({"XYZ": {"spot": 100.0, "expiries": []}}, client=client)
    assert out["refused"] is False
    assert list(out["requests"]) == ["XYZ"]                       # uppercased; NOPE dropped
    assert out["requests"]["XYZ"][0]["intent"] == "otm put credit spread"
    kw = client.calls[0]
    assert kw["tool_choice"] == {"type": "tool", "name": "select_strikes"}
    assert kw["output_config"]["effort"] == "low" and kw["thinking"]["type"] == "adaptive"


def test_request_strikes_refusal_means_ladder_for_all():
    out = at.request_strikes({"XYZ": {}}, client=_StrikesClient([], stop_reason="refusal"))
    assert out == {"requests": {}, "refused": True}


@pytest.fixture
def _chains(monkeypatch):
    """Stub the network: one chain for XYZ, quote at $100."""
    monkeypatch.setattr(at.alpaca_data, "get_stock_quote", lambda sym, mode="agent": {"ap": 100.0, "bp": 99.9})
    monkeypatch.setattr(at.alpaca_data, "get_option_chain_snapshots",
                        lambda sym, exp_min_days=7, exp_max_days=45, mode="agent": _chain())
    class _Pinned(_date):                       # a real date subclass: _occ_parse constructs date(...)
        @classmethod
        def today(cls):
            return _TODAY
    monkeypatch.setattr(at, "date", _Pinned)


def test_build_market_pack_prices_the_requested_window(_chains):
    client = _StrikesClient([{"symbol": "XYZ", "intent": "otm pcs", "types": ["P"], "dte_min": 20,
                              "dte_max": 45, "moneyness_from_pct": -15, "moneyness_to_pct": -5}])
    pack = at.build_market_pack(["XYZ"], client=client)
    e = pack["XYZ"]
    assert e["strike_request"]["fallback"] is False
    assert e["strike_request"]["rows"] == 3
    assert {at._occ_parse(o)["strike"] for o in e["options"]} == {85.0, 90.0, 95.0}
    assert all(v["bid"] == 1.0 and v["ask"] == 1.2 for v in e["options"].values())
    assert e["option_count"] == len(_chain())


def test_build_market_pack_falls_back_to_ladder_when_window_is_empty(_chains):
    client = _StrikesClient([{"symbol": "XYZ", "intent": "far out", "types": ["C"], "dte_min": 60,
                              "dte_max": 90, "moneyness_from_pct": 0, "moneyness_to_pct": 5}])
    e = at.build_market_pack(["XYZ"], client=client)["XYZ"]
    assert e["strike_request"]["fallback"] is True
    assert "matched no contracts" in e["strike_request"]["note"]
    assert len(e["options"]) > 10                                   # ladder rows, not nothing


def test_build_market_pack_falls_back_when_request_step_raises(_chains):
    class Boom:
        messages = property(lambda self: (_ for _ in ()).throw(RuntimeError("api down")))
    e = at.build_market_pack(["XYZ"], client=Boom())["XYZ"]
    assert e["strike_request"]["fallback"] is True
    assert "failed" in e["strike_request"]["note"]


def test_build_market_pack_always_includes_held_legs(_chains):
    held = "XYZ261030C00130000"   # +30%, outside any sane window
    client = _StrikesClient([{"symbol": "XYZ", "intent": "pcs", "types": ["P"], "dte_min": 20,
                              "dte_max": 45, "moneyness_from_pct": -15, "moneyness_to_pct": -5}])
    e = at.build_market_pack(["XYZ"], client=client, held_occs=[held])["XYZ"]
    assert held in e["options"]


def test_build_market_pack_can_skip_the_request_step(_chains):
    class Never:
        messages = property(lambda self: (_ for _ in ()).throw(AssertionError("must not be called")))
    e = at.build_market_pack(["XYZ"], client=Never(), ask_strikes=False)["XYZ"]
    assert e["strike_request"]["fallback"] is True and e["strike_request"]["windows"] == []


def test_gather_depth_passes_client_to_market_pack(monkeypatch):
    seen = {}
    monkeypatch.setattr(at, "build_market_pack",
                        lambda syms, mode="agent", **kw: seen.update(kw) or {})
    monkeypatch.setattr(at, "build_context_pack", lambda syms, mode="agent": {})
    monkeypatch.setattr(at, "annotate_positions_fair_value", lambda pos, mode="agent": pos)
    sentinel = object()
    at.gather_depth(["AAPL"], [{"symbol": "TSLA260320C00300000"}], {"equity": 2000}, client=sentinel)
    assert seen["client"] is sentinel
    assert seen["held_occs"] == ["TSLA260320C00300000"]


# ── Observe mode + strikes visibility (2026-10-23) ──────────────────────────

def test_strikes_field_formats_windows_and_fallbacks():
    market = {
        "FCX": {"strike_request": {"windows": [{"intent": "otm pcs", "types": ["P"], "dte_min": 25,
                                                "dte_max": 45, "moneyness_from_pct": -15, "moneyness_to_pct": -5}],
                                   "fallback": False, "rows": 6, "note": None}},
        "ABT": {"strike_request": {"windows": [], "fallback": True, "rows": 72,
                                   "note": "requested window matched no contracts; ladder used"}},
    }
    txt = at._strikes_field(market)
    assert "`ABT` ladder (requested window matched no contracts; ladder used)" in txt
    assert "`FCX` otm pcs · P -15..-5% 25–45d (6 rows)" in txt
    assert at._strikes_field({}) == "(no chains priced)"


def test_run_cycle_observe_bypasses_guard_places_nothing_and_saves_nothing(_wire, monkeypatch, tmp_path):
    monkeypatch.setattr(at.alpaca_data, "is_market_open", lambda mode="agent": False)
    cards = []
    monkeypatch.setattr(at, "send_embed", lambda *a, **k: cards.append(k))
    client = _FakeClient([_open_intent()], market_read="observing")
    out = at.run_cycle(client=client, observe=True)
    assert out["opened"] == 0 and out["observed"] == 1 and out["errors"] == 0
    assert out.get("skipped") is None                         # guard bypassed
    assert _wire == []                                         # nothing sent to Alpaca
    assert not (tmp_path / "agent_state.json").exists()        # no state write
    card = cards[-1]
    assert card["title"].startswith("👁 Observe")
    names = [f["name"] for f in card["fields"]]
    assert any(n.startswith("Would have placed") for n in names)
    would = [f for f in card["fields"] if f["name"].startswith("Would have placed")][0]["value"]
    assert "open buy 1 AAPL260320P00150000" in would


def test_run_cycle_logs_strikes_selected(_wire, monkeypatch):
    events = []
    monkeypatch.setattr(at, "log_event", lambda stream, script, action, **kw: events.append((action, kw)))
    monkeypatch.setattr(at, "gather_depth", lambda focus, positions, account, mode="agent", **kw: {
        "account": {"equity": 2000.0, "cash": 2000.0}, "positions": [], "equity_floor": 500,
        "market": {"XYZ": {"strike_request": {"windows": [], "fallback": True, "rows": 3, "note": "x"}}},
    })
    at.run_cycle(client=_FakeClient([]))
    sel = [kw for a, kw in events if a == "strikes_selected"]
    assert sel and sel[0]["details"]["XYZ"]["fallback"] is True


# ── Multi-leg limit sign (2026-10-23) ───────────────────────────────────────
# Every credit spread the agent opened went out with a POSITIVE limit, which
# Alpaca reads as a debit cap — a capped market order filling at the cross.
# ZS 200/197.5 filled at a $0.25 DEBIT: a short vertical that cannot profit.

_PCS = [{"asset": "option", "symbol": "ZS261120P00200000", "side": "sell", "qty": 1},
        {"asset": "option", "symbol": "ZS261120P00197500", "side": "buy", "qty": 1}]
_CDS = [{"asset": "option", "symbol": "SLB260918C00059000", "side": "buy", "qty": 1},
        {"asset": "option", "symbol": "SLB260918C00060000", "side": "sell", "qty": 1}]


def test_credit_spread_with_positive_limit_is_rejected():
    ok, reason = at.check_feasibility(_open_intent(legs=_PCS, limit_price=0.6), {"equity": 900})
    assert not ok and "credit structure" in reason and "NEGATIVE" in reason and "-0.6" in reason


def test_credit_spread_with_negative_limit_passes():
    ok, reason = at.check_feasibility(_open_intent(legs=_PCS, limit_price=-0.6), {"equity": 900})
    assert ok, reason


def test_debit_spread_sign_rules():
    ok, reason = at.check_feasibility(_open_intent(legs=_CDS, limit_price=-0.65), {"equity": 2000})
    assert not ok and "debit structure" in reason
    ok, reason = at.check_feasibility(_open_intent(legs=_CDS, limit_price=0.65), {"equity": 2000})
    assert ok, reason


def test_single_leg_limit_must_be_positive():
    ok, reason = at.check_feasibility(_open_intent(limit_price=-1.25), {"equity": 2000})
    assert not ok and "positive" in reason


def _close(legs, limit):
    return _open_intent(action="close", thesis=None, legs=legs, limit_price=limit)


def test_wrong_signed_close_is_flipped_not_rejected():
    # The real SLB 09-04 / TSLA 09-16 exits: closing a call DEBIT spread
    # (sell the long, buy back the short) RECEIVES a credit → negative limit.
    slb = _close([{"asset": "option", "symbol": "SLB260918C00059000", "side": "sell", "qty": 1},
                  {"asset": "option", "symbol": "SLB260918C00060000", "side": "buy", "qty": 1}], 0.19)
    assert at.normalize_close_limit(slb) == 0.19
    assert slb["limit_price"] == -0.19
    tsla = _close([{"asset": "option", "symbol": "TSLA260918C00352500", "side": "sell", "qty": 1},
                   {"asset": "option", "symbol": "TSLA260918C00365000", "side": "buy", "qty": 1}], 5.25)
    assert at.normalize_close_limit(tsla) == 5.25 and tsla["limit_price"] == -5.25
    # Closing a credit spread costs a debit → a positive limit is already right.
    zs = _close([{"asset": "option", "symbol": "ZS261120P00200000", "side": "buy", "qty": 1},
                 {"asset": "option", "symbol": "ZS261120P00197500", "side": "sell", "qty": 1}], 0.40)
    assert at.normalize_close_limit(zs) is None and zs["limit_price"] == 0.40
    # A single-leg close with a negative price becomes positive.
    one = _close([{"asset": "option", "symbol": "SLV261016C00059500", "side": "sell", "qty": 1}], -0.76)
    assert at.normalize_close_limit(one) == -0.76 and one["limit_price"] == 0.76
    # Opens are never rewritten — they are rejected and reported instead.
    opn = _open_intent(legs=_PCS, limit_price=0.6)
    assert at.normalize_close_limit(opn) is None and opn["limit_price"] == 0.6


def test_market_option_open_is_rejected_but_market_close_and_stock_are_not():
    mkt = _open_intent(legs=_PCS, order_type="market", limit_price=None)
    ok, reason = at.check_feasibility(mkt, {"equity": 900})
    assert not ok and "LIMIT" in reason
    assert at._limit_sign_problem(mkt) is None
    close = _close(_PCS_CLOSE, None)
    close["order_type"] = "market"
    assert at.check_feasibility(close, {"equity": 900})[0]
    stock = _open_intent(order_type="market", limit_price=None,
                         legs=[{"asset": "stock", "symbol": "F", "side": "buy", "qty": 1}])
    assert at.check_feasibility(stock, {"equity": 900})[0]


def test_short_stock_open_is_rejected():
    short = _open_intent(order_type="market", limit_price=None,
                         legs=[{"asset": "stock", "symbol": "F", "side": "sell", "qty": 1}])
    ok, reason = at.check_feasibility(short, {"equity": 900})
    assert not ok and "short stock" in reason


_PCS_CLOSE = [{"asset": "option", "symbol": "ZS261120P00200000", "side": "buy", "qty": 1},
              {"asset": "option", "symbol": "ZS261120P00197500", "side": "sell", "qty": 1}]
_HELD_ZS = [{"symbol": "ZS261120P00200000", "qty": "-1", "side": "short"},
            {"symbol": "ZS261120P00197500", "qty": "1", "side": "long"}]


def test_close_must_reduce_a_held_position():
    ok, reason = at.check_feasibility(_close(_PCS_CLOSE, 0.40), {"equity": 900},
                                      positions=_HELD_ZS)
    assert ok, reason
    # Nothing held → the "close" would open something new.
    ok, reason = at.check_feasibility(
        _close([{"asset": "option", "symbol": "TSLA261120C00400000", "side": "buy", "qty": 3}], 2.0),
        {"equity": 900}, positions=_HELD_ZS)
    assert not ok and "not held" in reason
    # Same side as the holding adds to it.
    ok, reason = at.check_feasibility(_close(_PCS, -0.4), {"equity": 900}, positions=_HELD_ZS)
    assert not ok and "ADD" in reason
    # More than held.
    big = [dict(l, qty=2) for l in _PCS_CLOSE]
    ok, reason = at.check_feasibility(_close(big, 0.40), {"equity": 900}, positions=_HELD_ZS)
    assert not ok and "exceeds" in reason


def test_uneven_leg_ratio_is_rejected_but_whole_multiples_pass():
    uneven = [dict(_PCS[0], qty=3), dict(_PCS[1], qty=2)]
    ok, reason = at.check_feasibility(_open_intent(legs=uneven, limit_price=-0.6),
                                      {"equity": 5000})
    assert not ok and "multiples" in reason
    # 1×2 put ratio (buy 1 higher, sell 2 lower) is a valid ratio — the sign/
    # size rules then decide it; here it's simply not rejected for its ratio.
    ratio = [{"asset": "option", "symbol": "ZS261120P00200000", "side": "buy", "qty": 1},
             {"asset": "option", "symbol": "ZS261120P00197500", "side": "sell", "qty": 2}]
    ok, reason = at.check_feasibility(_open_intent(legs=ratio, limit_price=0.10),
                                      {"equity": 100000})
    assert "multiples" not in reason


def test_sub_penny_limit_is_rejected():
    ok, reason = at.check_feasibility(_open_intent(legs=_PCS, limit_price=-0.004),
                                      {"equity": 900})
    assert not ok and "$0.00" in reason


# ── Structure economics beyond verticals (2026-10-26 review: A2/A8) ─────────

def _ic(limit):
    # SPY 560/565 put credit + 600/605 call credit = short iron condor.
    return _open_intent(limit_price=limit, legs=[
        {"asset": "option", "symbol": "SPY261120P00560000", "side": "buy", "qty": 1},
        {"asset": "option", "symbol": "SPY261120P00565000", "side": "sell", "qty": 1},
        {"asset": "option", "symbol": "SPY261120C00600000", "side": "sell", "qty": 1},
        {"asset": "option", "symbol": "SPY261120C00605000", "side": "buy", "qty": 1}])


def test_iron_condor_sign_and_max_loss():
    # Correct sign: credit 0.80 → max loss = widest wing (5) − 0.80 = $420,
    # not the old outer-span $4,420.
    good = _ic(-0.80)
    assert at._intent_max_loss(good) == pytest.approx(420.0)
    ok, reason = at.check_feasibility(good, {"equity": 2000})
    assert ok, reason
    # Wrong sign (the ZS bug, four legs wide) is now caught.
    ok, reason = at.check_feasibility(_ic(0.80), {"equity": 2000})
    assert not ok and "NEGATIVE" in reason


def test_butterfly_straddle_and_calendar_directions():
    fly = [{"asset": "option", "symbol": "SPY261120C00580000", "side": "buy", "qty": 1},
           {"asset": "option", "symbol": "SPY261120C00590000", "side": "sell", "qty": 2},
           {"asset": "option", "symbol": "SPY261120C00600000", "side": "buy", "qty": 1}]
    assert at._net_direction(fly) == "debit"
    assert at._intent_max_loss(_open_intent(legs=fly, limit_price=1.50)) == pytest.approx(150.0)
    straddle = [{"asset": "option", "symbol": "SPY261120C00590000", "side": "buy", "qty": 1},
                {"asset": "option", "symbol": "SPY261120P00590000", "side": "buy", "qty": 1}]
    ok, reason = at.check_feasibility(_open_intent(legs=straddle, limit_price=-3.0), {"equity": 5000})
    assert not ok and "POSITIVE" in reason
    # Long calendar: sell near, buy far, same strike → a debit (the old
    # strike-only classifier called it a credit spread and rejected +1.20).
    cal = [{"asset": "option", "symbol": "SPY261120P00590000", "side": "sell", "qty": 1},
           {"asset": "option", "symbol": "SPY261218P00590000", "side": "buy", "qty": 1}]
    assert at._net_direction(cal) == "debit"
    ok, reason = at.check_feasibility(_open_intent(legs=cal, limit_price=1.20), {"equity": 2000})
    assert ok, reason
    assert at._intent_max_loss(_open_intent(legs=cal, limit_price=1.20)) == pytest.approx(120.0)
    # A short leg that outlives the long can't be bounded at the near expiry.
    rev = [dict(cal[0], side="buy"), dict(cal[1], side="sell")]
    ok, reason = at.check_feasibility(_open_intent(legs=rev, limit_price=-1.20), {"equity": 100000})
    assert not ok and "unbounded" in reason


def test_net_direction_uses_live_mids_when_every_leg_is_priced():
    legs = [{"asset": "option", "symbol": "ZS261120P00200000", "side": "sell", "qty": 1},
            {"asset": "option", "symbol": "ZS261120P00197500", "side": "buy", "qty": 1}]
    market = {"ZS": {"quote": {"ap": 256.6},
                     "options": {"ZS261120P00200000": {"bid": 3.42, "ask": 3.88},
                                 "ZS261120P00197500": {"bid": 2.96, "ask": 3.63}}}}
    assert at._net_direction(legs, market) == "credit"


def test_single_option_leg_carries_position_intent_but_stock_does_not():
    p = at.build_order_payload(_open_intent())
    assert p["position_intent"] == "buy_to_open"
    c = at.build_order_payload(_close([{"asset": "option", "symbol": "SLV261016C00059500",
                                        "side": "sell", "qty": 1}], 0.76))
    assert c["position_intent"] == "sell_to_close"
    s_ = at.build_order_payload(_open_intent(order_type="market", limit_price=None,
                                             legs=[{"asset": "stock", "symbol": "F",
                                                    "side": "buy", "qty": 1}]))
    assert "position_intent" not in s_


def test_run_cycle_flips_a_wrong_signed_close_and_reports_it(_wire, monkeypatch, tmp_path):
    held = _HELD_ZS
    monkeypatch.setattr(at, "gather_depth", lambda focus, positions, account, mode="agent", **kw: {
        "account": {"equity": 900.0, "cash": 900.0}, "positions": held,
        "market": {}, "equity_floor": 500})
    monkeypatch.setattr(at, "_reconcile_and_grade", lambda *a, **k: None)
    # Model sends the ZS close with a NEGATIVE limit (it thinks "credit spread").
    intent = _close(_PCS_CLOSE, -0.40)
    at.run_cycle(client=_FakeClient([intent]))
    assert _wire and _wire[-1]["limit_price"] == "0.40"
    st = json.loads((tmp_path / "agent_state.json").read_text())
    closed = st["_meta"]["last_cycle_outcome"]["closed"]
    assert closed and "sign was wrong" in closed[0]["limit_sign_corrected"]


def test_payoff_at_fill_flags_a_credit_spread_filled_as_a_debit():
    fill = {"fill_available": True, "intended_net_credit": -0.6, "actual_net_credit": -0.25}
    out = at._payoff_at_fill(_PCS, fill)
    assert out["max_profit_usd"] == -25.0 and out["max_loss_usd"] == 275.0
    assert "CANNOT finish profitable" in out["note"]


def test_payoff_at_fill_normal_credit_and_debit_spreads():
    good = at._payoff_at_fill(_PCS, {"fill_available": True, "actual_net_credit": 0.40})
    assert good["max_profit_usd"] == 40.0 and good["max_loss_usd"] == 210.0 and "note" not in good
    deb = at._payoff_at_fill(_CDS, {"fill_available": True, "actual_net_credit": -0.30})
    assert deb["max_profit_usd"] == 70.0 and deb["max_loss_usd"] == 30.0 and "note" not in deb
    assert at._payoff_at_fill(_PCS, {"fill_available": False}) is None
    assert at._payoff_at_fill(_PCS, None) is None


def test_self_context_carries_payoff_at_fill():
    state = {"positions": {"o1": {"legs": _PCS, "thesis": {"thesis": "t"},
                                  "fill": {"fill_available": True, "actual_net_credit": -0.25}}},
             "closed": [], "_meta": {}}
    ctx = at.build_self_context(state)
    assert ctx["open_position_theses"][0]["payoff_at_fill"]["max_profit_usd"] == -25.0


def test_mandate_and_schema_state_the_sign_rule():
    assert "SIGNED NET" in at.SYSTEM_MANDATE and "limit_price -0.40" in at.SYSTEM_MANDATE
    desc = at.DECISION_TOOL["input_schema"]["properties"]["intents"]["items"]["properties"]["limit_price"]["description"]
    assert "NEGATIVE for a net credit" in desc


# ── Robustness + account-wide risk (2026-10-26 review: A6, A7, A10, A11, O3, S5) ──

def test_total_risk_cap_counts_what_is_already_open():
    cap = {"equity_floor": 0, "max_risk_pct_equity": 0.30, "max_total_risk_pct_equity": 0.60}
    # $250 debit spread on $1,000: 25% alone is fine...
    ok, reason = at.check_feasibility(_debit_spread(2.50), {"equity": 1000}, cap, open_risk=300)
    assert ok, reason
    # ...but not on top of $400 already at risk (65% > 60%).
    ok, reason = at.check_feasibility(_debit_spread(2.50), {"equity": 1000}, cap, open_risk=400)
    assert not ok and "already at risk" in reason and "60%" in reason


def test_open_risk_sums_tracked_positions_from_their_fills():
    state = {"positions": {
        # ZS: filled at a $0.25 debit on a $2.50 put spread → $275 at risk.
        "zs": {"legs": _PCS, "fill": {"fill_available": True, "actual_net_credit": -0.25}},
        # Not yet filled: intended −0.6 (mis-signed) is re-signed to a 0.60 credit → $190.
        "pending": {"legs": _PCS, "intended_net_credit": -0.6},
        "stock": {"legs": [{"asset": "stock", "symbol": "F", "side": "buy", "qty": 10}],
                  "last_snapshot": {"cost_basis": 112.0}},
    }}
    assert at._open_risk(state) == pytest.approx(275 + 190 + 112)


def test_run_cycle_enforces_the_total_cap_across_opens_in_one_cycle(_wire, monkeypatch):
    monkeypatch.setattr(at, "gather_depth", lambda focus, positions, account, mode="agent", **kw: {
        "account": {"equity": 1000.0, "cash": 1000.0}, "positions": [], "market": {},
        "equity_floor": 500})
    at.run_cycle(client=_FakeClient([_debit_spread(2.80), _debit_spread(2.80), _debit_spread(2.80)]))
    assert len(_wire) == 2        # $280 + $280 = 56%; the third would make 84%


def test_orders_carry_a_client_id_and_a_timeout_is_recovered(_wire, monkeypatch, tmp_path):
    import requests as rq

    def timeout(payload):
        _wire.append(payload)
        raise rq.ReadTimeout("read timed out")

    monkeypatch.setattr(at, "place_order", timeout)
    monkeypatch.setattr(at, "_get_order_by_client_id", lambda cid: {"id": "ORD-9", "client_order_id": cid})
    out = at.run_cycle(client=_FakeClient([_open_intent()]))
    assert _wire[0]["client_order_id"].startswith("agent-")
    assert out["opened"] == 1 and out["errors"] == 0
    st = json.loads((tmp_path / "agent_state.json").read_text())
    assert "ORD-9" in st["positions"]


def test_timeout_with_no_order_found_is_reported_not_tracked(_wire, monkeypatch, tmp_path):
    import requests as rq
    monkeypatch.setattr(at, "place_order", lambda p: (_ for _ in ()).throw(rq.ConnectionError("reset")))
    out = at.run_cycle(client=_FakeClient([_open_intent()]))
    assert out["opened"] == 0 and out["errors"] == 1
    st = json.loads((tmp_path / "agent_state.json").read_text())
    rej = st["_meta"]["last_cycle_outcome"]["rejected"][0]
    assert rej["source"] == "network" and "open_orders" in rej["reason"]


def test_one_bad_intent_does_not_lose_the_others(_wire, monkeypatch, tmp_path):
    real = at.build_order_payload

    def flaky(intent):
        if intent.get("rationale") == "boom":
            raise KeyError("legs")
        return real(intent)

    monkeypatch.setattr(at, "build_order_payload", flaky)
    out = at.run_cycle(client=_FakeClient([_open_intent(rationale="boom"), _open_intent()]))
    assert out["opened"] == 1 and out["errors"] == 1
    st = json.loads((tmp_path / "agent_state.json").read_text())
    assert st["_meta"]["last_cycle_outcome"]["rejected"][0]["source"] == "internal"


def test_state_is_saved_right_after_each_placement(_wire, monkeypatch, tmp_path):
    saves = []
    real_save = at.save_state
    monkeypatch.setattr(at, "save_state", lambda st: saves.append(len(st["positions"])) or real_save(st))
    at.run_cycle(client=_FakeClient([_open_intent()]))
    assert saves[0] == 1          # persisted before the cycle's final save


def test_decision_cut_off_at_max_tokens_is_a_hold():
    out = at.request_decisions({"account": {}}, client=_FakeClient([_open_intent()], stop_reason="max_tokens"))
    assert out["intents"] == [] and "token limit" in out["market_read"]


def test_held_leg_inside_seven_days_is_still_priced(monkeypatch):
    near = "ZS261030P00200000"      # inside the 7–45 DTE chain fetch
    monkeypatch.setattr(at, "fetch_chains", lambda symbols, mode="agent": {
        "ZS": {"quote": {"p": 256.0}, "spot": 256.0, "snaps": {
            "ZS261120P00230000": {"latestQuote": {"bp": 1.0, "ap": 1.2}}}}})
    monkeypatch.setattr(at.alpaca_data, "get_option_snapshot",
                        lambda occ, mode="agent": {"latestQuote": {"bp": 0.05, "ap": 0.15}})
    pack = at.build_market_pack(["ZS"], held_occs=[near], ask_strikes=False)
    assert pack["ZS"]["options"][near]["bid"] == 0.05


def test_strike_window_truncation_is_flagged(monkeypatch):
    snaps = {f"ZS261120P{int(k * 1000):08d}": {"latestQuote": {"bp": 1, "ap": 2}}
             for k in range(150, 260, 1)}
    monkeypatch.setattr(at, "fetch_chains", lambda symbols, mode="agent": {
        "ZS": {"quote": {"p": 256.0}, "spot": 256.0, "snaps": snaps}})
    monkeypatch.setattr(at, "request_strikes", lambda sk, client=None: {"requests": {"ZS": [
        {"types": "P", "dte_min": 0, "dte_max": 60, "moneyness_from_pct": -40, "moneyness_to_pct": 0}]}})
    monkeypatch.setitem(at._CFG, "chain_keep", 10)
    pack = at.build_market_pack(["ZS"], ask_strikes=True)
    assert pack["ZS"]["strike_request"]["truncated"] is True
    assert pack["ZS"]["strike_request"]["rows"] == 10


def test_chain_fetch_follows_pages(monkeypatch):
    pages = [{"snapshots": {"A": 1}, "next_page_token": "t2"},
             {"snapshots": {"B": 2}, "next_page_token": None}]
    seen = []

    def fake_get(url, mode, params=None):
        seen.append(dict(params))
        return pages[len(seen) - 1]

    monkeypatch.setattr(at.alpaca_data, "_get", fake_get)
    out = at.alpaca_data.get_option_chain_snapshots("SPY", mode="agent")
    assert out == {"A": 1, "B": 2}
    assert "page_token" not in seen[0] and seen[1]["page_token"] == "t2"


def test_trend_context_uses_split_adjusted_bars(monkeypatch):
    calls = []
    monkeypatch.setattr(at.alpaca_data, "get_stock_bars",
                        lambda sym, days=90, timeframe="1Day", mode="manual", adjustment="raw":
                        calls.append(adjustment) or [])
    monkeypatch.setattr(at.earnings_mod, "earnings_context", lambda sym: {})
    at.build_context_pack(["NFLX"])
    assert calls == ["split"]


def test_days_to_expiry_uses_the_nearest_leg():
    from datetime import date
    legs = [{"symbol": "ZS261120P00200000"}, {"symbol": "ZS261218P00197500"}]
    assert at._days_to_expiry(legs, today=date(2026, 11, 17)) == 3
    assert at._days_to_expiry([{"symbol": "F"}]) is None
