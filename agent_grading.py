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
        "Record the hindsight grade for a closed trade. Grade the PROCESS — the "
        "soundness of BOTH the entry and the exit decision, given only what was "
        "knowable — separately from the OUTCOME (did it make money). A correct "
        "exit on a broken thesis is sound process even at a loss."
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
                    "Classify by the RISK, not the exit timing. win = made money; "
                    "anticipated = lost via a risk the thesis NAMED (even if exited "
                    "early); blind_spot = lost for a reason the thesis never "
                    "mentioned; breakeven = flat."
                ),
            },
            "exit_quality": {
                "type": "string",
                "enum": ["good", "early", "late", "panic", "unclear"],
                "description": (
                    "How well the EXIT went (separate from whether closing was the "
                    "right call). good = sound decision, cleanly executed near the "
                    "mid / at a sensible level; early = exited while the thesis AND "
                    "its stated invalidation were both still intact (premature — "
                    "nothing had actually changed); late = held past the point the "
                    "thesis broke, letting the loss compound; panic = the decision "
                    "to exit may have been right, but it was dumped through a wide "
                    "bid/ask, realizing far worse than the mid; unclear."
                ),
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
existed), the reason the trader gave for CLOSING it (close_rationale), and its \
OUTCOME.

Grade two things separately and honestly:
- outcome_grade: did it make money? (the easy part)
- process_grade: was the DECISION-MAKING sound given only what was knowable — \
covering BOTH the decision to enter AND the decision to exit? A well-reasoned \
trade that lost to variance can still earn a high process grade; a sloppy trade \
that got lucky should not.

Judging the EXIT is central, since the trader chose it — and use close_rationale \
to judge it FAIRLY, not just from the P&L:
- Exiting because the THESIS GENUINELY CHANGED — the reason the trade was taken \
no longer holds — is a SOUND decision, even when it books a loss. Do NOT \
penalize the process for correctly abandoning a broken thesis; cutting a trade \
you no longer believe in is discipline, not a mistake, and the alternative \
(holding a dead thesis to avoid booking the loss) is worse.
- Exiting on MARK NOISE — a scary unrealized P&L from IV, theta, or a wide \
bid/ask — while the thesis AND its stated invalidation were both still intact is \
PREMATURE, and THAT is the process error.
- Judge the exit's EXECUTION separately (exit_quality): a clean fill near the \
mid is 'good'; dumping through a wide bid/ask and realizing far worse than the \
mid is 'panic'. A correct exit decision executed badly should teach "exit more \
cleanly," NOT "hold longer."

Classify the loss (loss_type) by the RISK, not the timing: a loser that lost via \
the exact key_risk the thesis NAMED is 'anticipated' (well-understood) EVEN IF \
it was exited early; only a loss for a reason the thesis never mentioned is \
'blind_spot'. Check whether the thesis's own stated invalidation actually fired. \
Finish with one plain-English sentence of what this trade teaches — aimed at the \
REAL error (entry choice, exit decision, or exit execution), not a generic one.

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
            # The agent's own reason for exiting — surfaced top-level so the grader
            # judges the exit DECISION fairly (thesis change vs mark-noise panic),
            # not just that the position closed at a loss. None if it wasn't a
            # bot-placed close (e.g. expiry/assignment).
            "close_rationale": (record.get("close_rationale")
                                or outcome.get("close_rationale")),
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
