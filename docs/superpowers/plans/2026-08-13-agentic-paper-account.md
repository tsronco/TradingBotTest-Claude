# Agentic Paper Account — Fully Autonomous Claude Trader (Plan / Design for review)

> **Status: DRAFT FOR REVIEW — no code written yet.** Review artifact Tim asked for
> before any build. On approval it splits into a formal spec + task-by-task plan
> (superpowers format) and gets implemented behind a new `--mode`.

**Goal:** Stand up a new **paper** account (~$2,000 seed, margin) that Claude trades
**with full autonomy** — Claude decides *what* to trade, *which structure*, *how big*,
*when to enter*, and *when to exit*, across the full options strategy zoo (long
puts/calls, debit & credit verticals, iron condors, butterflies, straddles/strangles,
and plain stock). The code's job is execution + one account-survival guardrail + a
rich education layer that captures the reasoning behind every decision. Run it ~2
weeks alongside the untouched `manual` + `live` accounts, then decide next steps.

**This account does not touch `manual` or `live`.** Purely additive — new mode, new
credentials, new state/log files, new Discord channels, new workflow. Its harness is
*separate* from the wheel/spread manager, so nothing in the existing two accounts can
be affected.

---

## Autonomy posture (confirmed with Tim)

- **Full strategic autonomy.** Claude owns entries, exits, structure, sizing, timing.
  It's paper — we optimize for *learning what Claude does*, not for guardrails.
- **Claude-managed exits.** No deterministic `handle_spread` autopilot on this account.
  Claude re-evaluates every open position each cycle and decides hold / close / adjust.
- **All strategy types**, bounded only by what Alpaca can execute and what the intraday
  margin framework allows on a $2k account (see Buying power + Feasibility below).
- **No day-trade guardrail** — the Pattern Day Trader rule was eliminated (see below),
  so unlimited same-day round trips are fine on Alpaca now. Nothing to engineer around.
- **One optional soft guard: an equity-floor circuit breaker.** If equity falls below a
  floor (e.g. $500), stop *opening* new positions but keep letting Claude *close* — so a
  blowup still leaves a runnable, observable account instead of a smoking crater.
  Adjustable / removable; the only non-execution limit in the whole design.

---

## Buying power: the PDT rule is gone; Alpaca uses Intraday Margin now

The old worry — Pattern Day Trader lockout on a sub-$25k account — **no longer
applies.** FINRA's PDT rule was eliminated (SEC approval 2026-04-14, effective
2026-06-04), and **Alpaca implemented its new Intraday Margin Framework on 2026-06-04**:
the PDT designation, the $25,000 minimum, day-trade counting, and the 3-in-5-days
restriction are all removed from the platform (PDT/DTBP API fields were deprecated and
dropped 2026-07-06). Standard **Reg T still applies — $2,000 minimum to open a margin
account**, which is exactly this account's seed.

What that means for us:
- **Unlimited same-day round trips.** No day-trade rail needed; the earlier draft's
  survival guardrail is removed.
- **Buying power is now dynamic**, based on real-time intraday margin exposure rather
  than a fixed equity gate. On a $2k account this simply means limited BP for large or
  undefined-risk positions — and **Alpaca enforces it at order time**, rejecting
  anything the account can't margin. So the harness never has to model margin itself;
  it just surfaces Alpaca's rejection reason back into the log (and to Claude).
- Net effect: full autonomy is unconstrained on the account-survival front. The only
  things that can stop an order are (a) Alpaca can't margin it, or (b) the optional
  equity-floor breaker — both mechanical, neither a judgment veto.

*(Historical note: the manual account's `auto_open_spreads` was disabled 2026-06-03 by
the old PDT protection — one day before the framework changed. That constraint is now
obsolete; it does not apply to this account.)*

---

## Architecture — a standalone agentic harness

New `--mode agent` (name TBD). Mirrors the mode machinery every script uses, but this
account runs its **own** decision+execution loop rather than the wheel/spread manager:

```
config.MODES["agent"] = {
    credentials:  ALPACA_AGENT_API_KEY / _SECRET / _BASE_URL   (paper endpoint)
    channels:     agent_trades / agent_summary / agent_errors / agent_actions
    log stream:   agent   (logs/agent.jsonl)
    state file:   agent_state.json   (its own model — positions + theses + DT ledger)
    seed:         ~2000
    model:        claude-opus (the decision brain; see Model note)
    universe:     candidate pool for context (starts from SM_CURATED_UNIVERSE, expandable)
    equity_floor: 500         # optional soft circuit breaker (open-block only)
}
```

**New component — `agent_trader.py`** (the real new code). Each **hourly** cycle:

1. **Gather full context** (read-only): equity / cash / margin & options BP, *every*
   current position (any structure, with live P&L and each leg's mark), the day-trade
   ledger, and a **market pack** — quotes + option chains (with greeks/IV) for the
   candidate universe + every symbol currently held. Bounded so the prompt stays sane.
2. **Ask Claude** (Anthropic API) with a system prompt defining the mandate, the full
   toolbox of strategies, the account state, and the market pack. Claude returns a
   **structured decision list**: zero or more intents, each one of:
   `open` (any structure: legs = [{side, right, strike, expiry, qty}]),
   `close` (position id, full or partial), `adjust/roll` (close + reopen as one plan),
   or `hold` — **each intent carries the falsifiable thesis schema** (see Education).
3. **Feasibility-check in code** (not judgment — mechanics): every leg is a real,
   tradable contract; the structure is expressible as an Alpaca order (single or
   `mleg`); Alpaca's intraday margin covers it; opens respect the optional equity-floor
   circuit breaker. Infeasible intents are rejected with a reason fed back into the log
   (and, optionally, back to Claude next cycle so it learns the constraint). **No
   strategy/sizing veto** — only "can Alpaca actually do this."
4. **Execute** via the existing low-level plumbing — `_open_spread_mleg` / a
   generalized `mleg` placement for multi-leg, plain order placement for single-leg
   and stock, `compute_open_limit_credit`-style near-mid limits.
5. **Record** each position in `agent_state.json` with its full `agent_thesis`
   attached, and update the day-trade ledger on any same-day round trip.
6. **Notify** — open/close/adjust embeds → `#agent-trades`, full reasoning →
   `#agent-actions`, failures → `#agent-errors`. Fully fail-soft: a bad cycle logs and
   exits without corrupting state.

**Reuse vs new:**

| Piece | Status |
|---|---|
| Mode wiring (`config.MODES`, `parse_mode_arg`, `apply_mode` pattern) | reuse |
| Low-level order placement (`_open_spread_mleg`, mleg, stock/option orders) | reuse / generalize |
| Leg-closing primitives (`_close_spread_mleg`, individual-leg fallback) | reuse / generalize |
| Quote / chain / greeks / bars fetch (`alpaca_data.py`) | reuse |
| Pending-fill resolution (`_resolve_pending_spread` pattern) | reuse pattern |
| Discord embeds, JSONL logging, fail-soft harness | reuse |
| Dashboard AI grading + calibration + tendency crons (education) | reuse |
| **The decision loop (Opus call, full-account context, multi-intent output)** | **new** |
| **General position/intent model + execution translator (any structure)** | **new** |
| **Optional equity-floor circuit breaker** | **new** |
| **Falsifiable-thesis capture + education layer** | **new** |
| `handle_spread` / wheel state machine / screener scoring | **NOT used here** |

**Model note:** because the entire value is Claude's judgment across complex
structures, recommend **Opus** for the decision brain (still only ~35 calls/week at
hourly → modest cost). Sonnet is a cheaper fallback if we want to compare.

**Cadence tradeoff (hourly):** exits are only re-evaluated each hour, so a fast move
can run for up to ~60 min before Claude reacts. Acceptable for paper + mostly
defined-risk structures; if we later see it matters, we tighten cadence or add an
intra-hour stop. Flagged, not solved, in v1.

---

## Feasibility at $2k margin (what's actually placeable)

- **Defined-risk multi-leg** (verticals, iron condors, butterflies) — max loss is the
  width; cheap and clean at this size, fits easily.
- **Long options** (debit) — cost = premium; fine.
- **Short premium with undefined/large risk** (naked calls, short straddles/strangles)
  — margin requirement can be large or disallowed on a small account; Alpaca will
  reject what it won't margin, and the feasibility check surfaces that as a reason
  rather than a crash. Claude learns the constraint from the feedback.
- **Stock** — plain buys/sells allowed within BP.

So "all strategies" in practice = everything Alpaca will let a $2k margin account
place; the harness never pretends an un-marginable structure went through.

---

## Education layer — every trade is a lesson (the point of the whole exercise)

The goal isn't just to run a bot; it's to *understand* each decision and be able to
say later "that made sense" or "that was a mistake, and here's the specific reason."
The dashboard already has AI grading + calibration + tendency detection — we point it
at a trader whose reasoning we captured up front.

**Principle: grade PROCESS separately from OUTCOME.** A trade can lose and still be a
good decision (variance), or win and be a bad one (luck). Only grading P&L teaches the
wrong lessons. So we capture a *falsifiable thesis before the outcome exists*, then
check it against what actually happened.

**1. Structured, falsifiable thesis at entry (`agent_thesis`, required on every open):**
- `thesis` — the view (direction / vol / event) driving the trade
- `why_this_structure` — why *this* strategy and these strikes/expiry vs alternatives
- `getting_paid` — the math: cost/credit, max profit, max loss, breakeven(s)
- `key_risk` — the single most likely way this loses
- `invalidation` — a concrete, checkable condition ("wrong if X closes below $Y before
  <date>"). This is what makes the thesis falsifiable.
- `confidence` — 1–5
- `rejected` — other structures/candidates it considered and passed on, and why

**2. Exit reasoning captured too.** Since Claude manages exits, every close records
*why now* (`exit_thesis`: profit target hit / thesis invalidated / risk changed /
better use of capital / time decay realized). So both ends of the trade are explained.

**3. Process-vs-outcome hindsight grade on close** (reuse the dashboard grading path):
- `outcome_grade` — did it make money
- `process_grade` — was the decision sound *given only what was knowable at entry*
- `invalidation_fired` — did the entry's own named invalidation actually trigger?
- `loss_type` (for losers) — **anticipated** (lost via the `key_risk` it named — a
  well-reasoned loss) vs **blind-spot** (lost for a reason it never saw — the ones we
  learn most from)
- `exit_quality` — did Claude exit well, or give back profit / panic-close / hold too
  long? (unique to this account since exits are Claude's)
- `lesson` — one plain-English sentence

**4. Per-trade lesson card** — Discord embed + dashboard view: thesis → exit reason →
outcome → process grade → one-line lesson. Scroll history = a study deck.

**5. Confidence calibration** — do its 5/5 trades actually beat its 2/5 trades? If not,
its confidence is noise and we discount it. (Same machinery as the dashboard's
your-grade-vs-AI calibration, new axis.)

**6. Weekly retrospective digest** — a Sunday cron reads the week's theses + exits +
outcomes and writes plain-English "what we learned": recurring blind spots, which
thesis *types* systematically failed, whether confidence tracked results, whether exit
timing helped or hurt, one thing to watch next week. This is the doc we actually read
to get smarter together.

Net: for any trade you can see the argument that justified it, why it was closed,
whether the argument held, and — if it lost — whether it lost for a reason Claude
understood or one it missed. That last distinction is the whole education.

---

## What we measure (2-week validation)

Primary: **avg-win / avg-loss ratio** and **process-grade distribution** (are the
decisions sound, independent of variance?). Secondary: total P&L vs $2k base, no-trade
discipline, confidence calibration, exit quality. This is a learning run — a modest
P&L with high process grades is a better signal than a lucky number with sloppy
reasoning.

---

## File structure (on approval)

**Bot (Python):**
- Modify `config.py` — add `MODES["agent"]` + its flags.
- Create `agent_trader.py` — context gather, Opus call, structured-intent parsing,
  feasibility check, execution translator, day-trade rail, thesis capture. The bulk.
- Create `agent_execution.py` (or extend `wheel_strategy` low-level helpers) — a
  general "intent → Alpaca order(s)" translator for arbitrary single/multi-leg.
- Modify `daily_summary.py` — `--mode agent` summary → `#agent-summary` + lesson cards.
- Create `agent_retrospective.py` — the weekly digest (reuse tendency-detection shape).
- Create `.github/workflows/tsla-monitor-agent.yml` — hourly cron + state commit; and a
  weekly retrospective step (or fold into `daily-summary`/a Sunday job).
- Create `tests/test_agent_trader.py` — intent parsing, feasibility rejections
  (un-marginable structure, bad contract), equity-floor breaker, thesis-schema
  enforcement, execution translation for each structure. **Claude + Alpaca fully
  mocked** per `conftest.py`. No test touches a real service.
- Modify `tools/setup_cronjobs.py` — add the hourly + weekly cron-job.org entries.

**Dashboard (additive, can follow the bot):**
- Register `agent` across the account enumeration sites; render lesson cards +
  confidence-calibration panel for this account.

**Provisioning (Tim, out of code scope):**
- Create the Alpaca **paper margin** sub-account, seed ~$2k.
- Add `ALPACA_AGENT_*` (3) as GitHub Actions secrets (+ Vercel env vars if dashboard).
- Create the 4 `#agent-*` Discord channels + webhooks.
- Confirm `ANTHROPIC_API_KEY` is available to the workflow (already a repo secret).

---

## Remaining open decisions for Tim

1. **Mode name:** `agent` / `ai2000` / `autopilot` / other?
2. **Model:** Opus (recommended — judgment is the whole point) or Sonnet (cheaper)?
3. **Keep the equity-floor circuit breaker** (stop opening below ~$500, still allow
   closes)? Recommended, but removable if you want zero soft limits.
4. **Seed amount:** confirm ~$2,000.
5. **Reddit thread:** paste the gist if you want its specifics folded into the mandate
   prompt (I can't fetch Reddit directly).

The three code-shaping calls (margin, Claude-managed exits, all strategies) are locked
per your last message. With the PDT rule gone on Alpaca, there is no mandatory guardrail
left — the only optional limit is the equity-floor breaker in decision #3.

---

## Explicitly NOT in scope for v1

- Any change to `manual` or `live` behavior (additive only).
- Real money (paper only; live is a separate future decision).
- Sub-hourly reaction / intra-hour stops (flagged tradeoff).
- Modeling margin in the harness (Alpaca's intraday margin framework enforces it at
  order time; we just surface rejections).
