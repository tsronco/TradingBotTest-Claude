# Position coach (educational) — design

**Date:** 2026-06-30
**Status:** draft (design), pending approval
**Surface:** dashboard `/lookup/:symbol` (new read-only panel + one new serverless route)

## Problem

When the user (a new trader) looks up a symbol they actually hold, the page shows
the AI market summary, the chart, the options chain, fundamentals, etc. — but
nothing ties any of that back to **their own position**. They asked for "position
context for the advice as a new trader." The honest constraint: the dashboard
must not give **advice** (buy/sell/hold, price targets, predictions). What it
*can* do is **educate** — explain, in plain English, what their position is, what
the numbers mean, what the bot is doing with it, and what the general risks are.

So Feature B is a **position-aware educational coach**, not an advisor.

## Goals

- On `/lookup/:symbol`, when the symbol is **held in the selected account**, show a
  short, plain-English panel that:
  - States the position in human terms (e.g. "You own 5 shares of SNAP at an
    average cost of $4.53; it's down 3% from there").
  - Explains what the **bot is currently doing** with it — the live stop price,
    which ladder rungs remain, whether the trailing stop is armed, and (for
    options) the wheel stage — read from the bot's own state.
  - Defines any jargon it uses (stop, trailing stop, ladder, wheel stage) in one
    clause, the first time it appears.
  - Names the **general risk** in educational terms (e.g. "a stop means the bot
    will sell if price falls to $4.08, locking in the loss to avoid a bigger one").
- Be **truthful and grounded**: every number the panel states is computed in code
  from real data (Alpaca position + bot KV state), never invented by the model.
- **Never give advice**: no buy/sell/hold, no price targets, no predictions, no
  "you should." Hard-enforced in the prompt and reinforced by a visible
  "educational, not advice" disclaimer.

## Non-goals (YAGNI)

- No recommendations, ratings, conviction scores, or "what would you do" output.
- No new trade actions — this panel is read-only; it places/cancels nothing.
- No portfolio-wide view — this is per-symbol, on the lookup page only.
- No historical coaching / journaling / streaks.
- v1 covers **stock positions only**; option/spread positions get a minimal
  factual line and defer the richer explainer to v2 (see Phasing).

## Approach — hybrid (deterministic facts + AI explainer)

Two layers, so the model can phrase but never fabricate:

### Layer 1 — deterministic facts (computed in code)

A new serverless handler assembles a **typed facts object** from sources that are
already wired:

| Fact | Source |
|---|---|
| `qty`, `avg_cost`, `side` | Alpaca `/v2/positions/{symbol}` (`alpacaTrade()`) |
| `current_price`, `change_pct` | Alpaca snapshot (`alpacaData()`, same call the quote panel uses) |
| `unrealized_pl`, `unrealized_pl_pct` | computed: `(current − avg_cost) × qty`, and the % |
| `stop_price`, `trailing_active`, `high_water_mark`, `ladder_done[]` | bot strategy state — KV `bot:strategy:<mode>` (already whitelisted in `kv-keys.ts`) |
| `wheel_stage` (option positions) | bot wheel state — KV `bot:state:<mode>` |
| `atm_iv_pct` | reuse `buildOptionsDigest` from `ai-summary.ts` |
| `is_excluded` | `config.MODES[mode].excluded_symbols` mirror (or a static list constant on the dashboard) |
| `is_live` | `mode === 'live'` → real-money note |

All math (P/L, distance-to-stop, which ladder rungs remain) happens here. If the
bot has never run on this symbol yet, the bot-state fields are simply `null` and
the panel degrades to position facts only.

### Layer 2 — AI explainer (Sonnet, no web search)

The facts object is handed to Claude Sonnet 4.6 with a **strict educational
prompt**. The model's only job is to **narrate the numbers it was given** in
friendly, jargon-defining prose — it gets no tools, no web search, and is told
every figure is authoritative and must not be changed. Because it has nothing to
look up and nothing to predict, it cannot drift into advice without violating an
explicit rule.

If the LLM call fails or returns empty, **the panel still renders Layer 1** as a
compact deterministic readout (graceful degradation — facts never depend on the
model being up).

### Why hybrid (vs. either pole)

- **Pure deterministic** (templated sentences) would be safe but robotic and hard
  to keep readable as the fact set grows; defining jargon naturally is exactly
  what an LLM is good at.
- **Pure AI** (hand it raw data, let it talk) risks fabricated numbers and
  advice-shaped phrasing. Unacceptable on a real-money account.
- **Hybrid** gets the safety of computed facts with the readability of generated
  prose, and fails closed to the facts if the model is down.

## The no-advice guardrail (prompt)

System prompt for the explainer enforces, explicitly:

- You are an **educational assistant for a beginner**, not a financial advisor.
- **Never** tell the user to buy, sell, hold, add, trim, or wait. **Never** give a
  price target or predict direction. **Never** say "you should."
- Only describe: what the position is, what each number means, what the bot is
  configured to do, and the general mechanical risk.
- Every number in the input is final — restate it, never recompute or estimate.
- Define each piece of jargon in one short clause the first time it appears.
- Length: **at most 4 sentences.** Plain language, no hype.

(Mirrors the discipline already proven on `ai-summary.ts`: tight length cap +
explicit forbidden-claims list.)

A visible footer keeps the boundary obvious to the user:
`Educational — explains your position and the bot's plan. Not financial advice.`

## Components

### 1. New serverless handler — `position-coach`

Rides inside the existing `api/alpaca/[endpoint].ts` catchall (no new Vercel
function — stays under the Hobby 12-cap, same pattern as `ai-summary`).

```
GET /api/alpaca/position-coach?symbol=<SYM>&mode=<manual|live>[&refresh=1]
→ 200 { symbol, held: boolean, facts: PositionFacts, explainer: string|null, generated_at, cached }
```

- `held: false` when the account holds no such position → panel renders nothing.
- `facts` always present when held; `explainer` may be `null` (LLM down) and the
  client renders the deterministic fallback.

### 2. New shared lib — `api/_lib/position-coach.ts`

Pure, testable helpers (mirrors `ai-summary.ts` structure):

```
buildPositionFacts(position, snapshot, strategyState, wheelState, now): PositionFacts
buildCoachPrompt(facts): string         // the user prompt fed to the model
deterministicReadout(facts): string     // Layer-1-only fallback text
```

Keeping these pure means the P/L math, the ladder-rung accounting, and the
fallback wording are all unit-tested without hitting Alpaca, KV, or Anthropic.

### 3. New client panel — `src/components/lookup/PositionCoachPanel.tsx`

- Queries `position-coach` for the current symbol + selected account.
- Renders nothing when `held === false` (no empty box on un-held symbols).
- Shows the explainer prose (or the deterministic readout when `explainer` is
  null), a compact facts strip (qty · avg cost · P/L · stop · stage), and the
  "Not financial advice" footer.
- A `live` position gets a small real-money tag so the user always knows which
  account they're reading.

### 4. Cache

KV cache keyed by a **signature** so it regenerates only when something material
changed, not on a clock:

```
sig = symbol | mode | qty | avg_cost | stop_price | wheel_stage | round(current_price)
```

`current_price` is rounded (e.g. to the dime) so intraday ticks don't bust the
cache every second, but a real move still refreshes the explainer. `refresh=1`
forces regeneration (same as the AI summary's manual refresh button). TTL ~15 min
as an upper bound regardless of signature.

## Edge cases

- **Symbol not held in the selected account** → `held:false`, panel hidden.
- **Held but bot hasn't run it yet** (no KV strategy state) → bot-plan fields
  null; explainer covers position + general risk only, no fabricated stop.
- **Excluded symbol** (in `excluded_symbols`) → fact `is_excluded:true`; explainer
  notes the bot is set to leave this one alone.
- **Live (real money)** → explicit real-money framing in the panel tag; same
  no-advice rules (no relaxation for live).
- **Option / spread position** (v1) → minimal factual line ("You hold 1 SNAP
  $5 put expiring 7/18"); rich wheel-stage explainer deferred to v2.
- **LLM failure / timeout** → deterministic readout renders; no error surfaced to
  the user beyond the facts being slightly terser.
- **Account selector = a group/All** → resolve to the single account that holds
  the symbol; if multiple hold it, show one panel per holding account (or, v1,
  just the first/primary). Decide at build time.

## Phasing

- **v1** — stock positions, full hybrid (facts + explainer), deterministic
  fallback, no-advice guardrail, disclaimer, cache. Option/spread positions get
  the one-line factual stub.
- **v2** — full options/wheel explainer (stage, assignment mechanics, covered-call
  context), and the multi-account-holding case if it matters in practice.

## Testing

- `buildPositionFacts`: P/L sign + pct math; ladder-rung remaining count from
  `ladder_done[]`; null bot-state degradation; excluded flag; live flag.
- `buildCoachPrompt`: includes the real numbers; contains the no-advice
  instruction block.
- `deterministicReadout`: renders coherent text with and without bot-state.
- Panel: hidden when `held:false`; renders fallback when `explainer:null`; shows
  live tag for live mode.

## Open questions (confirm before build)

1. **v1 scope** — stock-only with an options stub (recommended), or include the
   full options explainer in v1?
2. **Multi-account holding** — when a group/All selection holds the symbol in both
   manual and live, one panel (primary) or one per account?
3. **Cache granularity** — round `current_price` to the dime (recommended) vs. not
   caching on price at all (regenerate only on qty/avg_cost/stop/stage change)?
4. **Placement** — directly under the AI summary on `/lookup` (recommended), or as
   its own section lower on the page?
