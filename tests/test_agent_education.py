"""Tests for the agent education layer: close detection, hindsight grading,
and the weekly retrospective. Claude is mocked throughout — no real API calls.
"""
from datetime import datetime, timedelta, timezone

import pytest

import agent_trader as at
import agent_grading
import agent_retrospective as retro


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _now():
    return _iso(datetime.now(timezone.utc))


def _days_ago(n):
    return _iso(datetime.now(timezone.utc) - timedelta(days=n))


# ── Mocked Anthropic clients ────────────────────────────────────────────────

class _ToolBlock:
    def __init__(self, name, data):
        self.type = "tool_use"
        self.name = name
        self.input = data


class _TextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _Resp:
    def __init__(self, content, stop_reason="tool_use"):
        self.content = content
        self.stop_reason = stop_reason


class _GradeClient:
    def __init__(self, grade, stop_reason="tool_use"):
        self._grade, self._stop = grade, stop_reason
        self.messages = self

    def create(self, **kw):
        return _Resp([_ToolBlock("record_grade", self._grade)], self._stop)


class _TextClient:
    def __init__(self, text, stop_reason="end_turn"):
        self._text, self._stop = text, stop_reason
        self.messages = self

    def create(self, **kw):
        return _Resp([_TextBlock(self._text)], self._stop)


_GRADE = {
    "outcome_grade": "B", "process_grade": "A", "invalidation_fired": "no",
    "loss_type": "win", "exit_quality": "good", "lesson": "Patience paid off.",
}


# ── grade_position ──────────────────────────────────────────────────────────

def test_grade_position_parses_tool_output():
    g = agent_grading.grade_position({"thesis": {}}, {"estimated_pnl": 40},
                                     client=_GradeClient(_GRADE))
    assert g["process_grade"] == "A" and g["graded"] is True


def test_grade_position_refusal_returns_default_ungraded():
    g = agent_grading.grade_position({}, {}, client=_GradeClient(_GRADE, "refusal"))
    assert g["graded"] is False and g["lesson"] == "(not graded)"


def test_grade_position_never_raises_on_client_error():
    class _Boom:
        messages = property(lambda self: (_ for _ in ()).throw(RuntimeError))
    g = agent_grading.grade_position({}, {}, client=_Boom())
    assert g["graded"] is False


# ── reconcile / snapshot / outcome (pure) ───────────────────────────────────

def test_reconcile_splits_open_vs_absent():
    tracked = {
        "A": {"legs": [{"symbol": "AAPL"}]},
        "B": {"legs": [{"symbol": "MSFT260320C00400000"}]},
    }
    alpaca = [{"symbol": "AAPL"}]
    still_open, absent = at.reconcile_positions(tracked, alpaca)
    assert still_open == ["A"] and absent == ["B"]


def test_snapshot_sums_pnl_across_held_legs():
    pos = {"legs": [{"symbol": "X"}, {"symbol": "Y"}]}
    alpaca = [
        {"symbol": "X", "unrealized_pl": "10", "market_value": "100", "cost_basis": "90"},
        {"symbol": "Y", "unrealized_pl": "-4", "market_value": "50", "cost_basis": "54"},
    ]
    snap = at.snapshot_position(pos, alpaca)
    assert snap["unrealized_pl"] == 6.0 and "seen_at" in snap


def test_snapshot_empty_when_no_legs_held():
    assert at.snapshot_position({"legs": [{"symbol": "Z"}]}, []) == {}


def test_build_outcome_computes_underlying_move_and_days():
    pos = {
        "opened_at": _days_ago(3),
        "legs": [{"symbol": "AAPL260320P00150000"}],
        "entry_context": {"underlyings": {"AAPL": 155.0}},
        "last_snapshot": {"unrealized_pl": 25.0},
    }
    market = {"AAPL": {"quote": {"p": 160.0}}}
    out = at.build_outcome(pos, market)
    assert out["estimated_pnl"] == 25.0
    assert out["underlying_moves"]["AAPL"]["pct"] == pytest.approx(3.23, abs=0.02)
    assert 2.5 < out["days_held"] < 3.5


# ── _reconcile_and_grade integration ────────────────────────────────────────

@pytest.fixture
def _quiet(monkeypatch):
    monkeypatch.setattr(at, "send_embed", lambda *a, **k: None)
    monkeypatch.setattr(at, "log_event", lambda *a, **k: None)


def test_genuine_close_is_graded_and_moved_to_closed(_quiet):
    state = {"positions": {
        "O1": {"opened_at": _days_ago(2),
               "legs": [{"symbol": "AAPL", "side": "buy", "qty": 1}],
               "thesis": {"confidence": 4},
               "last_snapshot": {"unrealized_pl": 30.0}},
    }, "closed": []}
    summary = {"closed": 0, "graded": 0}
    at._reconcile_and_grade(state, alpaca_positions=[], market={},
                            client=_GradeClient(_GRADE), summary=summary)
    assert "O1" not in state["positions"]
    assert len(state["closed"]) == 1
    assert state["closed"][0]["grade"]["process_grade"] == "A"
    assert summary["graded"] == 1 and summary["closed"] == 1


def test_freshly_opened_absent_is_not_graded(_quiet):
    """A position opened this cycle isn't visible on Alpaca yet — don't mistake
    that for a close."""
    state = {"positions": {
        "O2": {"opened_at": _now(), "legs": [{"symbol": "AAPL"}],
               "thesis": {}, "last_snapshot": None},
    }, "closed": []}
    summary = {"closed": 0, "graded": 0}
    at._reconcile_and_grade(state, alpaca_positions=[], market={},
                            client=_GradeClient(_GRADE), summary=summary)
    assert "O2" in state["positions"] and summary["graded"] == 0


def test_stale_unfilled_is_dropped_not_graded(_quiet):
    state = {"positions": {
        "O3": {"opened_at": _days_ago(3), "legs": [{"symbol": "AAPL"}],
               "thesis": {}, "last_snapshot": None},
    }, "closed": []}
    summary = {"closed": 0, "graded": 0}
    at._reconcile_and_grade(state, alpaca_positions=[], market={},
                            client=_GradeClient(_GRADE), summary=summary)
    assert "O3" not in state["positions"]
    assert state["closed"] == [] and summary["graded"] == 0


def test_still_open_gets_snapshot(_quiet):
    state = {"positions": {
        "O4": {"opened_at": _now(), "legs": [{"symbol": "AAPL"}],
               "thesis": {}, "last_snapshot": None},
    }, "closed": []}
    alpaca = [{"symbol": "AAPL", "unrealized_pl": "12", "market_value": "112",
               "cost_basis": "100"}]
    at._reconcile_and_grade(state, alpaca_positions=alpaca,
                            market={"AAPL": {"quote": {"p": 150}}},
                            client=_GradeClient(_GRADE),
                            summary={"closed": 0, "graded": 0})
    assert state["positions"]["O4"]["last_snapshot"]["unrealized_pl"] == 12.0


# ── Retrospective stats + synthesis ─────────────────────────────────────────

def _lesson(pnl, conf, process="A", loss_type="win"):
    return {
        "closed_at": _now(),
        "thesis": {"confidence": conf},
        "outcome": {"estimated_pnl": pnl},
        "grade": {"process_grade": process, "outcome_grade": "B",
                  "loss_type": loss_type, "graded": True},
    }


def test_compute_stats_ratio_and_calibration():
    lessons = [
        _lesson(100, 5), _lesson(60, 4),          # wins
        _lesson(-40, 2, "C", "anticipated"),      # loss
        _lesson(-20, 1, "D", "blind_spot"),       # loss
    ]
    s = retro.compute_stats(lessons)
    assert s["wins"] == 2 and s["losses"] == 2
    assert s["avg_win"] == 80.0 and s["avg_loss"] == 30.0
    assert s["win_loss_ratio"] == pytest.approx(2.67, abs=0.01)
    assert s["loss_types"] == {"win": 2, "anticipated": 1, "blind_spot": 1}
    # High-confidence buckets won; low-confidence lost.
    assert s["confidence_calibration"][5]["win_rate"] == 1.0
    assert s["confidence_calibration"][1]["win_rate"] == 0.0


def test_recent_lessons_window_filter():
    state = {"closed": [
        {"closed_at": _now()},
        {"closed_at": _days_ago(3)},
        {"closed_at": _days_ago(30)},
    ]}
    assert len(retro.recent_lessons(state, window_days=7)) == 2


def test_synthesize_uses_model_text():
    lessons = [_lesson(100, 5)]
    out = retro.synthesize(lessons, retro.compute_stats(lessons),
                           client=_TextClient("Great week. Watch your exits."))
    assert "Watch your exits" in out


def test_synthesize_empty_lessons():
    assert "nothing to review" in retro.synthesize([], retro.compute_stats([]))


def test_synthesize_falls_back_on_refusal():
    lessons = [_lesson(100, 5)]
    out = retro.synthesize(lessons, retro.compute_stats(lessons),
                           client=_TextClient("x", stop_reason="refusal"))
    assert "stats only" in out
