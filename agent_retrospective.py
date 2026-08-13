"""Weekly retrospective for the autonomous agent account — the education digest.

Reads the committed lesson records (agent_state.json → "closed") over a window,
computes calibration stats deterministically, and asks Claude to write a
plain-English "what we learned this week": what worked, recurring blind spots,
whether the agent's stated confidence actually tracked results, exit-quality
patterns, and one thing to watch next week.

Surface-agnostic: prints the digest to stdout (so it can be read through a chat
session, committed, or rendered as an Artifact) and optionally posts it to the
#agent-summary Discord channel. No dashboard required.

Run on demand:   python agent_retrospective.py [--days N] [--post]
"""
import json
import statistics

import agent_config
import agent_trader
from notifications import send_text

_CFG = agent_config.get()


# ── Deterministic stats (pure, testable) ───────────────────────────────────

def _pnl(lesson: dict):
    v = (lesson.get("outcome") or {}).get("estimated_pnl")
    return v if isinstance(v, (int, float)) else None


def compute_stats(lessons: list) -> dict:
    """Win/loss counts, avg-win/avg-loss ratio, grade + loss-type distributions,
    and confidence calibration. Pure — no I/O."""
    wins = [p for p in (_pnl(l) for l in lessons) if p is not None and p > 0]
    losses = [-p for p in (_pnl(l) for l in lessons) if p is not None and p < 0]
    avg_win = round(statistics.fmean(wins), 2) if wins else None
    avg_loss = round(statistics.fmean(losses), 2) if losses else None
    win_loss_ratio = round(avg_win / avg_loss, 2) if (avg_win and avg_loss) else None

    def _dist(key_fn):
        d: dict = {}
        for l in lessons:
            k = key_fn(l)
            if k is not None:
                d[k] = d.get(k, 0) + 1
        return d

    # Confidence calibration: for each 1–5 confidence bucket, the win rate.
    calib: dict = {}
    for l in lessons:
        conf = ((l.get("thesis") or {}).get("confidence"))
        p = _pnl(l)
        if conf is None or p is None:
            continue
        b = calib.setdefault(conf, {"n": 0, "wins": 0})
        b["n"] += 1
        if p > 0:
            b["wins"] += 1
    for conf, b in calib.items():
        b["win_rate"] = round(b["wins"] / b["n"], 2) if b["n"] else None

    graded = [l for l in lessons if (l.get("grade") or {}).get("graded")]
    return {
        "trades": len(lessons),
        "graded": len(graded),
        "wins": len(wins),
        "losses": len(losses),
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "win_loss_ratio": win_loss_ratio,
        "process_grades": _dist(lambda l: (l.get("grade") or {}).get("process_grade")),
        "outcome_grades": _dist(lambda l: (l.get("grade") or {}).get("outcome_grade")),
        "loss_types": _dist(lambda l: (l.get("grade") or {}).get("loss_type")),
        "confidence_calibration": calib,
    }


def recent_lessons(state: dict, window_days: int) -> list:
    """Closed-trade lessons whose closed_at falls within the window."""
    out = []
    for l in state.get("closed", []):
        age = agent_trader._days_since(l.get("closed_at"))
        if age is None or age <= window_days:
            out.append(l)
    return out


RETRO_SYSTEM = """\
You are a trading coach writing a short weekly retrospective for a trader whose \
autonomous strategy you are helping improve. You are given this week's closed \
trades — each with the thesis written at entry, the outcome, and a hindsight \
grade (process vs outcome, and whether losses were anticipated risks or \
blind spots) — plus deterministic summary stats.

Write a concise, plain-English digest (a few short paragraphs, no jargon) that \
covers: what actually worked and why; recurring BLIND SPOTS (losses for reasons \
the theses never named — these matter most); whether the agent's stated \
confidence tracked its results (did the 4-5s beat the 1-2s?); any pattern in \
exit timing; and ONE concrete thing to watch or change next week. Judge the \
decision process, not just the P&L. Be honest and specific; this is to get \
smarter, not to feel good.\
"""


def synthesize(lessons: list, stats: dict, client=None, model: str | None = None) -> str:
    """Ask Claude for the plain-English digest. Falls back to a stats-only
    summary if the model is unavailable."""
    if not lessons:
        return "No closed trades in the window yet — nothing to review."
    try:
        if client is None:  # pragma: no cover — real client path, mocked in tests
            import anthropic
            client = anthropic.Anthropic()
        model = model or agent_config.grader_model()
        payload = {"stats": stats, "trades": [
            {"thesis": l.get("thesis"), "outcome": l.get("outcome"),
             "grade": l.get("grade")} for l in lessons
        ]}
        resp = client.messages.create(
            model=model,
            max_tokens=_CFG["max_retro_tokens"],
            thinking={"type": "adaptive"},
            system=RETRO_SYSTEM,
            messages=[{"role": "user", "content":
                       "Write this week's retrospective.\n\n" + json.dumps(payload, default=str)}],
        )
        if getattr(resp, "stop_reason", None) == "refusal":
            return _fallback_summary(stats)
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        return text.strip() or _fallback_summary(stats)
    except Exception:  # noqa: BLE001
        return _fallback_summary(stats)


def _fallback_summary(stats: dict) -> str:
    return (
        f"Retrospective (stats only — model unavailable):\n"
        f"- Trades: {stats['trades']} ({stats['graded']} graded)\n"
        f"- Wins/Losses: {stats['wins']}/{stats['losses']}\n"
        f"- Avg win / avg loss: {stats['avg_win']} / {stats['avg_loss']} "
        f"(ratio {stats['win_loss_ratio']})\n"
        f"- Loss types: {stats['loss_types']}\n"
        f"- Process grades: {stats['process_grades']}\n"
        f"- Confidence calibration: {stats['confidence_calibration']}"
    )


def run(window_days: int | None = None, post: bool = False, client=None) -> str:
    window_days = window_days if window_days is not None else _CFG["retro_window_days"]
    state = agent_trader.load_state()
    lessons = recent_lessons(state, window_days)
    stats = compute_stats(lessons)
    digest = synthesize(lessons, stats, client=client)
    body = f"📚 **Agent retrospective — last {window_days}d**\n\n{digest}"
    print(body)
    if post:
        # Discord messages cap at 2000 chars; trim defensively.
        send_text(_CFG["summary_channel"], body[:1990],
                  actions_channel=_CFG["actions_channel"])
    return body


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    days = None
    if "--days" in args:
        try:
            days = int(args[args.index("--days") + 1])
        except (ValueError, IndexError):
            days = None
    run(window_days=days, post=("--post" in args))
