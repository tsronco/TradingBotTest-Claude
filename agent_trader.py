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


def build_quote_pack(symbols: list[str], mode: str = "agent") -> dict:
    """Cheap "breadth" scan: one batched snapshot pull → price + daily move for
    every candidate, NO option chains. This is what lets the universe be wide
    (~250 names) without a heavy per-cycle payload — Claude sees the whole field
    here, then names a shortlist we fetch chains for. Fully best-effort."""
    try:
        snaps = alpaca_data.get_stock_snapshots(
            list(symbols), mode=mode, chunk_size=_CFG.get("breadth_chunk_size", 100)
        )
    except Exception:  # noqa: BLE001 — breadth is best-effort; never fatal
        snaps = {}
    pack: dict = {}
    for sym, snap in snaps.items():
        lt = (snap or {}).get("latestTrade") or {}
        db = (snap or {}).get("dailyBar") or {}
        pdb = (snap or {}).get("prevDailyBar") or {}
        price = lt.get("p") if lt.get("p") is not None else db.get("c")
        prev = pdb.get("c")
        chg = round((price - prev) / prev * 100, 2) if (price and prev) else None
        pack[sym] = {
            "price": price,
            "change_pct": chg,
            "prev_close": prev,
            "day_high": db.get("h"),
            "day_low": db.get("l"),
            "volume": db.get("v"),
        }
    return pack


def gather_breadth(mode: str = "agent") -> dict:
    """Phase 1: account + positions + a quotes-only view of the WHOLE universe.
    Cheap enough to show Claude every candidate. No option chains yet."""
    account = alpaca_data.get_account(mode=mode)
    positions = alpaca_data.get_positions(mode=mode)
    held_underlyings = [_occ_underlying(p.get("symbol", "")) for p in positions]
    universe = list(_CFG.get("universe") or [])
    quotes = build_quote_pack(universe + held_underlyings, mode=mode)
    return {
        "account": {
            "equity": _f(account.get("equity")),
            "cash": _f(account.get("cash")),
            "buying_power": _f(account.get("buying_power")),
            "options_buying_power": _f(account.get("options_buying_power")),
        },
        "positions": positions,
        "universe": quotes,
        "equity_floor": _CFG["equity_floor"],
    }


def gather_depth(focus_symbols: list[str], positions: list, account: dict,
                 mode: str = "agent") -> dict:
    """Phase 2: full option chains for the focus shortlist + everything currently
    held (held names are always included so the model can always price a close).
    Same shape gather_breadth's account/positions carry through, plus `market`."""
    held_symbols = [p.get("symbol", "") for p in positions]
    held_underlyings = [_occ_underlying(s) for s in held_symbols]
    symbols = list(focus_symbols) + held_symbols + held_underlyings
    market = build_market_pack(symbols, mode=mode)
    # Annotate held option legs with a fair (mid-based) P&L next to Alpaca's
    # worst-case mark, so the model reads the truth instead of the scary number.
    annotate_positions_fair_value(positions, mode=mode)
    return {
        "account": account,
        "positions": positions,
        "market": market,
        "equity_floor": _CFG["equity_floor"],
    }


def _is_option_position(pos: dict) -> bool:
    """True for an option leg, False for a stock. Prefers Alpaca's asset_class;
    falls back to detecting an OCC symbol (ticker + YYMMDD + C/P + strike)."""
    ac = pos.get("asset_class") or pos.get("asset_class_name") or ""
    if ac:
        return "option" in str(ac).lower()
    sym = pos.get("symbol", "")
    return _occ_underlying(sym) != sym


def annotate_positions_fair_value(positions: list, mode: str = "agent") -> list:
    """Attach a mid-based fair-value P&L to each held OPTION leg, alongside
    Alpaca's raw mark.

    Alpaca marks a short leg at the ASK and a long leg at the BID — the
    worst-case corner — so on a wide/illiquid chain `unrealized_pl` overstates
    the loss on a position that's actually fine. This fetches each held option
    leg's live quote and computes the fairer mid-based figure so the model sees
    both numbers side by side and isn't spooked into a stale-mark panic close.

    Sign-safe: Alpaca's `qty` is signed (negative for shorts), so
    (mid − avg_entry) × qty × 100 has the correct sign for both long and short
    legs. Stocks are skipped (their last-trade mark is already fair). Best-effort
    — a leg whose quote can't be fetched simply keeps only the raw mark. Mutates
    and returns the same list."""
    for pos in positions:
        if not _is_option_position(pos):
            continue
        occ = str(pos.get("symbol", "") or "")
        qty = _f(pos.get("qty"))
        avg = _f(pos.get("avg_entry_price"))
        if not occ or qty is None or avg is None:
            continue
        try:
            q = alpaca_data.get_option_quote(occ, mode=mode)
        except Exception:  # noqa: BLE001 — annotation is best-effort, never fatal
            q = None
        bid = _f(q.get("bid")) if q else None
        ask = _f(q.get("ask")) if q else None
        if bid is None or ask is None or (bid <= 0 and ask <= 0):
            # No usable quote this cycle. Don't fail silently — flag it, so the
            # model knows the only number it has is the unreliable worst-case
            # mark and doesn't mistake a missing annotation for "nothing to fix."
            pos["fair_value"] = {
                "fair_value_available": False,
                "unrealized_pl_mark": _f(pos.get("unrealized_pl")),
                "note": ("could not fetch a live quote for this leg this cycle, so "
                         "the ONLY P&L figure available is Alpaca's worst-case "
                         "bid/ask mark — treat it as unreliable, weight it lightly, "
                         "and judge this position from the underlying's price vs "
                         "your strikes and your thesis instead."),
            }
            continue
        mid = round((bid + ask) / 2.0, 4)
        pos["fair_value"] = {
            "fair_value_available": True,
            "leg_bid": bid,
            "leg_ask": ask,
            "leg_mid": mid,
            "unrealized_pl_mid": round((mid - avg) * qty * 100, 2),
            "unrealized_pl_mark": _f(pos.get("unrealized_pl")),
            "note": ("unrealized_pl_mark is Alpaca's worst-case bid/ask mark "
                     "(short leg @ ask, long leg @ bid); unrealized_pl_mid is the "
                     "fair-value estimate from this leg's live mid. On a wide "
                     "chain, trust the mid."),
        }
    return positions


def build_self_context(state: dict) -> dict:
    """Continuity feed: the model's OWN recent reasoning, so each stateless cycle
    isn't a total amnesiac.

    Two parts, both deliberately scoped to stay honest:
      - open_position_theses: the entry thesis for every position the account
        STILL holds. Built from state["positions"], which _reconcile_and_grade
        has already pruned of anything closed on Alpaca — so a closed trade's
        thesis disappears on the very next cycle and can't be hallucinated into
        a phantom holding.
      - previous_cycle_note: the model's market_read from one cycle ago (only
        ever one hour old; overwritten every cycle). Framed to the model as
        history to verify against live data, never as current truth.
    """
    open_theses = []
    for pos in state.get("positions", {}).values():
        t = pos.get("thesis") or {}
        if not t:
            continue
        open_theses.append({
            "legs": pos.get("legs"),
            "opened_at": pos.get("opened_at"),
            "thesis": t.get("thesis"),
            "invalidation": t.get("invalidation"),
            "key_risk": t.get("key_risk"),
            "confidence": t.get("confidence"),
            # Intended vs actual entry price + slippage (once the fill landed), so
            # the model can see whether its limit prices are getting realistic fills.
            "fill": pos.get("fill"),
        })
    meta = state.get("_meta") or {}
    return {
        "open_position_theses": open_theses,
        # What the model REASONED last cycle (its market_read, written before any
        # order went in — so it reflects intent, not outcome).
        "previous_cycle_note": meta.get("last_market_read"),
        # What ACTUALLY executed last cycle (code-generated, post-execution): opens
        # submitted, closes, and any orders REJECTED with the reason. The pairing
        # of note + outcome lets the model see where intent and reality diverged
        # (a fill it didn't get, a structure Alpaca refused) instead of assuming
        # its pre-trade note is what happened.
        "previous_cycle_outcome": meta.get("last_cycle_outcome"),
    }


def _legs_summary(legs: list) -> str:
    """Compact 'sell 1 AAL...P, buy 1 AAL...P' string for outcome/notify records."""
    return ", ".join(
        f"{l.get('side')} {l.get('qty')} {l.get('symbol')}" for l in (legs or [])
    )


# ── The focus tool (phase 1: pick which names to analyze deeply) ───────────

FOCUS_TOOL = {
    "name": "select_focus",
    "description": (
        "From the full candidate universe (live quotes provided), pick the "
        "symbols worth analyzing in depth this cycle. You will get full option "
        "chains for exactly the names you list here (plus anything you already "
        "hold), then decide what to trade. Pick the names with the most "
        "promising setups right now; you don't have to justify each pick."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "market_read": {
                "type": "string",
                "description": (
                    "One or two sentences: what stands out in the field right "
                    "now and why you're drilling into the names you chose."
                ),
            },
            "focus": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Tickers to pull full option chains for this cycle. Choose "
                    "the best candidates; an empty list is allowed if truly "
                    "nothing is interesting."
                ),
            },
        },
        "required": ["market_read", "focus"],
    },
}


FOCUS_SYSTEM = """\
You are an autonomous trader running the first pass of your hourly cycle. You \
are shown a wide universe of liquid, optionable names with live quotes (price \
and today's move) — but no option chains yet, because pulling every chain is \
expensive. Your job right now is only to choose which names deserve a closer \
look: pick the ones with the most promising setups for a stock or defined-risk \
options trade this cycle. You'll receive full option chains for exactly the \
names you pick (plus anything you already hold) and make your actual trade \
decisions in the next step. Favor real opportunities over noise, but cast a \
wide enough net that you don't miss a good trade. Call select_focus once.\
"""


def _fallback_focus(breadth: dict, cap: int | None = None) -> list[str]:
    """Deterministic shortlist when the focus model call is unavailable: the
    biggest daily movers in the universe (absolute % change). Keeps the depth
    pass productive instead of empty."""
    cap = cap or _CFG.get("max_focus_symbols", 24)
    scored = [
        (sym, abs(v.get("change_pct") or 0.0))
        for sym, v in (breadth.get("universe") or {}).items()
    ]
    scored.sort(key=lambda x: x[1], reverse=True)
    return [sym for sym, _ in scored[:cap]]


def request_focus(breadth: dict, client=None, model: str | None = None) -> dict:
    """Phase-1 model call: from the wide quote-only universe, pick the shortlist
    of names to pull full chains for. Returns
    {"focus": [...], "market_read": str, "refused": bool}. Capped at
    max_focus_symbols. A refusal or empty pick is fine — the depth pass always
    includes held positions regardless, so the model can still hold or close."""
    if client is None:  # pragma: no cover — real client path, mocked in tests
        import anthropic
        client = anthropic.Anthropic()
    model = model or agent_config.model()
    cap = _CFG.get("max_focus_symbols", 24)

    user_content = (
        f"Pick up to {cap} names to analyze deeply this cycle from the universe "
        "below (quotes only — you'll get chains for your picks next).\n\n"
        + json.dumps(breadth, default=str)
    )
    resp = client.messages.create(
        model=model,
        max_tokens=_CFG.get("max_focus_tokens", 1200),
        thinking={"type": "adaptive"},
        system=FOCUS_SYSTEM,
        tools=[FOCUS_TOOL],
        tool_choice={"type": "tool", "name": "select_focus"},
        messages=[{"role": "user", "content": user_content}],
    )
    if getattr(resp, "stop_reason", None) == "refusal":
        return {"focus": [], "market_read": "(model refused focus step)", "refused": True}
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "select_focus":
            raw = block.input.get("focus", []) or []
            focus = [str(s).upper() for s in raw if str(s).strip()][:cap]
            return {
                "focus": focus,
                "market_read": block.input.get("market_read", ""),
                "refused": False,
            }
    return {"focus": [], "market_read": "", "refused": False}


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
            "market_read": {
                "type": "string",
                "description": (
                    "ALWAYS fill this in, every cycle, whether you trade or hold. "
                    "One to three sentences: what you see in the market and your "
                    "candidates right now, and specifically WHY you are trading or "
                    "holding this cycle. On a hold, name what would have to change "
                    "for you to act."
                ),
            },
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
        "required": ["market_read", "intents"],
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
- This account is Options Level 3: you may BUY long options, hold covered \
positions, and trade DEFINED-RISK multi-leg spreads (every short leg paired with \
a long leg, or covered by stock you already hold). You may NOT sell a \
naked/uncovered short option — Alpaca will reject it every time, so never attempt \
one; if you want short premium, structure it as a spread with a long hedge.
- Below the stated equity floor, opening new positions is blocked; you may still \
close.
- Options are U.S. equity options quoted per share (×100 per contract). Use real \
OCC option symbols from the market data provided. Stocks trade in whole shares.
- The market data below holds full option chains for the names you shortlisted \
this cycle plus everything you currently hold. Trade any of them, or hold. (You \
already scanned the wider universe when you chose this shortlist.)

For every position you OPEN you must submit a thesis with a concrete, checkable \
invalidation condition ("wrong if X closes below $Y before <date>"), the single \
biggest way it loses (key_risk), the math of what you're getting paid, a 1-5 \
confidence, and the alternatives you considered and rejected. This is how we \
learn later whether a losing trade lost for a reason you understood or one you \
missed — so be honest and specific.

Your own recent reasoning — continuity, not a rule. You run once an hour with no \
memory, so you are given `self_context`: the entry thesis for each position you \
STILL hold (why you're in it, its invalidation, the confidence you assigned); \
`previous_cycle_note`, the read you wrote last cycle (your INTENT — written \
before any order was placed, so it is not proof of what happened); and \
`previous_cycle_outcome`, the FACTUAL record of what actually executed last cycle \
— opens submitted, closes, and any orders Alpaca REJECTED with the reason. \
Reconcile the two: if an order you intended was rejected, do NOT blindly resubmit \
the same thing — read the reason and adapt (e.g. a rejected naked short must \
become a spread). Each still-held position also carries a `fill` block once it \
fills — `intended_net_credit` vs `actual_net_credit` and the `slippage` between \
them (per share; negative slippage = you got a worse price than you asked for). \
If your fills keep coming in worse than intended, your limit prices are too \
optimistic for that chain's liquidity — price more realistically next time. (If \
you added to an existing position, its blended average hides the per-order fill, \
so `fill_available` will be false and no slippage is shown — that's expected, not \
an error.) Use all of this so your decisions connect across time — when \
you add to, hold, or close a position, do it in light of what you already \
believed about it, and if you're departing from that earlier reasoning, say so \
plainly in your rationale rather than silently contradicting yourself. This is \
context, NOT an instruction: you are free to change your mind. Two hard \
caveats: (1) `self_context` is your PAST reasoning, not current market fact — \
always trust the live positions and market data over it. (2) Positions you have \
closed are deliberately absent from it; if something isn't in your live \
positions, you do not hold it — never infer a holding from an old note.

How to read a position's P&L — the mark lies on thin chains. Alpaca marks a \
short option (and therefore a credit spread) at the WORST-CASE corner of the \
quote: the short leg at its ASK, the long leg at its BID. On an illiquid or \
wide-quoted chain that corner is often stale and far from fair value, so the \
`unrealized_pl` you are shown can read deeply red on a position that is actually \
fine or even winning. Do NOT take that number at face value. To make this \
concrete, each held option leg is annotated with a `fair_value` block: \
`unrealized_pl_mark` (Alpaca's scary worst-case number) shown next to \
`unrealized_pl_mid` (the fair estimate from the leg's live mid), plus the leg's \
bid/ask/mid. Read the MID figure; sum the legs' `unrealized_pl_mid` for a \
spread's true P&L. If a leg shows `fair_value_available: false`, its live quote \
could not be fetched this cycle — the only figure is the unreliable worst-case \
mark, so weight it lightly and lean on the underlying vs your strikes instead. Corroborate with the underlying's price relative to your \
strikes and the greeks. A defined-risk spread cannot lose more than its width no \
matter what the mark says; a wide bid/ask on a quiet name is noise, not a loss. \
Decide to close because your thesis or its stated invalidation says so, or \
because the MID genuinely reflects a loss — never because a stale worst-case \
mark looks scary.

Posture — aim for the middle, not the sidelines. You are here to trade, and you \
cannot grow the account by watching. When you find a setup with a defensible \
edge and clearly defined, acceptable risk, TAKE IT — you do not need certainty \
or a perfect setup, only a favorable risk/reward you can defend with a thesis. \
Lean toward participating when a reasonable opportunity is in front of you, and \
prefer defined-risk structures so a wrong call is capped. But do NOT force a \
trade onto a weak or unclear setup just to be active, and never chase an \
obvious loser or a name in freefall. The bar is "a real edge I can argue for," \
not "a sure thing" and not "anything at all." When in doubt between a marginal \
trade and holding, size it small rather than sitting out entirely.

Fill in market_read every cycle — trading or holding — so your read is on the \
record. On a hold, say plainly what you'd need to see to act. Call \
submit_decisions exactly once.\
"""


def request_decisions(context: dict, client=None, model: str | None = None) -> dict:
    """Ask Opus for this cycle's decisions.

    Returns {"intents": [...], "market_read": str, "refused": bool}. market_read
    is the model's plain-English read of the market + why it traded or held this
    cycle (surfaced to #agent-actions and logged so holds aren't a black box).

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
        return {"intents": [], "market_read": "(model refused this cycle)", "refused": True}
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "submit_decisions":
            return {
                "intents": block.input.get("intents", []),
                "market_read": block.input.get("market_read", ""),
                "refused": False,
            }
    # No tool block (shouldn't happen with forced tool_choice) — no-trade.
    return {"intents": [], "market_read": "", "refused": False}


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


def _announce_hold(market_read: str, scanned: int | None = None,
                   focused: int | None = None) -> None:
    """Post the agent's read to the firehose on a hold cycle, so a 'no trade'
    decision is visible and explained rather than silent. Shows how wide it
    looked (universe scanned) and how many it drilled into."""
    fields = None
    if scanned is not None:
        fields = [{"name": "Scan",
                   "value": f"{scanned} names scanned · {focused or 0} analyzed in depth"}]
    send_embed(
        _CFG["actions_channel"],
        title="🕐 Holding — no trade this cycle",
        description=(market_read or "(no market read provided)")[:2048],
        color=Color.BLUE,
        fields=fields,
        also_to_actions=False,  # already posting directly to the actions channel
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


def _announce_rejection(intent: dict, status: int, body: str) -> None:
    """Ping #agent-errors when Alpaca refuses an order. Handled rejections are
    otherwise log-only (silent), so a loop on an unplaceable structure (e.g. an
    options-level restriction) would burn API calls unseen. Best-effort — a
    Discord failure must never break the cycle."""
    legs = _legs_summary(intent.get("legs"))
    try:
        send_embed(
            _CFG["errors_channel"],
            title=f"⚠️ Order rejected: {legs}"[:256],
            description=(
                f"Alpaca refused this order (HTTP {status}). No position opened.\n\n"
                f"Reason: {body}\n\n"
                "If this repeats cycle after cycle, the agent may be looping on a "
                "structure it cannot place — check the log."
            )[:2048],
            color=Color.RED,
            actions_channel=_CFG["actions_channel"],
        )
    except Exception:  # noqa: BLE001
        pass


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


def _intent_net_credit(intent: dict) -> float | None:
    """Signed net price the agent INTENDED, per share: positive = net credit
    received, negative = net debit paid. None for a market order (no target
    price to compare a fill against).

    Convention: a sold leg contributes +price, a bought leg −price. Alpaca's
    mleg limit is already the signed net (negative = credit), so a multi-leg
    intent just flips that sign; a single leg derives it from its side."""
    if intent.get("order_type") != "limit":
        return None
    lp = _f(intent.get("limit_price"))
    legs = intent.get("legs") or []
    if lp is None or not legs:
        return None
    if len(legs) == 1:
        return lp if legs[0].get("side") == "sell" else -lp
    return -lp  # mleg net: negative limit = credit → positive credit


def _actual_net_credit(legs: list, alpaca_positions: list) -> float | None:
    """Signed net price actually FILLED, per share, from each leg's avg entry on
    Alpaca (sold leg +avg, bought leg −avg). None unless EVERY leg is present
    (a partial/one-leg view would net wrong)."""
    by_sym = {str(p.get("symbol", "")).upper(): p for p in alpaca_positions}
    total = 0.0
    for leg in legs or []:
        p = by_sym.get(str(leg.get("symbol", "")).upper())
        avg = _f(p.get("avg_entry_price")) if p else None
        if avg is None:
            return None  # a leg isn't visible yet — can't net honestly
        total += avg if leg.get("side") == "sell" else -avg
    return round(total, 4) if legs else None


def _position_qty_is_isolated(position: dict, alpaca_positions: list) -> bool:
    """True iff this tracked order accounts for the ENTIRE held quantity of each
    of its legs — so `avg_entry_price` reflects only THIS order's fill, not a
    blend across multiple opens.

    If the agent adds a second unit of the same spread, Alpaca merges both fills
    into one blended average; comparing that blend against a single order's
    intended credit yields a real-looking but meaningless slippage. Requiring an
    exact qty match (per leg) is the guard: held qty ≠ this order's qty ⇒ the
    average is blended (extra units) or the fill is partial ⇒ don't report a
    number. `_actual_net_credit`'s per-share math is qty-independent, so the qty
    check is purely about whether the average is contaminated by other orders."""
    by_sym = {str(p.get("symbol", "")).upper(): p for p in alpaca_positions}
    legs = position.get("legs") or []
    if not legs:
        return False
    for leg in legs:
        p = by_sym.get(str(leg.get("symbol", "")).upper())
        if not p:
            return False
        held, want = _f(p.get("qty")), _f(leg.get("qty"))
        if held is None or want is None or abs(held) != abs(want):
            return False
    return True


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
        # Now that the position is visible, compute the ACTUAL fill vs what the
        # agent intended (slippage) — the fill price isn't known at placement
        # time, only once the leg avg-entries land here. Compute once.
        pos = tracked[pid]
        if pos.get("intended_net_credit") is not None and "fill" not in pos:
            if not _position_qty_is_isolated(pos, alpaca_positions):
                # Held qty is blended across multiple opens (or not fully filled),
                # so avg_entry_price no longer isolates THIS order's fill. A
                # slippage number here would be arithmetically real but
                # meaningless — flag it, don't fabricate it.
                pos["fill"] = {
                    "fill_available": False,
                    "note": ("this order's fill price can't be isolated — the "
                             "position quantity is blended across multiple entries "
                             "(or not fully filled), so no slippage is reported."),
                }
            else:
                actual = _actual_net_credit(pos.get("legs"), alpaca_positions)
                if actual is not None:
                    intended = pos["intended_net_credit"]
                    pos["fill"] = {
                        "fill_available": True,
                        "intended_net_credit": intended,
                        "actual_net_credit": actual,
                        "slippage": round(actual - intended, 4),
                    }

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

        # Phase 1 (breadth): quotes for the whole universe — cheap, wide view.
        breadth = gather_breadth()
        # Phase 1b: Claude picks the shortlist worth deep analysis this cycle.
        try:
            focus_res = request_focus(breadth, client=client)
        except Exception as e:  # noqa: BLE001 — focus is not worth killing a cycle
            log(f"focus step failed, falling back to top movers: {e}")
            focus_res = {"focus": [], "market_read": f"(focus step failed: {e})",
                         "refused": False}
        focus = focus_res.get("focus") or _fallback_focus(breadth)
        universe_size = len(breadth.get("universe") or {})

        # Phase 2 (depth): full chains only for the shortlist + held names.
        context = gather_depth(focus, breadth["positions"], breadth["account"])
        market = context["market"]

        if not dry_run:
            log_event(_CFG["log_stream"], "agent_trader.py", "focus_selected",
                      details={"focus": focus, "scanned": universe_size,
                               "market_read": focus_res.get("market_read", "")})

        # Education layer: reconcile tracked positions against Alpaca — snapshot
        # the still-open ones (for an approximate close P&L) and grade any that
        # have closed since last cycle. Runs before decisions so the model sees
        # a clean slate, and grading never blocks the trading cycle.
        _reconcile_and_grade(state, context["positions"], market,
                             client=client, summary=summary, dry_run=dry_run)

        # Continuity feed: hand the model its own recent reasoning so a stateless
        # cycle isn't a total amnesiac. Built AFTER reconcile — which has already
        # pruned any closed position — so only STILL-held theses carry forward
        # (a closed trade's thesis vanishes next cycle; nothing to hallucinate).
        context["self_context"] = build_self_context(state)

        decisions = request_decisions(context, client=client)
        summary["refused"] = decisions.get("refused", False)
        market_read = decisions.get("market_read", "")
        # Persist this cycle's read as next cycle's "previous_cycle_note" (always
        # exactly one hour old; overwritten every cycle so it never goes stale).
        state["_meta"]["last_market_read"] = market_read

        # Factual record of what this cycle actually does — persisted as next
        # cycle's `previous_cycle_outcome` so the agent learns from fills and,
        # crucially, from rejections (it never reads its own logs otherwise).
        cycle_outcome = {"opened": [], "closed": [], "rejected": []}

        for intent in decisions.get("intents", []):
            legs_str = _legs_summary(intent.get("legs"))
            ok, reason = check_feasibility(intent, context["account"])
            if not ok:
                summary["rejected"] += 1
                cycle_outcome["rejected"].append(
                    {"legs": legs_str, "source": "feasibility", "reason": reason})
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
                cycle_outcome["rejected"].append(
                    {"legs": legs_str, "source": "network", "reason": str(e)})
                log_event(_CFG["log_stream"], "agent_trader.py", "order_error",
                          result="failure", details={"error": str(e)})
                continue
            if resp.status_code >= 300:
                summary["errors"] += 1
                body = resp.text[:500]
                cycle_outcome["rejected"].append(
                    {"legs": legs_str, "source": "alpaca",
                     "reason": f"Alpaca {resp.status_code}: {body}"})
                log_event(_CFG["log_stream"], "agent_trader.py", "order_rejected",
                          result="failure",
                          details={"status": resp.status_code, "body": body,
                                   "intent": intent})
                # Surface a handled rejection to #agent-errors — it's silent
                # otherwise (log-only), so a loop on an unplaceable structure
                # would burn API calls unnoticed until someone reads the log.
                _announce_rejection(intent, resp.status_code, body)
                continue
            order = resp.json()
            order_id = order.get("id", "")
            if intent["action"] == "open":
                summary["opened"] += 1
                intended_nc = _intent_net_credit(intent)
                cycle_outcome["opened"].append(
                    {"legs": legs_str, "order_id": order_id,
                     "intended_net_credit": intended_nc})
                state["positions"][order_id] = {
                    "opened_at": _now_iso(),
                    "legs": intent["legs"],
                    "thesis": intent.get("thesis"),
                    "open_order_id": order_id,
                    # What we asked for, per share (+ = credit). The actual fill +
                    # slippage get computed next cycle in reconcile, once the leg
                    # avg-entries are visible on Alpaca, and stored as `fill`.
                    "intended_net_credit": intended_nc,
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
                cycle_outcome["closed"].append({"legs": legs_str, "order_id": order_id})
                _announce_close(intent, order_id)
            log_event(_CFG["log_stream"], "agent_trader.py",
                      f"{intent['action']}_placed",
                      alpaca_order_id=order_id,
                      details={"intent": intent})

        # Persist this cycle's factual outcome for next cycle's continuity feed
        # (overwritten every cycle, so it stays exactly one hour old like the note).
        state["_meta"]["last_cycle_outcome"] = cycle_outcome

        # Record the model's read every cycle so a hold isn't a black box — logged
        # to the audit trail always, and surfaced to #agent-actions on a hold
        # (a cycle where nothing was opened or closed) so you can see WHY it passed.
        if not dry_run:
            log_event(_CFG["log_stream"], "agent_trader.py", "market_read",
                      details={"market_read": market_read, "summary": dict(summary)})
            if summary["opened"] == 0 and summary["closed"] == 0:
                _announce_hold(market_read, scanned=universe_size, focused=len(focus))

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
