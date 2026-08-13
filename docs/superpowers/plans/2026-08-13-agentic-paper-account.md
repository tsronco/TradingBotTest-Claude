# Agentic Paper Account — Claude-Driven Spread Trading (Plan / Design for review)

> **Status: DRAFT FOR REVIEW — no code written yet.** This is the review artifact Tim
> asked for before any build. On approval it splits into a formal spec +
> task-by-task plan (superpowers format) and gets implemented behind a new `--mode`.

**Goal:** Stand up a new **paper** account (~$2,000 seed) whose trades are chosen by
Claude (via the Anthropic API) rather than by the deterministic screener. Claude
picks the underlying, strikes, width, and expiration for **put credit spreads**;
the existing hardened code validates every choice against risk rails and manages
the exits. Run it for ~2 weeks alongside the untouched `manual` + `live` accounts,
then decide whether the approach is worth pointing at real money.

**This account does not touch `manual` or `live`.** It is purely additive — a new
mode, new credentials, new state/log files, new Discord channels, new workflow.
Nothing in the existing two accounts changes.

---

## The core design decision (please confirm)

**Claude decides ENTRIES. Proven code (`handle_spread`) manages EXITS.**

The one genuinely new component is a brain that replaces the screener's
"screen → score → normalize → pick" with "ask Claude to pick." Everything
downstream — the risk gauntlet, `_open_spread_mleg` order placement, and the
50%-profit / stop / DTE / tripwire exit logic in `handle_spread` — is reused
byte-for-byte from the spread engine you already trust.

Why not let Claude manage exits too (v1)?
- **Safety:** `handle_spread` is the most-tested, most-bug-fixed path in the repo
  (the entire May 30 spread-loss structural fix lives there). Letting an LLM
  re-decide exits every hour throws that away and invites churn.
- **PDT (see below):** autopilot exits hold for days; LLM-driven exits invite
  same-day round trips, which are structurally fatal on a sub-$25k account.
- **Clean experiment:** we're testing *Claude's entry selection vs the screener's*.
  Holding exits constant isolates that variable.

If you'd rather Claude own the full lifecycle, that's a v2 toggle — noted in Open
Decisions. **My recommendation: entries-by-Claude, exits-by-code for the 2-week run.**

Directional scope for v1: **put credit spreads only** (bullish/neutral bets).
That's the only spread type `handle_spread` auto-manages today. Call credit spreads
(bearish) need a `handle_spread` extension — fast-follow, not v1. So in v1 Claude
can express "I'm bullish/neutral on X" but not "I'm bearish on X." Flagged in Open
Decisions.

---

## ⚠️ The constraint that shapes everything: PDT on a sub-$25k account

Your own `config.py` (manual `auto_open_spreads`, disabled 2026-06-03) records the
lesson:

> the manual account is a margin account under $25k, so same-day round trips by the
> auto-opener tripped Alpaca's Pattern Day Trading protection (code 40310100). Once
> flagged, EVERY further order — including the closes the manager needs — is denied.
> Autonomous same-day spread churn is structurally incompatible with a sub-$25k
> margin account.

A $2,000 account is *far* under $25k. If this account ever does 4 day-trades in a
rolling 5 business days, Alpaca locks it and even the exit orders get denied. Two
mitigations, applied together (belt and suspenders):

1. **Provision the paper account as a CASH account, not margin** (Tim, at signup /
   in Alpaca paper settings). Cash accounts have **no PDT rule**. Put credit spreads
   in a cash account are cash-secured (full width held as collateral) — clean and
   simple at this size. This is the primary fix.
2. **Hard day-trade rail in code** regardless: track opens/closes per symbol per day;
   block any action that would create the 4th day-trade in a rolling 5-day window.
   Because exits run through `handle_spread` (multi-day holds — profit close, DTE≥2
   floor), same-day round trips should be rare anyway; the rail is the backstop for
   the tripwire/settle edge cases.

**Decision needed:** confirm the paper account will be a cash account (recommended).
If it must be margin, v1 must additionally forbid *any* same-day close, which
partially defeats the tripwire — a real behavior tradeoff we'd need to accept.

---

## Architecture — a new mode, one new script, everything else reused

New `--mode agent` (name TBD — `agent` / `ai2000` / your call). Mirrors the mode
machinery every script already uses:

```
config.MODES["agent"] = {
    credentials:  ALPACA_AGENT_API_KEY / _SECRET / _BASE_URL  (paper endpoint)
    channels:     agent_trades / agent_summary / agent_errors / agent_actions
    state files:  wheel_state_agent.json, strategy_state_agent.json
    log stream:   agent   (logs/agent.jsonl)
    ... reuses the whole spread param block (risk cap, credit-to-width, DTE,
        concurrency, tripwire, settle, concession) from the Balanced posture ...
    agentic_open: True     # NEW flag — routes opens through Claude instead of the screener
    day_trade_guard: True  # NEW flag — the PDT rail
}
```

**New component — `agent_trader.py`** (the only real new code). Each hourly cycle:

1. **Gather context** (read-only): account equity / cash / options BP, current open
   spreads (from `wheel_state_agent.json`), day-trade count, and a **candidate pack** —
   quotes + near-dated put chains for a bounded universe (reuse `SM_CURATED_UNIVERSE`,
   52 liquid optionable names, so Claude is never picking from the whole market).
2. **Ask Claude** (Anthropic API) with a system prompt that states the mandate, the
   hard rails as *context* (not as the enforcement), the candidate pack, and current
   positions. Claude returns a structured decision: `open` (symbol, short strike,
   long strike, expiration, rationale) or `hold` (no trade this cycle, with reason).
3. **Validate in code** — run the proposed open through the existing gauntlet:
   `spread_passes_risk` (max-loss ≤ risk cap), `min_credit_to_width_pct`,
   `min_net_credit`, `earnings_exclusion_days` (via `earnings.py`), BP fit,
   `under_concurrency`, `account_floor`, and the new day-trade rail. **Anything the
   model proposes that fails a rail is rejected and logged — the code disposes.**
4. **Execute** the surviving open via `_open_spread_mleg` (same STO/BTO mleg,
   near-mid resting limit via `compute_open_limit_credit`).
5. **Seed state** as a `stage: "spread_active"` entry (existing shape) with the
   model's rationale stored in a new `agent_reasoning` field for the audit trail.
   `handle_spread` picks it up and manages the exit from the next cycle — unchanged.
6. **Manage** — before opening, the cycle first runs `handle_spread` over existing
   `spread_active` entries (exact manual behavior), so exits always get evaluated.
7. **Notify** — open/close embeds to `#agent-trades`, reasoning to `#agent-actions`,
   failures to `#agent-errors`. Fully fail-soft (a bad cycle never corrupts state).

**Reuse map** (new vs. reused):

| Piece | Status |
|---|---|
| Candidate universe (`SM_CURATED_UNIVERSE`) | reuse |
| Risk gauntlet (`spread_passes_risk`, credit-to-width, earnings, BP, concurrency) | reuse |
| Order placement (`_open_spread_mleg`, `compute_open_limit_credit`) | reuse |
| Pending-fill resolution (`_resolve_pending_spread`, `_reconcile_spread_fill`) | reuse |
| Exit management (`handle_spread`: 50% / stop / DTE / tripwire / settle) | reuse |
| State shape (`spread_active`), Discord embeds, JSONL logging | reuse |
| Mode wiring (`config.MODES`, `parse_mode_arg`, `apply_mode`) | reuse pattern |
| **The decision brain (Claude API call + candidate pack + validation glue)** | **new** |
| **PDT day-trade rail** | **new** |

---

## Cadence, cost, sizing

- **Cadence: hourly** (your pick). ~7 cycles/day × 5 days ≈ **35 Claude calls/week**.
  Spreads are multi-day holds, so hourly is plenty responsive; it also curbs the
  model's temptation to overtrade.
- **Cost:** each cycle is one API call (~5–15k input tokens for the candidate pack +
  state, small output). With Sonnet that's roughly **single-digit dollars/week** —
  negligible. Recommend **Sonnet** (you already use it for grading); Opus is a
  drop-in if we want stronger reasoning at higher cost. *Decision in Open Decisions.*
- **Sizing at $2k:** at a 10% risk cap, max loss per spread ≈ $200 → fits a $2-wide
  spread or narrower. This is the sm2000-class regime (the SM account that behaved
  best). Concurrency cap likely 2–3. Cash-secured collateral at this size is
  comfortable. sm500's "can't fit any width under the cap" problem does **not** apply
  at $2k.

---

## What we measure (2-week validation)

Same discipline as the SM validation: primary metric is **avg-win / avg-loss ratio**,
not win rate alone. Secondary: total P&L vs the $2k base, number of no-trade cycles
(a disciplined agent should decline often), and a qualitative read of the stored
`agent_reasoning` — is Claude's thesis coherent, or is it rationalizing noise?
Gate to even *discuss* live: two clean weeks + at least one full open→close cycle,
mirroring the manual-paper gate that precedes every live change in this repo.

---

## File structure (on approval)

**Bot (Python):**
- Modify `config.py` — add `MODES["agent"]` + the two new flags.
- Create `agent_trader.py` — context gather, Claude call, validation glue, day-trade rail.
- Modify `wheel_strategy.py` — route the opener through `agent_trader` when
  `agentic_open` is set (a thin branch in `_auto_open_spread`, or a sibling entry
  point). Exits/`handle_spread` untouched.
- Modify `daily_summary.py` — `--mode agent` summary → `#agent-summary`.
- Create `.github/workflows/tsla-monitor-agent.yml` — hourly cron step + state commit.
- Create `tests/test_agent_trader.py` — mandate parsing, rail enforcement (every
  gauntlet rejection path), day-trade guard, Claude call mocked. **No test hits the
  real API or Alpaca**, per `conftest.py` convention.
- Modify `tools/setup_cronjobs.py` — add the hourly cron-job.org entry.

**Dashboard (optional, additive):**
- Register `agent` across the ~8 account enumeration sites (union types, `credsFor`,
  sidebar chip). Non-blocking — can follow after the bot runs.

**Provisioning (Tim, out of code scope):**
- Create the Alpaca **paper** sub-account (**cash account** recommended), seed ~$2k.
- Add `ALPACA_AGENT_*` (3) as GitHub Actions secrets (+ Vercel env vars if dashboard).
- Create the 4 `#agent-*` Discord channels + webhooks.
- Provide/confirm `ANTHROPIC_API_KEY` is available to the workflow (already a repo
  secret for the dashboard grading path).

---

## Open decisions for Tim

1. **Account type: cash (recommended) or margin?** Cash sidesteps PDT entirely. Margin
   forces a stricter no-same-day-close rule in v1.
2. **Exit authority: code-managed (recommended v1) or Claude-managed (v2)?** Confirms
   the core design decision above.
3. **Directional scope: put credit only (recommended v1) or add call credit (needs a
   `handle_spread` extension)?** v1-only limits Claude to bullish/neutral.
4. **Model: Sonnet (recommended, cheap) or Opus (stronger, pricier)?**
5. **Mode name:** `agent` / `ai2000` / other?
6. **Seed amount:** confirm ~$2,000.

---

## What is explicitly NOT in scope for v1

- Any change to `manual` or `live` behavior (this is additive only).
- Real-money trading (paper only; live is a separate future decision behind the
  2-week gate).
- Claude managing exits, call-credit/debit spreads, or naked stock/options.
- Position-level auto-roll.
