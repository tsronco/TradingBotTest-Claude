"""Tests for the live-account morning brief (live_brief.py).

Everything external is mocked per conftest.py convention: Alpaca gathering is
stubbed at the agent_trader helper level, the Anthropic client is a fake, and
Discord webhooks are cleared (send_embed is captured by monkeypatch). Covers:

  - the READ-ONLY invariant (no order-placement helper is imported or callable,
    and a full run never issues a write request)
  - context trimming (open orders, positions, previous-brief continuity)
  - request_brief parsing (forced tool, idea cap, refusal, model override)
  - render_fields copy (fits / does-not-fit / no-trade / held)
  - run_brief: market-closed skip, happy path (embed + state + log), dry run,
    and the fail-soft error path
"""
import inspect
import json

import pytest

import live_brief as lb


# ── Fakes ───────────────────────────────────────────────────────────────────

class _FakeBlock:
    def __init__(self, name, data):
        self.type = "tool_use"
        self.name = name
        self.input = data


class _FakeResp:
    def __init__(self, blocks, stop_reason="tool_use"):
        self.content = blocks
        self.stop_reason = stop_reason
        self.usage = None


def _idea(**over):
    base = {
        "symbol": "F", "structure": "long stock", "legs": "buy 3 F @ $11.20 limit",
        "direction": "bullish", "why": "above SMA20, IV low", "getting_paid": "n/a — shares",
        "max_loss_usd": 33.6, "capital_required_usd": 33.6,
        "invalidation": "wrong if F closes below $10.50 before Sep 30",
        "key_risk": "auto tariffs headline", "fits_account": True, "confidence": 3,
    }
    base.update(over)
    return base


class _FakeClient:
    """Answers the focus call with a shortlist and the brief call with `brief`."""

    def __init__(self, brief=None, stop_reason="tool_use", focus=("F", "WMT")):
        self.brief = brief if brief is not None else {
            "market_read": "quiet open, small caps bid",
            "ideas": [_idea()],
            "held": [{"symbol": "WMT", "watch": "$113 GTC sell resting; share is reserved"}],
            "no_trade_reason": "",
        }
        self.stop = stop_reason
        self.focus = list(focus)
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        name = kwargs["tool_choice"]["name"]
        if name == "select_focus":
            return _FakeResp([_FakeBlock("select_focus", {"market_read": "r", "focus": self.focus})])
        return _FakeResp([_FakeBlock("submit_brief", self.brief)], self.stop)


@pytest.fixture
def _wire(monkeypatch, tmp_path):
    """Stub gathering, state path, clock, and Discord for a full run_brief."""
    monkeypatch.setattr(lb, "_state_path", lambda: str(tmp_path / "live_brief_state.json"))
    monkeypatch.setattr(lb, "gather_breadth", lambda mode="live": {
        "account": {"equity": 150.72, "cash": 44.61, "buying_power": 44.61,
                    "options_buying_power": 0.0},
        "positions": [{"symbol": "WMT", "qty": "1", "qty_available": "0",
                       "avg_entry_price": "105.88", "current_price": "106.11",
                       "asset_class": "us_equity"}],
        "universe": {"F": {"price": 11.2, "change_pct": 1.1}, "WMT": {"price": 106.1, "change_pct": 0.2}},
        "equity_floor": 500,
    })
    monkeypatch.setattr(lb, "gather_depth", lambda focus, positions, account, mode="live": {
        "account": account, "positions": positions,
        "market": {s: {"quote": {"ap": 1.0, "bp": 0.9}, "options": {}, "option_count": 0} for s in focus},
        "price_context": {}, "equity_floor": 500,
    })
    monkeypatch.setattr(lb.alpaca_data, "get_orders", lambda status="open", mode="live": [
        {"symbol": "WMT", "side": "sell", "qty": "1", "type": "limit", "limit_price": "113",
         "time_in_force": "gtc", "status": "new", "legs": None},
    ])
    monkeypatch.setattr(lb.alpaca_data, "is_market_open", lambda mode="live": True)
    sent = []
    monkeypatch.setattr(lb, "send_embed", lambda *a, **k: sent.append((a, k)))
    events = []
    monkeypatch.setattr(lb, "log_event", lambda *a, **k: events.append((a, k)))
    # Any attempt to write to Alpaca during a brief is a bug.
    def _no_writes(method, url, **kw):
        if method.upper() != "GET":
            raise AssertionError(f"live_brief issued a {method} to {url}")
        raise RuntimeError("network stubbed")
    monkeypatch.setattr(lb.alpaca_data, "_request_with_retry", _no_writes)
    return {"sent": sent, "events": events, "tmp": tmp_path}


# ── Read-only invariant ─────────────────────────────────────────────────────

def test_module_imports_no_execution_helpers():
    """The brief must not be one refactor away from placing an order."""
    for name in ("place_order", "build_order_payload", "_cancel_order",
                 "check_feasibility", "request_decisions"):
        assert name not in vars(lb), f"live_brief must not import {name}"
    src = inspect.getsource(lb)
    body = src.split('"""', 2)[2]  # skip the module docstring, which names them on purpose
    for name in ("place_order(", "build_order_payload(", "_cancel_order("):
        assert name not in body, f"live_brief source calls {name}"
    assert "requests.post" not in body and "requests.delete" not in body


def test_full_run_never_writes_to_alpaca(_wire):
    out = lb.run_brief(client=_FakeClient())
    assert out["posted"] is True and out["errors"] == 0


# ── Context trimming ────────────────────────────────────────────────────────

def test_trim_open_orders_keeps_commitment_fields():
    raw = [{"id": "x", "symbol": "WMT", "side": "sell", "qty": "1", "type": "limit",
            "limit_price": "113", "time_in_force": "gtc", "status": "new",
            "client_order_id": "noise", "legs": None}]
    out = lb._trim_open_orders(raw)
    assert out == [{"symbol": "WMT", "side": "sell", "qty": "1", "type": "limit",
                    "limit_price": "113", "stop_price": None, "time_in_force": "gtc",
                    "status": "new", "legs": None}]


def test_trim_positions_carries_qty_available_and_underlying():
    out = lb._trim_positions([{"symbol": "WMT260918C00110000", "qty": "-1",
                               "qty_available": "-1", "avg_entry_price": "0.55"}])
    assert out[0]["underlying"] == "WMT"
    assert out[0]["qty_available"] == "-1"


def test_previous_brief_context_none_when_no_state():
    assert lb.previous_brief_context({}) is None
    assert lb.previous_brief_context({"last_brief": "junk"}) is None


def test_previous_brief_context_is_a_trimmed_continuity_feed():
    state = {"last_brief": {"date": "2026-09-09", "market_read": "flat",
                            "ideas": [_idea(symbol="F")], "no_trade_reason": ""}}
    ctx = lb.previous_brief_context(state)
    assert ctx["date"] == "2026-09-09"
    assert ctx["ideas"] == [{"symbol": "F", "structure": "long stock",
                             "invalidation": _idea()["invalidation"], "fits_account": True}]
    assert "not a rule" in ctx["note"]


def test_gather_live_context_shape(_wire):
    client = _FakeClient(focus=("F",))
    ctx = lb.gather_live_context(client=client)
    assert "equity_floor" not in ctx and "equity_floor" not in ctx["account"]
    assert ctx["account"]["options_buying_power"] == 0.0
    assert "REAL MONEY" in ctx["account"]["note"]
    assert ctx["open_orders"][0]["limit_price"] == "113"
    assert ctx["positions"][0]["qty_available"] == "0"
    assert ctx["scan"]["focus"] == ["F"]
    assert ctx["scan"]["universe_scanned"] == 2
    assert "F" in ctx["market"]
    # Focus call ran against the live account's breadth pack.
    assert client.calls[0]["tool_choice"]["name"] == "select_focus"
    assert "equity_floor" not in client.calls[0]["messages"][0]["content"]


def test_gather_live_context_falls_back_to_top_movers_when_focus_fails(_wire, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("focus down")
    monkeypatch.setattr(lb, "request_focus", boom)
    ctx = lb.gather_live_context(client=_FakeClient())
    assert ctx["scan"]["focus"] == ["F", "WMT"]   # |1.1| > |0.2|


def test_gather_live_context_survives_open_orders_failure(_wire, monkeypatch):
    def boom(status="open", mode="live"):
        raise RuntimeError("orders 500")
    monkeypatch.setattr(lb.alpaca_data, "get_orders", boom)
    ctx = lb.gather_live_context(client=_FakeClient())
    assert ctx["open_orders"][0]["unavailable"] is True


# ── request_brief ───────────────────────────────────────────────────────────

def test_request_brief_parses_tool_output_and_wires_forced_tool():
    client = _FakeClient()
    out = lb.request_brief({"account": {}}, client=client)
    assert out["refused"] is False
    assert out["market_read"] == "quiet open, small caps bid"
    assert out["ideas"][0]["symbol"] == "F"
    kw = client.calls[-1]
    assert kw["tool_choice"] == {"type": "tool", "name": "submit_brief"}
    assert kw["thinking"]["type"] == "adaptive"
    assert kw["output_config"]["effort"] == "high"
    assert kw["model"] == "claude-opus-5"
    assert kw["system"] == lb.BRIEF_SYSTEM
    assert "REAL-MONEY" in kw["system"] and "SIZE TO THE ACCOUNT" in kw["system"]


def test_request_brief_caps_ideas_at_three():
    client = _FakeClient(brief={"market_read": "r", "ideas": [_idea(symbol=s) for s in "ABCDE"],
                                "held": [], "no_trade_reason": ""})
    out = lb.request_brief({}, client=client)
    assert [i["symbol"] for i in out["ideas"]] == ["A", "B", "C"]


def test_request_brief_handles_refusal():
    out = lb.request_brief({}, client=_FakeClient(stop_reason="refusal"))
    assert out["refused"] is True and out["ideas"] == []
    assert "refused" in out["market_read"]


def test_brief_model_env_override(monkeypatch):
    monkeypatch.delenv("LIVE_BRIEF_MODEL", raising=False)
    assert lb.brief_model() == "claude-opus-5"
    monkeypatch.setenv("LIVE_BRIEF_MODEL", "claude-sonnet-5")
    assert lb.brief_model() == "claude-sonnet-5"
    client = _FakeClient()
    lb.request_brief({}, client=client)
    assert client.calls[-1]["model"] == "claude-sonnet-5"


# ── render_fields ───────────────────────────────────────────────────────────

_ACCT = {"equity": 150.72, "cash": 44.61, "options_buying_power": 0.0}


def test_render_fields_fitting_idea():
    fields = lb.render_fields({"ideas": [_idea()], "held": []}, _ACCT)
    names = [f["name"] for f in fields]
    assert names[0] == "Account" and "equity $151" in fields[0]["value"]
    assert names[1] == "Idea 1 · F"
    assert "✅ fits account" in fields[1]["value"]
    assert "Max loss $34" in fields[1]["value"]
    assert "Wrong if: wrong if F closes below" in fields[1]["value"]
    assert "No actionable trade today" not in names


def test_render_fields_non_fitting_idea_adds_no_trade_block():
    brief = {"ideas": [_idea(fits_account=False, capital_required_usd=1100)],
             "held": [], "no_trade_reason": "Needs ~$1,100 of options BP; account has $0."}
    fields = lb.render_fields(brief, _ACCT)
    assert "⛔ does not fit — $1,100 needed" in fields[1]["value"]
    nt = [f for f in fields if f["name"] == "No actionable trade today"][0]
    assert "Needs ~$1,100" in nt["value"]


def test_render_fields_empty_ideas_and_held_section():
    brief = {"ideas": [], "held": [{"symbol": "WMT", "watch": "$113 GTC sell resting"}],
             "no_trade_reason": ""}
    fields = lb.render_fields(brief, _ACCT)
    names = [f["name"] for f in fields]
    assert "No actionable trade today" in names
    held = [f for f in fields if f["name"] == "On what you hold"][0]
    assert "**WMT** — $113 GTC sell resting" in held["value"]


# ── run_brief ───────────────────────────────────────────────────────────────

def test_run_brief_skips_when_market_closed(_wire, monkeypatch):
    monkeypatch.setattr(lb.alpaca_data, "is_market_open", lambda mode="live": False)
    client = _FakeClient()
    out = lb.run_brief(client=client)
    assert out["skipped"] == "market_closed" and out["posted"] is False
    assert client.calls == []                       # no model spend
    assert _wire["sent"] == []                      # no Discord
    assert _wire["events"][0][0][2] == "market_closed_skip"


def test_run_brief_posts_embed_persists_state_and_logs(_wire):
    client = _FakeClient()
    out = lb.run_brief(client=client)
    assert out == {"posted": True, "ideas": 1, "fits": 1, "refused": False, "errors": 0}
    # Two model calls: focus (Sonnet) then brief (Opus).
    assert [c["tool_choice"]["name"] for c in client.calls] == ["select_focus", "submit_brief"]
    # Continuity: first run has no previous brief.
    sent_ctx = json.loads(client.calls[1]["messages"][0]["content"].split("\n\n", 1)[1])
    assert sent_ctx["previous_brief"] is None
    # Embed to #live-summary, mirrored to #live-actions, with the read-only footer.
    args, kw = _wire["sent"][0]
    assert args[0] == "live_summary"
    assert kw["title"].startswith("☀️ Live brief — ")
    assert kw["actions_channel"] == "live_actions"
    assert "read-only" in kw["footer"] and "not signals" in kw["footer"]
    assert kw["description"] == "quiet open, small caps bid"
    assert any(f["name"] == "Idea 1 · F" for f in kw["fields"])
    # State persisted for tomorrow's continuity + the dashboard push.
    state = json.loads((_wire["tmp"] / "live_brief_state.json").read_text())
    lbf = state["last_brief"]
    assert lbf["ideas"][0]["symbol"] == "F" and lbf["model"] == "claude-opus-5"
    assert lbf["account"] == {"equity": 150.72, "cash": 44.61, "buying_power": 44.61,
                              "options_buying_power": 0.0}
    assert "note" not in lbf["account"]
    assert lbf["scan"]["focus"] == ["F", "WMT"]
    assert state["_meta"]["runs"] == 1
    # JSONL heartbeat.
    posted = [e for e in _wire["events"] if e[0][2] == "brief_posted"][0]
    assert posted[0][0] == "live" and posted[1]["details"]["ideas"] == 1


def test_run_brief_feeds_yesterdays_brief_back(_wire):
    (_wire["tmp"] / "live_brief_state.json").write_text(json.dumps({
        "last_brief": {"date": "2026-09-09", "market_read": "flat", "ideas": [_idea()],
                       "no_trade_reason": ""},
        "_meta": {"runs": 4},
    }))
    client = _FakeClient()
    lb.run_brief(client=client)
    sent_ctx = json.loads(client.calls[1]["messages"][0]["content"].split("\n\n", 1)[1])
    assert sent_ctx["previous_brief"]["date"] == "2026-09-09"
    assert sent_ctx["previous_brief"]["ideas"][0]["symbol"] == "F"
    state = json.loads((_wire["tmp"] / "live_brief_state.json").read_text())
    assert state["_meta"]["runs"] == 5


def test_run_brief_dry_run_posts_nothing_and_saves_nothing(_wire, capsys):
    out = lb.run_brief(client=_FakeClient(), dry_run=True)
    assert out["posted"] is False and out["ideas"] == 1
    assert _wire["sent"] == [] and _wire["events"] == []
    assert not (_wire["tmp"] / "live_brief_state.json").exists()
    assert '"symbol": "F"' in capsys.readouterr().out


def test_run_brief_fail_soft_posts_to_errors_and_keeps_state(_wire, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("alpaca 503")
    monkeypatch.setattr(lb, "gather_breadth", boom)
    out = lb.run_brief(client=_FakeClient())
    assert out["errors"] == 1 and out["posted"] is False
    args, kw = _wire["sent"][0]
    assert args[0] == "live_errors" and "alpaca 503" in kw["description"]
    assert not (_wire["tmp"] / "live_brief_state.json").exists()
    assert any(e[0][2] == "brief_failed" for e in _wire["events"])


def test_run_brief_refusal_is_not_an_error(_wire):
    out = lb.run_brief(client=_FakeClient(stop_reason="refusal"))
    assert out["refused"] is True and out["errors"] == 0 and out["posted"] is True
