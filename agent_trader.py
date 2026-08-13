"""Autonomous agent paper trader — Claude (Opus) makes every decision.

This is the harness for the `agent` paper account. Unlike the wheel/strategy
bots (deterministic Python), here Claude via the Anthropic API decides *what*
to trade, *which structure*, *how big*, *when to enter*, and *when to exit*,
across the full options + stock toolbox. The code's job is to gather context,
execute Claude's decisions, enforce one soft guard, and record the reasoning.

Hourly cron cycle (`run_cycle`):
  1. Gather full account + market context (read-only, via alpaca_data).
  2. Ask Opus for its decisions — a list of structured intents, each carrying a
     falsifiable entry thesis (the education layer).
  3. Feasibility-check each intent in code (real tradable contracts, Alpaca can
     margin it, equity-floor circuit breaker). NOT a judgment veto — only
     "can Alpaca actually place this."
  4. Execute surviving intents via Alpaca (single-leg stock/option or mleg).
  5. Record open positions + their theses in agent_state.json; notify Discord;
     log JSONL. Fully fail-soft — a bad cycle logs and exits without corrupting
     state.

Full autonomy: no wheel/screener/handle_spread machinery runs here. The account
is a paper margin sub-account (PDT rule eliminated 2026-06-04, so same-day round
trips are fine on Alpaca — no day-trade rail needed). Real money is a separate
future decision, gated on validation.

Anthropic API notes (see the claude-api skill): model defaults to Opus 5 via
`agent_config.model()`, adaptive thinking is on, and decisions come back through
a forced tool call (`submit_decisions`) for guaranteed-shape structured output.
A `stop_reason == "refusal"` is handled as a no-trade cycle.
"""
import json
import os
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

import agent_config
import agent_grading
import alpaca_data
from notifications import send_embed, log_event, Color

load_dotenv()

_CFG = agent_config.get()

PAPER_TRADING_URL = "https://paper-api.alpaca.markets/v2"
DEFAULT_TIMEOUT = 20

# Asset / side / order-type vocabularies the executor understands. Claude is
# told these in the mandate; anything outside them fails feasibility.
_ASSETS = {"stock", "option"}
_SIDES = {"buy", "sell"}
_ORDER_TYPES = {"market", "limit"}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] agent: {msg}", flush=True)


# ── Credentials / HTTP (paper endpoint, agent creds) ───────────────────────

def _headers() -> dict:
    return {
        "APCA-API-KEY-ID": os.getenv(_CFG["alpaca_key_env"], ""),
        "APCA-API-SECRET-KEY": os.getenv(_CFG["alpaca_secret_env"], ""),
        "accept": "application/json",
        "content-type": "application/json",
    }


def _base_url() -> str:
    raw = (os.getenv(_CFG["alpaca_url_env"]) or "").strip()
    if raw.startswith(("http://", "https://")):
        # Agent is paper-only: refuse a live endpoint even if misconfigured.
        if "paper-api.alpaca.markets" in raw:
            return raw
    return PAPER_TRADING_URL


# ── State ──────────────────────────────────────────────────────────────────

def _state_path() -> str:
    return os.path.join(os.path.dirname(__file__), _CFG["state_file"])


def _empty_state() -> dict:
    return {
        "_meta": {
            "created_at": None,
            "cycle_count": 0,
            "last_cycle_at": None,
            "seed_capital": _CFG["seed_capital"],
        },
        # Bot-opened positions keyed by a synthetic id, each carrying the entry
        # thesis so the education layer can grade process vs outcome on close.
        "positions": {},
        # Closed-trade lesson records (append-only) for the retrospective digest.
        "closed": [],
    }


def load_state() -> dict:
    path = _state_path()
    if not os.path.exists(path):
        return _empty_state()
    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return _empty_state()
    # Merge forward so older files gain new keys without crashing.
    base = _empty_state()
    base.update({k: v for k, v in data.items() if k in base})
    base["_meta"].update(data.get("_meta", {}))
    return base


def save_state(state: dict) -> None:
    with open(_state_path(), "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)


# ── Context gathering (read-only) ──────────────────────────────────────────

def build_market_pack(symbols: list[str], mode: str = "agent") -> dict:
    """Quotes + near-dated option chain snapshots for the candidate + held set.

    Bounded to keep the decision prompt sane. Fetch failures on any single
    symbol are swallowed (that name simply carries less context) so one bad
    ticker never sinks the cycle.
    """
    pack: dict = {}
    for sym in sorted(set(s.upper() for s in symbols if s)):
        entry: dict = {}
        try:
            entry["quote"] = alpaca_data.get_stock_quote(sym, mode=mode)
        except Exception:  # noqa: BLE001 — best-effort context, never fatal
            entry["quote"] = None
        try:
            # Near-dated chain (both puts and calls, 7–45 DTE) with greeks/IV.
            snaps = alpaca_data.get_option_chain_snapshots(
                sym, exp_min_days=7, exp_max_days=45, mode=mode
            )
            # Trim to keep the payload bounded — keep the OCC + core fields.
            entry["option_count"] = len(snaps)
            entry["options"] = _trim_chain(snaps)
        except Exception:  # noqa: BLE001
            entry["options"] = {}
            entry["option_count"] = 0
        pack[sym] = entry
    return pack


def _trim_chain(snaps: dict, keep: int = 40) -> dict:
    """Keep a bounded slice of a chain snapshot dict with just the fields the
    model needs to price a structure: bid/ask, greeks, IV."""
    trimmed = {}
    for occ, snap in list(snaps.items())[:keep]:
        q = (snap or {}).get("latestQuote", {}) or {}
        trimmed[occ] = {
            "bid": q.get("bp"),
            "ask": q.get("ap"),
            "greeks": snap.get("greeks"),
            "iv": snap.get("impliedVolatility"),
        }
    return trimmed


def gather_context(mode: str = "agent") -> dict:
    """Assemble the full read-only picture the model reasons over each cycle."""
    account = alpaca_data.get_account(mode=mode)
    positions = alpaca_data.get_positions(mode=mode)
    held_symbols = [p.get("symbol", "") for p in positions]
    # Underlyings behind option positions, parsed from the OCC symbol prefix.
    held_underlyings = [_occ_underlying(s) for s in held_symbols]
    universe = list(_CFG.get("universe") or [])
    market = build_market_pack(universe + held_symbols + held_underlyings, mode=mode)
    return {
        "account": {
            "equity": _f(account.get("equity")),
            "cash": _f(account.get("cash")),
            "buying_power": _f(account.get("buying_power")),
            "options_buying_power": _f(account.get("options_buying_power")),
        },
        "positions": positions,
        "market": market,
        "equity_floor": _CFG["equity_floor"],
    }


# ── The decision tool (structured output via forced tool use) ──────────────

DECISION_TOOL = {
    "name": "submit_decisions",
    "description": (
        "Submit this cycle's trading decisions. Return zero or more intents. "
        "Every 'open' intent MUST carry a full thesis. Return an empty list to "
        "hold and do nothing this cycle."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "intents": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "action": {"type": "string", "enum": ["open", "close"]},
                        "rationale": {"type": "string"},
                        "order_type": {"type": "string", "enum": ["market", "limit"]},
                        "limit_price": {"type": ["number", "null"]},
                        "legs": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "asset": {"type": "string", "enum": ["stock", "option"]},
                                    "symbol": {"type": "string"},
                                    "side": {"type": "string", "enum": ["buy", "sell"]},
                                    "qty": {"type": "integer"},
                                },
                                "required": ["asset", "symbol", "side", "qty"],
                            },
                        },
                        "thesis": {
                            "type": ["object", "null"],
                            "additionalProperties": False,
                            "properties": {
                                "thesis": {"type": "string"},
                                "why_this_structure": {"type": "string"},
                                "getting_paid": {"type": "string"},
                                "key_risk": {"type": "string"},
                                "invalidation": {"type": "string"},
                                "confidence": {"type": "integer"},
                                "rejected": {"type": "string"},
                            },
                            "required": [
                                "thesis", "why_this_structure", "getting_paid",
                                "key_risk", "invalidation", "confidence", "rejected",
                            ],
                        },
                    },
                    "required": ["action", "rationale", "order_type",
                                 "limit_price", "legs", "thesis"],
                },
            },
        },
        "required": ["intents"],
    },
}


SYSTEM_MANDATE = """\
You are an autonomous trader. You have been given a real paper-money brokerage \
account and full discretion over it. Your objective is to grow the account's \
equity over time while being able to explain and defend every decision.

You decide everything: what to trade, which structure (long stock, long \
options, or any defined-risk options combination — verticals, credit or debit \
spreads, iron condors, butterflies, straddles, strangles), how large, when to \
enter, and when to exit. You may also close positions you opened earlier. There \
is no house strategy to follow and no risk-appetite you must adopt — use your \
own judgment.

Constraints are mechanical, not editorial:
- It is a MARGIN paper account. Alpaca enforces buying power at order time; if a \
structure can't be margined it will simply be rejected and reported back to you.
- Below the stated equity floor, opening new positions is blocked; you may still \
close.
- Options are U.S. equity options quoted per share (×100 per contract). Use real \
OCC option symbols from the market data provided. Stocks trade in whole shares.

For every position you OPEN you must submit a thesis with a concrete, checkable \
invalidation condition ("wrong if X closes below $Y before <date>"), the single \
biggest way it loses (key_risk), the math of what you're getting paid, a 1-5 \
confidence, and the alternatives you considered and rejected. This is how we \
learn later whether a losing trade lost for a reason you understood or one you \
missed — so be honest and specific.

Call submit_decisions exactly once. Return an empty intents list to do nothing \
this cycle — patience is a valid, often correct choice. Do not force a trade.\
"""


def request_decisions(context: dict, client=None, model: str | None = None) -> dict:
    """Ask Opus for this cycle's decisions. Returns {"intents": [...], "refused": bool}.

    Uses a forced tool call for guaranteed-shape output (see the claude-api
    skill). A safety refusal is treated as a no-trade cycle, never an error.
    """
    if client is None:  # pragma: no cover — real client path, mocked in tests
        import anthropic
        client = anthropic.Anthropic()
    model = model or agent_config.model()

    user_content = (
        "Here is the current account state and market data for this cycle. "
        "Decide what to do.\n\n" + json.dumps(context, default=str)
    )
    resp = client.messages.create(
        model=model,
        max_tokens=_CFG["max_decision_tokens"],
        thinking={"type": "adaptive"},
        system=SYSTEM_MANDATE,
        tools=[DECISION_TOOL],
        tool_choice={"type": "tool", "name": "submit_decisions"},
        messages=[{"role": "user", "content": user_content}],
    )
    if getattr(resp, "stop_reason", None) == "refusal":
        log("model refused — treating as no-trade cycle")
        return {"intents": [], "refused": True}
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "submit_decisions":
            return {"intents": block.input.get("intents", []), "refused": False}
    # No tool block (shouldn't happen with forced tool_choice) — no-trade.
    return {"intents": [], "refused": False}


# ── Feasibility (mechanics, not judgment) ──────────────────────────────────

def check_feasibility(intent: dict, account: dict, cfg: dict = _CFG) -> tuple[bool, str]:
    """Return (ok, reason). Rejects only things Alpaca physically can't place
    or the equity-floor breaker blocks — never vetoes strategy or sizing."""
    action = intent.get("action")
    if action not in ("open", "close"):
        return False, f"unknown action {action!r}"

    legs = intent.get("legs") or []
    if not legs:
        return False, "no legs"

    for leg in legs:
        if leg.get("asset") not in _ASSETS:
            return False, f"bad asset {leg.get('asset')!r}"
        if leg.get("side") not in _SIDES:
            return False, f"bad side {leg.get('side')!r}"
        if not isinstance(leg.get("qty"), int) or leg["qty"] <= 0:
            return False, f"bad qty {leg.get('qty')!r}"
        if not str(leg.get("symbol") or "").strip():
            return False, "missing symbol"

    if intent.get("order_type") not in _ORDER_TYPES:
        return False, f"bad order_type {intent.get('order_type')!r}"
    if intent.get("order_type") == "limit" and intent.get("limit_price") in (None, ""):
        return False, "limit order without limit_price"

    if action == "open":
        if intent.get("thesis") is None:
            return False, "open intent missing thesis"
        # Equity-floor circuit breaker: block opens (not closes) below the floor.
        floor = cfg.get("equity_floor", 0) or 0
        equity = account.get("equity")
        if equity is not None and equity < floor:
            return False, f"equity {equity} below floor {floor} — opens blocked"

    return True, "ok"


# ── Execution (intent → Alpaca order payload → POST) ───────────────────────

def build_order_payload(intent: dict) -> dict:
    """Translate a feasible intent into an Alpaca /orders payload.

    Single leg → a plain stock/option order. Multiple legs → an mleg order
    (STO/BTO combination) with a signed net limit (negative = credit).
    """
    legs = intent["legs"]
    order_type = intent["order_type"]
    tif = "day"

    if len(legs) == 1:
        leg = legs[0]
        payload = {
            "symbol": leg["symbol"],
            "qty": str(leg["qty"]),
            "side": leg["side"],
            "type": order_type,
            "time_in_force": tif,
        }
        if order_type == "limit":
            payload["limit_price"] = f"{float(intent['limit_price']):.2f}"
        return payload

    # Multi-leg — ratio_qty from each leg's share of the smallest qty so a
    # 1x2 or unequal structure still expresses correctly.
    base = min(l["qty"] for l in legs)
    mleg = {
        "order_class": "mleg",
        "qty": str(base),
        "type": order_type,
        "time_in_force": tif,
        "legs": [
            {
                "symbol": l["symbol"],
                "ratio_qty": str(max(1, l["qty"] // base)),
                "side": l["side"],
                "position_intent": _position_intent(l["side"], intent["action"]),
            }
            for l in legs
        ],
    }
    if order_type == "limit":
        # Sign convention: Alpaca mleg limit is negative for a net credit.
        mleg["limit_price"] = f"{float(intent['limit_price']):.2f}"
    return mleg


def _position_intent(side: str, action: str) -> str:
    if action == "open":
        return "sell_to_open" if side == "sell" else "buy_to_open"
    return "buy_to_close" if side == "buy" else "sell_to_close"


def place_order(payload: dict) -> requests.Response:
    return requests.post(
        f"{_base_url()}/orders",
        headers=_headers(),
        data=json.dumps(payload),
        timeout=DEFAULT_TIMEOUT,
    )


# ── Helpers ────────────────────────────────────────────────────────────────

def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _occ_underlying(symbol: str) -> str:
    """Extract the underlying ticker from an OCC option symbol, else return the
    symbol unchanged (a plain stock ticker). OCC = TICKER + YYMMDD + C/P + strike."""
    s = str(symbol or "")
    # Find the 6-digit date that starts the OCC tail; the prefix is the ticker.
    for i in range(1, len(s) - 6):
        if s[i:i + 6].isdigit() and i + 6 < len(s) and s[i + 6] in ("C", "P"):
            return s[:i]
    return s


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Notifications ──────────────────────────────────────────────────────────

def _announce_open(intent: dict, order_id: str) -> None:
    thesis = intent.get("thesis") or {}
    legs = ", ".join(
        f"{l['side']} {l['qty']} {l['symbol']}" for l in intent.get("legs", [])
    )
    fields = [
        {"name": "Thesis", "value": (thesis.get("thesis") or "—")[:1024]},
        {"name": "Invalidation", "value": (thesis.get("invalidation") or "—")[:1024]},
        {"name": "Key risk", "value": (thesis.get("key_risk") or "—")[:1024]},
        {"name": "Confidence", "value": str(thesis.get("confidence", "—"))},
    ]
    send_embed(
        _CFG["trades_channel"],
        title=f"🤖 Opened: {legs}",
        description=intent.get("rationale", "")[:2048],
        color=Color.GREEN,
        fields=fields,
        actions_channel=_CFG["actions_channel"],
    )


def _announce_close(intent: dict, order_id: str) -> None:
    legs = ", ".join(
        f"{l['side']} {l['qty']} {l['symbol']}" for l in intent.get("legs", [])
    )
    send_embed(
        _CFG["trades_channel"],
        title=f"🤖 Closed: {legs}",
        description=intent.get("rationale", "")[:2048],
        color=Color.BLUE,
        actions_channel=_CFG["actions_channel"],
    )


def _announce_lesson(lesson: dict) -> None:
    grade = lesson.get("grade") or {}
    outcome = lesson.get("outcome") or {}
    thesis = lesson.get("thesis") or {}
    legs = ", ".join(
        f"{l['side']} {l['qty']} {l['symbol']}" for l in lesson.get("legs", [])
    )
    pnl = outcome.get("estimated_pnl")
    won = isinstance(pnl, (int, float)) and pnl > 0
    fields = [
        {"name": "Thesis", "value": (thesis.get("thesis") or "—")[:1024]},
        {"name": "Outcome / Process",
         "value": f"{grade.get('outcome_grade') or '—'} / {grade.get('process_grade') or '—'}  "
                  f"(est P&L {'$' + format(pnl, '.2f') if isinstance(pnl, (int, float)) else '—'})"},
        {"name": "Why", "value": _loss_type_label(grade.get("loss_type"))},
        {"name": "Lesson", "value": (grade.get("lesson") or "—")[:1024]},
    ]
    send_embed(
        _CFG["summary_channel"],
        title=f"📚 Lesson: {legs}",
        color=Color.GREEN if won else Color.RED,
        fields=fields,
        actions_channel=_CFG["actions_channel"],
    )


def _loss_type_label(lt: str | None) -> str:
    return {
        "win": "✅ Win",
        "anticipated": "🟡 Anticipated loss (lost via the risk it named)",
        "blind_spot": "🔴 Blind spot (lost for a reason it never saw)",
        "breakeven": "⚪ Breakeven / flat",
    }.get(lt or "", "—")


# ── Close detection + grading (education layer) ────────────────────────────

# A tracked open order that never becomes a visible Alpaca position within this
# many days is treated as a dead/unfilled order and dropped without grading.
STALE_UNFILLED_DAYS = 1


def _leg_symbols(position: dict) -> set:
    return {str(l.get("symbol", "")).upper() for l in position.get("legs", [])}


def reconcile_positions(tracked: dict, alpaca_positions: list) -> tuple[list, list]:
    """Split tracked positions into (still_open_ids, absent_ids) by whether any
    of their leg symbols is currently held on Alpaca. Pure — no I/O."""
    held = {str(p.get("symbol", "")).upper() for p in alpaca_positions}
    still_open, absent = [], []
    for pid, pos in tracked.items():
        if _leg_symbols(pos) & held:
            still_open.append(pid)
        else:
            absent.append(pid)
    return still_open, absent


def snapshot_position(position: dict, alpaca_positions: list) -> dict:
    """Approximate mark for a tracked position: summed unrealized P&L / market
    value / cost basis across its legs currently held on Alpaca. {} if none
    held. Pure — no I/O."""
    by_sym = {str(p.get("symbol", "")).upper(): p for p in alpaca_positions}
    pnl = mv = cb = 0.0
    seen = False
    for sym in _leg_symbols(position):
        p = by_sym.get(sym)
        if p:
            seen = True
            pnl += _f(p.get("unrealized_pl")) or 0.0
            mv += _f(p.get("market_value")) or 0.0
            cb += _f(p.get("cost_basis")) or 0.0
    if not seen:
        return {}
    return {"unrealized_pl": round(pnl, 2), "market_value": round(mv, 2),
            "cost_basis": round(cb, 2), "seen_at": _now_iso()}


def _underlyings_now(position: dict, market: dict) -> dict:
    out = {}
    for sym in {_occ_underlying(l.get("symbol", "")) for l in position.get("legs", [])}:
        px = ((market.get(sym) or {}).get("quote") or {}).get("p")
        if px is not None:
            out[sym] = px
    return out


def build_outcome(position: dict, market: dict) -> dict:
    """Best-effort close data for the grader: approximate P&L from the last mark
    before close, days held, and each underlying's move since entry."""
    snap = position.get("last_snapshot") or {}
    entry_u = (position.get("entry_context") or {}).get("underlyings", {}) or {}
    now_u = _underlyings_now(position, market)
    moves = {}
    for sym, entry_px in entry_u.items():
        cur = now_u.get(sym)
        if entry_px and cur:
            moves[sym] = {"entry": entry_px, "now": cur,
                          "pct": round((cur - entry_px) / entry_px * 100, 2)}
    return {
        "estimated_pnl": snap.get("unrealized_pl"),
        "estimated_pnl_basis": "last mark before close (approximate)",
        "days_held": _days_since(position.get("opened_at")),
        "underlying_moves": moves,
    }


def _reconcile_and_grade(state: dict, alpaca_positions: list, market: dict,
                         client, summary: dict, dry_run: bool = False) -> None:
    tracked = state.get("positions", {})
    still_open, absent = reconcile_positions(tracked, alpaca_positions)

    # Snapshot the confirmed-open positions so a close next cycle has a mark.
    for pid in still_open:
        snap = snapshot_position(tracked[pid], alpaca_positions)
        if snap:
            snap["underlyings"] = _underlyings_now(tracked[pid], market)
            tracked[pid]["last_snapshot"] = snap

    for pid in absent:
        pos = tracked[pid]
        if pos.get("last_snapshot"):
            # Was confirmed open on a prior cycle, now gone → a genuine close.
            outcome = build_outcome(pos, market)
            grade = (agent_grading.grade_position(pos, outcome, client=client)
                     if not dry_run else agent_grading._default_grade())
            lesson = {
                "closed_at": _now_iso(),
                "opened_at": pos.get("opened_at"),
                "legs": pos.get("legs"),
                "thesis": pos.get("thesis"),
                "outcome": outcome,
                "grade": grade,
            }
            state.setdefault("closed", []).append(lesson)
            summary["graded"] = summary.get("graded", 0) + 1
            summary["closed"] += 1
            del tracked[pid]
            if not dry_run:
                _announce_lesson(lesson)
                log_event(_CFG["log_stream"], "agent_trader.py", "position_graded",
                          details={"lesson": lesson})
        elif (_days_since(pos.get("opened_at")) or 0) > STALE_UNFILLED_DAYS:
            # Opened but never became a visible position — treat as unfilled/dead.
            del tracked[pid]
            log_event(_CFG["log_stream"], "agent_trader.py", "dropped_unfilled",
                      result="skipped", details={"position": pos})
        # else: freshly opened, not yet visible on Alpaca — re-check next cycle.


def _entry_context(intent: dict, market: dict) -> dict:
    underlyings = {}
    for leg in intent.get("legs", []):
        u = _occ_underlying(leg.get("symbol", ""))
        px = ((market.get(u) or {}).get("quote") or {}).get("p")
        if px is not None:
            underlyings[u] = px
    return {"underlyings": underlyings}


def _days_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        then = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None
    return (datetime.now(timezone.utc) - then).total_seconds() / 86400.0


# ── Orchestration ──────────────────────────────────────────────────────────

def run_cycle(client=None, dry_run: bool = False) -> dict:
    """One hourly cycle. Returns a summary dict (also useful for tests).

    Fail-soft: any unexpected error is logged to #agent-errors and the cycle
    ends without corrupting state.
    """
    summary = {"opened": 0, "closed": 0, "rejected": 0, "graded": 0,
               "refused": False, "errors": 0}
    try:
        state = load_state()
        if state["_meta"].get("created_at") is None:
            state["_meta"]["created_at"] = _now_iso()

        context = gather_context()
        market = context["market"]

        # Education layer: reconcile tracked positions against Alpaca — snapshot
        # the still-open ones (for an approximate close P&L) and grade any that
        # have closed since last cycle. Runs before decisions so the model sees
        # a clean slate, and grading never blocks the trading cycle.
        _reconcile_and_grade(state, context["positions"], market,
                             client=client, summary=summary, dry_run=dry_run)

        decisions = request_decisions(context, client=client)
        summary["refused"] = decisions.get("refused", False)

        for intent in decisions.get("intents", []):
            ok, reason = check_feasibility(intent, context["account"])
            if not ok:
                summary["rejected"] += 1
                log_event(_CFG["log_stream"], "agent_trader.py", "intent_rejected",
                          result="skipped", details={"reason": reason, "intent": intent})
                continue
            if dry_run:
                log(f"[dry-run] would {intent['action']}: {reason}")
                continue
            try:
                resp = place_order(build_order_payload(intent))
            except requests.RequestException as e:
                summary["errors"] += 1
                log_event(_CFG["log_stream"], "agent_trader.py", "order_error",
                          result="failure", details={"error": str(e)})
                continue
            if resp.status_code >= 300:
                summary["errors"] += 1
                log_event(_CFG["log_stream"], "agent_trader.py", "order_rejected",
                          result="failure",
                          details={"status": resp.status_code, "body": resp.text[:500],
                                   "intent": intent})
                continue
            order = resp.json()
            order_id = order.get("id", "")
            if intent["action"] == "open":
                summary["opened"] += 1
                state["positions"][order_id] = {
                    "opened_at": _now_iso(),
                    "legs": intent["legs"],
                    "thesis": intent.get("thesis"),
                    "open_order_id": order_id,
                    # Snapshot of entry-time underlying prices so the grader can
                    # later check the thesis's invalidation condition and the
                    # direction of the move. last_snapshot is filled in on the
                    # next cycle once the position is visible on Alpaca.
                    "entry_context": _entry_context(intent, market),
                    "last_snapshot": None,
                }
                _announce_open(intent, order_id)
            else:
                summary["closed"] += 1
                _announce_close(intent, order_id)
            log_event(_CFG["log_stream"], "agent_trader.py",
                      f"{intent['action']}_placed",
                      alpaca_order_id=order_id,
                      details={"intent": intent})

        state["_meta"]["cycle_count"] = state["_meta"].get("cycle_count", 0) + 1
        state["_meta"]["last_cycle_at"] = _now_iso()
        if not dry_run:
            save_state(state)
    except Exception as e:  # noqa: BLE001 — fail-soft; never crash the workflow
        summary["errors"] += 1
        log(f"cycle error: {e}")
        try:
            send_embed(
                _CFG["errors_channel"],
                title="agent cycle error",
                description=f"{type(e).__name__}: {e}"[:2048],
                color=Color.RED,
            )
        except Exception:  # noqa: BLE001
            pass
    return summary


if __name__ == "__main__":
    import sys
    _dry = "--dry-run" in sys.argv[1:] or "dry-run" in sys.argv[1:]
    result = run_cycle(dry_run=_dry)
    log(f"cycle summary: {result}")
