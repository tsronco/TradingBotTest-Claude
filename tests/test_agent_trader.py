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
                  "side": "sell", "qty": 1}],
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


def test_load_state_survives_corrupt_file(tmp_path, monkeypatch):
    p = tmp_path / "agent_state.json"
    p.write_text("{ not valid json")
    monkeypatch.setattr(at, "_state_path", lambda: str(p))
    assert at.load_state() == at._empty_state()


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
                        lambda focus, positions, account, mode="agent": {
                            "account": {"equity": 2000.0, "cash": 2000.0},
                            "positions": [], "market": {}, "equity_floor": 500,
                        })
    monkeypatch.setattr(at, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(at, "log_event", lambda *a, **k: None)
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
                        lambda syms, mode="agent": seen.setdefault("syms", syms) or {})
    positions = [{"symbol": "TSLA260320C00300000"}]  # a held option
    at.gather_depth(["AAPL"], positions, {"equity": 2000}, mode="agent")
    # Focus name, the held OCC symbol, AND its parsed underlying are all fetched.
    assert "AAPL" in seen["syms"]
    assert "TSLA260320C00300000" in seen["syms"]
    assert "TSLA" in seen["syms"]


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
                        lambda focus, positions, account, mode="agent":
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
    assert fill["intended_net_credit"] == 0.295
    assert fill["actual_net_credit"] == 0.24
    assert fill["slippage"] == -0.055   # got 0.055 less credit than intended


def test_run_cycle_open_records_intended_net_credit(_wire):
    """A limit spread open records what it asked for, immediately, in the outcome."""
    intent = _open_intent(order_type="limit", limit_price=-0.40, legs=[
        {"asset": "option", "symbol": "AAL260320P00012500", "side": "sell", "qty": 1},
        {"asset": "option", "symbol": "AAL260320P00011500", "side": "buy", "qty": 1},
    ])
    at.run_cycle(client=_FakeClient([intent]))
    oc = at.load_state()["_meta"]["last_cycle_outcome"]
    assert oc["opened"][0]["intended_net_credit"] == 0.40
