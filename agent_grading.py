"""Hindsight grading for the autonomous agent account — the education layer.

When the agent closes a position, we grade the *decision* independently of the
*outcome*, using the falsifiable thesis captured at entry. A trade can lose and
still be a good decision (variance), or win and be a bad one (luck) — only
grading P&L teaches the wrong lessons. The distinction that actually teaches:
did a loser lose for a risk the thesis NAMED (anticipated — a well-reasoned
loss) or one it never saw (blind-spot — the trades we learn most from)?

The grade is written into a lesson record in agent_state.json (committed to the
repo by the workflow), so it's surface-agnostic: readable through a written
retrospective, an Artifact, a Discord embed, or a future dashboard — no
presentation layer required for the data to exist.

Grading runs on a cheaper model than the trade decision (Sonnet by default; see
agent_config.grader_model). A safety refusal yields a neutral "ungraded" record
rather than an error.
"""
import json

import agent_config

_CFG = agent_config.get()

_GRADES = ["A", "B", "C", "D", "F"]

GRADE_TOOL = {
    "name": "record_grade",
    "description": (
        "Record the hindsight grade for a closed trade. Grade the PROCESS "
        "(was the decision sound given only what was knowable at entry) "
        "separately from the OUTCOME (did it make money)."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "outcome_grade": {"type": "string", "enum": _GRADES},
            "process_grade": {"type": "string", "enum": _GRADES},
            "invalidation_fired": {
                "type": "string", "enum": ["yes", "no", "unclear"],
                "description": "Did the entry thesis's own named invalidation condition trigger?",
            },
            "loss_type": {
                "type": "string",
                "enum": ["win", "anticipated", "blind_spot", "breakeven"],
                "description": (
                    "win = made money; anticipated = lost via the key_risk it named; "
                    "blind_spot = lost for a reason it never saw; breakeven = flat."
                ),
            },
            "exit_quality": {
                "type": "string",
                "enum": ["good", "early", "late", "panic", "unclear"],
                "description": "Since the agent chose its own exit, how well did it exit?",
            },
            "lesson": {
                "type": "string",
                "description": "One plain-English sentence: what this trade teaches.",
            },
        },
        "required": ["outcome_grade", "process_grade", "invalidation_fired",
                     "loss_type", "exit_quality", "lesson"],
    },
}


GRADER_SYSTEM = """\
You are a trading coach grading a single closed paper trade to help the trader \
learn. You are given the trade's ENTRY THESIS (written before the outcome \
existed) and its OUTCOME.

Grade two things separately and honestly:
- outcome_grade: did it make money? (the easy part)
- process_grade: was the decision SOUND GIVEN ONLY WHAT WAS KNOWABLE AT ENTRY, \
ignoring how it turned out? A well-reasoned trade that lost to variance can \
still earn a high process grade; a sloppy trade that got lucky should not.

Then classify the loss (loss_type): a loser that lost via the exact key_risk \
the thesis named is 'anticipated' (acceptable, well-understood); a loser that \
lost for a reason the thesis never mentioned is 'blind_spot' (the valuable \
lesson). Check whether the thesis's own stated invalidation condition actually \
fired. Judge the exit, since the trader chose it. Finish with one plain-English \
sentence of what this trade teaches.

Be specific and fair. The goal is learning, not flattery. Call record_grade once.\
"""


def grade_position(record: dict, outcome: dict, client=None, model: str | None = None) -> dict:
    """Grade one closed position. Returns the grade dict (never raises).

    record  — the stored position: legs, thesis, opened_at, entry_context.
    outcome — best-effort close data: pnl estimate, price moves, days held, close reason.
    """
    grade = _default_grade()
    try:
        if client is None:  # pragma: no cover — real client path, mocked in tests
            client = agent_config.client()
        model = model or agent_config.grader_model()

        payload = {
            "entry_thesis": record.get("thesis"),
            "legs": record.get("legs"),
            "opened_at": record.get("opened_at"),
            "entry_context": record.get("entry_context"),
            "outcome": outcome,
        }
        resp = client.messages.create(
            model=model,
            max_tokens=_CFG["max_grade_tokens"],
            thinking={"type": "adaptive"},
            system=GRADER_SYSTEM,
            tools=[GRADE_TOOL],
            tool_choice={"type": "tool", "name": "record_grade"},
            messages=[{"role": "user", "content":
                       "Grade this closed trade.\n\n" + json.dumps(payload, default=str)}],
        )
        if getattr(resp, "stop_reason", None) == "refusal":
            return grade  # neutral ungraded record
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use" and block.name == "record_grade":
                grade = dict(block.input)
                grade["graded"] = True
                return grade
    except Exception:  # noqa: BLE001 — grading must never break the trading cycle
        return grade
    return grade


def _default_grade() -> dict:
    """Neutral record used when grading is unavailable (refusal, API error).
    Keeps the lesson pipeline intact without fabricating a judgment."""
    return {
        "outcome_grade": None,
        "process_grade": None,
        "invalidation_fired": "unclear",
        "loss_type": "breakeven",
        "exit_quality": "unclear",
        "lesson": "(not graded)",
        "graded": False,
    }
