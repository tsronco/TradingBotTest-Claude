"""Live-account morning brief — Claude reads the market and SUGGESTS, never acts.

Once per trading day (9:40 ET, ten minutes after the open so quotes and option
chains are live rather than yesterday's close), this script:

  1. Reads the REAL-MONEY live account: equity, cash, options buying power,
     positions, and open orders (so it knows which shares are already committed
     to a resting order — e.g. a GTC sell holding the only share).
  2. Runs the agent's two-phase scan against the live account: a quotes-only
     look at the whole ~250-name universe, a cheap Sonnet call to shortlist a
     dozen names, then full option chains for only that shortlist + everything
     held.
  3. Asks the brief model (Opus by default) for a read-only brief: a two-sentence
     market read, up to three ideas SIZED TO THE ACCOUNT'S ACTUAL BUYING POWER
     (structure, legs, max loss in dollars, invalidation), and a "what to watch"
     line for each held position. If nothing fits the account, it says so and
     describes what it would want if the account were funded.
  4. Posts one embed to #live-summary, persists the brief to
     live_brief_state.json (committed + pushed to the dashboard as
     `bot:live:brief` so the Home card can show it), and logs to logs/live.jsonl.

READ-ONLY BY CONSTRUCTION. This module imports only the agent harness's
*gathering* helpers — it never imports place_order / build_order_payload /
_cancel_order, never calls any Alpaca write endpoint, and has no execution
branch to reach. The user places every trade by hand. A test asserts the
no-order invariant (see tests/test_live_brief.py).

The brief is a prompt for the user's own judgment, not a signal — the same model
running autonomously on paper lost money before its raw-record feedback loop was
added. The embed footer says so every day.

Fail-soft: any unexpected error posts to #live-errors and exits without touching
the state file. Market-closed days (holidays) skip silently with a heartbeat: no
model call, no Discord.
"""
import json
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

import agent_config
import alpaca_data
import config as bot_config
# Gathering helpers only — deliberately NOT place_order / build_order_payload /
# _cancel_order. If a future edit imports any of those here, the invariant test
# in tests/test_live_brief.py fails.
from agent_trader import (
    _fallback_focus,
    _occ_underlying,
    call_with_retry,
    gather_breadth,
    gather_depth,
    log_model_usage,
    request_focus,
)
from notifications import send_embed, log_event, Color

load_dotenv()

MODE = "live"
_LIVE = bot_config.MODES[MODE]
ET = ZoneInfo("America/New_York")

DEFAULT_BRIEF_MODEL = "claude-opus-5"

BRIEF_CONFIG = {
    "state_file": "live_brief_state.json",
    "summary_channel": _LIVE["summary_channel"],   # live_summary
    "errors_channel":  _LIVE["errors_channel"],    # live_errors
    "actions_channel": _LIVE["actions_channel"],   # live_actions
    "log_stream":      _LIVE["log_stream"],        # live → logs/live.jsonl
    # Opus by default (the brief IS the product, one call a day). Override with
    # LIVE_BRIEF_MODEL=claude-sonnet-5 to cut cost ~5x if the briefs are mostly
    # "nothing fits" — no code change needed.
    "model_env": "LIVE_BRIEF_MODEL",
    "max_brief_tokens": 4096,
    "brief_effort": "high",
    "max_ideas": 3,
    # Outer retry around the brief call (on top of the SDK's own backoff).
    "brief_retries": 3,
    "brief_retry_backoff_seconds": 20,
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] live_brief: {msg}", flush=True)


def brief_model() -> str:
    return os.getenv(BRIEF_CONFIG["model_env"]) or DEFAULT_BRIEF_MODEL


# ── State (yesterday's brief → today's continuity) ─────────────────────────

def _state_path() -> str:
    return os.path.join(os.path.dirname(__file__), BRIEF_CONFIG["state_file"])


def load_state() -> dict:
    path = _state_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state: dict) -> None:
    with open(_state_path(), "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)


# ── Context (read-only) ────────────────────────────────────────────────────

def _trim_open_orders(orders: list) -> list:
    """The fields that matter for 'what is already committed'. A resting GTC
    sell on the only share held means that share is not free to trade around
    — the model must see it or it will suggest selling what's already offered."""
    out = []
    for o in orders or []:
        legs = o.get("legs") or []
        out.append({
            "symbol": o.get("symbol"),
            "side": o.get("side"),
            "qty": o.get("qty"),
            "type": o.get("type") or o.get("order_type"),
            "limit_price": o.get("limit_price"),
            "stop_price": o.get("stop_price"),
            "time_in_force": o.get("time_in_force"),
            "status": o.get("status"),
            "legs": [{"symbol": l.get("symbol"), "side": l.get("side"), "qty": l.get("qty")}
                     for l in legs] or None,
        })
    return out


def _trim_positions(positions: list) -> list:
    """Position fields the brief needs. `qty_available` is what the bot's
    trail/stop logic manages; `qty` − `qty_available` is reserved by an open
    order or options collateral (the WMT lesson of 2026-09-08)."""
    out = []
    for p in positions or []:
        out.append({
            "symbol": p.get("symbol"),
            "underlying": _occ_underlying(p.get("symbol", "")),
            "asset_class": p.get("asset_class"),
            "qty": p.get("qty"),
            "qty_available": p.get("qty_available"),
            "avg_entry_price": p.get("avg_entry_price"),
            "current_price": p.get("current_price"),
            "market_value": p.get("market_value"),
            "unrealized_pl": p.get("unrealized_pl"),
            "unrealized_plpc": p.get("unrealized_plpc"),
            "fair_value": p.get("fair_value"),   # set by gather_depth's annotation on option legs
        })
    return out


def previous_brief_context(state: dict) -> dict | None:
    """Yesterday's brief, handed back so today's doesn't silently contradict it.
    Framed to the model as continuity, not a rule."""
    last = state.get("last_brief")
    if not isinstance(last, dict):
        return None
    return {
        "date": last.get("date"),
        "market_read": last.get("market_read"),
        "ideas": [
            {"symbol": i.get("symbol"), "structure": i.get("structure"),
             "invalidation": i.get("invalidation"), "fits_account": i.get("fits_account")}
            for i in (last.get("ideas") or [])
        ],
        "no_trade_reason": last.get("no_trade_reason"),
        "note": ("Your brief from the previous trading day. Continuity, not a rule: "
                 "you may change your mind, but say why rather than contradicting "
                 "yourself silently."),
    }


def gather_live_context(client=None) -> dict:
    """Two-phase scan against the LIVE account + the account facts the brief must
    size to. Returns the context dict handed to the brief model, plus scan stats."""
    breadth = gather_breadth(mode=MODE)
    # gather_breadth carries the AGENT's equity floor; irrelevant for a brief and
    # actively misleading on a small live account ("opens are blocked").
    breadth.pop("equity_floor", None)
    try:
        focus_res = request_focus(breadth, client=client)
    except Exception as e:  # noqa: BLE001 — focus is not worth killing the brief
        log(f"focus step failed, falling back to top movers: {e}")
        focus_res = {"focus": [], "market_read": f"(focus step failed: {e})", "refused": False}
    focus = focus_res.get("focus") or _fallback_focus(breadth)

    depth = gather_depth(focus, breadth["positions"], breadth["account"], mode=MODE)
    depth.pop("equity_floor", None)

    try:
        open_orders = _trim_open_orders(alpaca_data.get_orders(status="open", mode=MODE))
    except Exception as e:  # noqa: BLE001 — best-effort; the model is told when missing
        log(f"open orders unavailable: {e}")
        open_orders = [{"unavailable": True, "note": f"open orders could not be fetched ({type(e).__name__})"}]

    account = dict(breadth["account"])
    context = {
        "as_of": datetime.now(ET).strftime("%Y-%m-%d %H:%M ET"),
        "account": {
            **account,
            "note": ("REAL MONEY. Size every idea to options_buying_power (for option "
                     "structures) or cash (for shares). An idea that needs more than "
                     "the account has is NOT actionable — mark fits_account=false and "
                     "say what it would take."),
        },
        "positions": _trim_positions(depth["positions"]),
        "open_orders": open_orders,
        "market": depth["market"],
        "price_context": depth.get("price_context", {}),
        "scan": {
            "universe_scanned": len(breadth.get("universe") or {}),
            "focus": focus,
            "focus_read": focus_res.get("market_read", ""),
        },
    }
    return context


# ── The brief tool (structured output via forced tool use) ─────────────────

BRIEF_TOOL = {
    "name": "submit_brief",
    "description": (
        "Submit today's read-only morning brief for the live account. Ideas are "
        "suggestions for a human to consider — nothing here is executed."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "market_read": {
                "type": "string",
                "description": "Two or three sentences: what the tape is doing this morning and what matters for this account today.",
            },
            "ideas": {
                "type": "array",
                "description": "Up to three ideas, best first. Each must be sized to the account's real buying power; if none fit, return an empty list and fill no_trade_reason.",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "symbol": {"type": "string"},
                        "structure": {"type": "string", "description": "e.g. 'long stock', 'cash-secured put', 'put credit spread', 'long call'."},
                        "legs": {"type": "string", "description": "Exact legs: side, qty, OCC symbol or share count, strikes, expiry, and the limit you'd use."},
                        "direction": {"type": "string", "enum": ["bullish", "bearish", "neutral"]},
                        "why": {"type": "string", "description": "The thesis in two sentences, referencing the data (trend, IV, earnings, level)."},
                        "getting_paid": {"type": "string", "description": "The math: credit/debit per share, ×100, yield on collateral or expected move."},
                        "max_loss_usd": {"type": "number", "description": "Dollar max loss of the structure as specified."},
                        "capital_required_usd": {"type": "number", "description": "Cash or options buying power the account must have to place it."},
                        "invalidation": {"type": "string", "description": "Concrete, checkable: 'wrong if X closes below $Y before <date>'."},
                        "key_risk": {"type": "string"},
                        "fits_account": {"type": "boolean", "description": "True only if capital_required_usd <= the account's actual buying power for that asset class right now."},
                        "confidence": {"type": "integer", "description": "1 (low) to 5 (high). Strict tool schemas reject minimum/maximum, so the range lives here."},
                    },
                    "required": ["symbol", "structure", "legs", "direction", "why", "getting_paid",
                                 "max_loss_usd", "capital_required_usd", "invalidation", "key_risk",
                                 "fits_account", "confidence"],
                },
            },
            "held": {
                "type": "array",
                "description": "One entry per held underlying: what to watch today, and whether any resting order changes the picture.",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "symbol": {"type": "string"},
                        "watch": {"type": "string"},
                    },
                    "required": ["symbol", "watch"],
                },
            },
            "no_trade_reason": {
                "type": "string",
                "description": "When ideas is empty or nothing fits: why, in one or two sentences, and what you'd want to do if the account were funded (with a rough dollar figure).",
            },
        },
        "required": ["market_read", "ideas", "held", "no_trade_reason"],
    },
}


BRIEF_SYSTEM = """\
You are writing a once-a-day morning brief for a REAL-MONEY brokerage account \
that a human trades by hand. You are an advisor here, not a trader: nothing you \
write is executed. The human reads your brief, decides, and places any order \
themselves. Be useful, specific, and honest; never pad.

What you're given: the live account (equity, cash, buying power, options buying \
power), every position (with qty_available — shares Alpaca has NOT reserved), \
every open order, live quotes and today's move for a wide universe you already \
shortlisted from, full near-dated option chains (greeks, IV) for the shortlist \
plus everything held, trend/earnings context per name, and yesterday's brief \
for continuity.

Rules of the brief (mechanical, not editorial):
- SIZE TO THE ACCOUNT. Every idea must state capital_required_usd and \
max_loss_usd, and fits_account must be true only if the account can actually \
place it right now (options structures draw on options_buying_power; shares \
draw on cash). A cash-secured put needs strike × 100 in options buying power; a \
credit spread needs the width × 100 minus credit; shares need price × qty in \
cash. If the account is small, most ideas will not fit — say so plainly in \
no_trade_reason and describe what you'd want to do if it were funded, with a \
rough dollar figure. A brief that says "nothing fits today" is a good brief; an \
idea the account cannot place is not.
- Respect what's already committed. If a held share is reserved by a resting \
order (qty_available < qty), do not suggest selling or writing calls against \
it; note the resting order in `held` instead.
- Options are per share (×100 per contract). Use real OCC symbols from the \
chains provided. Shares trade whole. This account may or may not have options \
approval — if you suggest an options structure, say which approval level it \
needs so the human can check.
- Read option prices from the chain mid, not a worst-case corner; on a wide, \
illiquid quote say the fill is uncertain. Prefer liquid names.
- Note earnings inside the holding window; a defined-risk structure through \
earnings is a different trade than one that expires before.
- Every idea needs a concrete, checkable invalidation ("wrong if X closes below \
$Y before <date>") and its single biggest risk.
- Keep it short. Two or three sentences of market read, up to three ideas, one \
line per held name. This lands in a phone notification.

Continuity: yesterday's brief is included. You may change your mind, but say \
why; do not contradict it silently.

Call submit_brief once.\
"""


def request_brief(context: dict, client=None, model: str | None = None) -> dict:
    """Ask the brief model for today's brief. Returns the tool input as a dict
    with `refused` added. A safety refusal returns an empty brief, never an error."""
    if client is None:  # pragma: no cover — real client path, mocked in tests
        client = agent_config.client()
    model = model or brief_model()
    user_content = (
        "Write this morning's brief for the live account from the data below.\n\n"
        + json.dumps(context, default=str)
    )
    resp = client.messages.create(
        model=model,
        max_tokens=BRIEF_CONFIG["max_brief_tokens"],
        thinking={"type": "adaptive"},
        output_config={"effort": BRIEF_CONFIG["brief_effort"]},
        system=BRIEF_SYSTEM,
        tools=[BRIEF_TOOL],
        tool_choice={"type": "tool", "name": "submit_brief"},
        messages=[{"role": "user", "content": user_content}],
    )
    log_model_usage("live_brief", model, resp)
    empty = {"market_read": "", "ideas": [], "held": [], "no_trade_reason": ""}
    if getattr(resp, "stop_reason", None) == "refusal":
        log("model refused — posting an empty brief")
        return {**empty, "market_read": "(model refused to write today's brief)", "refused": True}
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "submit_brief":
            data = dict(block.input or {})
            data["ideas"] = list(data.get("ideas") or [])[: BRIEF_CONFIG["max_ideas"]]
            data.setdefault("held", [])
            data.setdefault("no_trade_reason", "")
            data["refused"] = False
            return data
    return {**empty, "refused": False}


# ── Rendering ──────────────────────────────────────────────────────────────

def _usd(v) -> str:
    try:
        return f"${float(v):,.0f}"
    except (TypeError, ValueError):
        return "—"


def render_fields(brief: dict, account: dict) -> list[dict]:
    """Discord embed fields for the brief. Pure — unit-tested."""
    fields: list[dict] = []
    fields.append({
        "name": "Account",
        "value": (f"equity {_usd(account.get('equity'))} · cash {_usd(account.get('cash'))} · "
                  f"options BP {_usd(account.get('options_buying_power'))}"),
        "inline": False,
    })
    ideas = brief.get("ideas") or []
    for i, idea in enumerate(ideas, 1):
        fits = idea.get("fits_account")
        tag = "✅ fits account" if fits else "⛔ does not fit — " + _usd(idea.get("capital_required_usd")) + " needed"
        value = (
            f"**{idea.get('structure', '?')}** · {idea.get('direction', '')} · conf {idea.get('confidence', '?')}/5\n"
            f"{idea.get('legs', '')}\n"
            f"{idea.get('why', '')}\n"
            f"Paid: {idea.get('getting_paid', '')}\n"
            f"Max loss {_usd(idea.get('max_loss_usd'))} · needs {_usd(idea.get('capital_required_usd'))} · {tag}\n"
            f"Wrong if: {idea.get('invalidation', '')}\n"
            f"Risk: {idea.get('key_risk', '')}"
        )
        fields.append({"name": f"Idea {i} · {idea.get('symbol', '?')}", "value": value[:1024], "inline": False})
    if not ideas or not any(i.get("fits_account") for i in ideas):
        reason = brief.get("no_trade_reason") or "Nothing sized to the account today."
        fields.append({"name": "No actionable trade today", "value": reason[:1024], "inline": False})
    held = brief.get("held") or []
    if held:
        lines = [f"**{h.get('symbol', '?')}** — {h.get('watch', '')}" for h in held]
        fields.append({"name": "On what you hold", "value": "\n".join(lines)[:1024], "inline": False})
    return fields


def announce_brief(brief: dict, account: dict, model: str, date_str: str) -> None:
    send_embed(
        BRIEF_CONFIG["summary_channel"],
        title=f"☀️ Live brief — {date_str}",
        description=(brief.get("market_read") or "(no market read)")[:2048],
        color=Color.YELLOW,
        fields=render_fields(brief, account),
        footer=f"live_brief.py · read-only, nothing is placed · {model} · ideas, not signals",
        actions_channel=BRIEF_CONFIG["actions_channel"],
    )


def _announce_error(exc: BaseException) -> None:
    send_embed(
        BRIEF_CONFIG["errors_channel"],
        title="live_brief.py failed",
        description=f"{type(exc).__name__}: {exc}"[:2048],
        color=Color.RED,
        also_to_actions=False,
    )


# ── Entry point ────────────────────────────────────────────────────────────

def run_brief(client=None, dry_run: bool = False) -> dict:
    """Produce and post today's brief. Returns a summary dict (also for tests).

    dry_run: gather + ask the model, but do not post, persist, or log events —
    for a local look at what the brief would say.
    """
    summary = {"posted": False, "ideas": 0, "fits": 0, "refused": False, "errors": 0}
    try:
        if not dry_run and not alpaca_data.is_market_open(MODE):
            log("market closed — skipping brief (no model call, no notify)")
            log_event(BRIEF_CONFIG["log_stream"], "live_brief.py", "market_closed_skip")
            summary["skipped"] = "market_closed"
            return summary

        state = load_state()
        context = gather_live_context(client=client)
        context["previous_brief"] = previous_brief_context(state)

        model = brief_model()
        brief = call_with_retry(
            lambda: request_brief(context, client=client, model=model),
            attempts=BRIEF_CONFIG["brief_retries"],
            backoff=BRIEF_CONFIG["brief_retry_backoff_seconds"],
            on_retry=lambda n, delay, e: log(
                f"brief call transient failure ({type(e).__name__}); retry {n} in {delay:.0f}s"
            ),
        )
        summary["refused"] = bool(brief.get("refused"))
        ideas = brief.get("ideas") or []
        summary["ideas"] = len(ideas)
        summary["fits"] = sum(1 for i in ideas if i.get("fits_account"))

        now = datetime.now(ET)
        date_str = now.strftime("%a %b %d, %Y")
        record = {
            "date": now.strftime("%Y-%m-%d"),
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "model": model,
            "account": context["account"],
            "market_read": brief.get("market_read", ""),
            "ideas": ideas,
            "held": brief.get("held") or [],
            "no_trade_reason": brief.get("no_trade_reason", ""),
            "refused": summary["refused"],
            "scan": context.get("scan", {}),
        }
        # Strip the prompt-only note from the persisted account block.
        record["account"] = {k: v for k, v in record["account"].items() if k != "note"}

        if dry_run:
            print(json.dumps(record, indent=2, default=str))
            return summary

        announce_brief(brief, record["account"], model, date_str)
        summary["posted"] = True
        state["last_brief"] = record
        state["_meta"] = {"last_run_at": record["generated_at"], "runs": int((state.get("_meta") or {}).get("runs", 0)) + 1}
        save_state(state)
        log_event(BRIEF_CONFIG["log_stream"], "live_brief.py", "brief_posted",
                  details={"date": record["date"], "ideas": summary["ideas"],
                           "fits": summary["fits"], "model": model,
                           "scanned": record["scan"].get("universe_scanned"),
                           "focus": record["scan"].get("focus")})
        log(f"brief posted: {summary['ideas']} idea(s), {summary['fits']} fit the account")
        return summary
    except Exception as e:  # noqa: BLE001 — fail-soft, never corrupt state
        summary["errors"] += 1
        log(f"brief failed: {type(e).__name__}: {e}")
        if not dry_run:
            try:
                _announce_error(e)
                log_event(BRIEF_CONFIG["log_stream"], "live_brief.py", "brief_failed",
                          result="error", details={"error": f"{type(e).__name__}: {e}"})
            except Exception:  # noqa: BLE001
                pass
        return summary


if __name__ == "__main__":
    import sys
    run_brief(dry_run="--dry-run" in sys.argv)
