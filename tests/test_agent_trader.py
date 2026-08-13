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
    def __init__(self, intents):
        self.type = "tool_use"
        self.name = "submit_decisions"
        self.input = {"intents": intents}


class _FakeResp:
    def __init__(self, intents, stop_reason="tool_use"):
        self.content = [_FakeBlock(intents)]
        self.stop_reason = stop_reason


class _FakeClient:
    def __init__(self, intents, stop_reason="tool_use"):
        self._intents = intents
        self._stop = stop_reason
        self.messages = self

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeResp(self._intents, self._stop)


def test_request_decisions_parses_tool_output():
    client = _FakeClient([_open_intent()])
    out = at.request_decisions({"account": {}}, client=client)
    assert out["refused"] is False
    assert len(out["intents"]) == 1
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
    """Stub context, state path, discord, and order placement for run_cycle."""
    monkeypatch.setattr(at, "_state_path", lambda: str(tmp_path / "agent_state.json"))
    monkeypatch.setattr(at, "gather_context", lambda mode="agent": {
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
