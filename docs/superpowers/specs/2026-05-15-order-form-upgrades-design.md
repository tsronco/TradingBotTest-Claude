# Order Form Upgrades — Design

> **Standalone dashboard effort.** Builds on `claude/mobile-dashboard` (branched from its HEAD so the order forms keep their responsive layout and don't conflict). Four independent, individually-shippable features for the trading dashboard's order surface.

**Status:** Design (companion plan: `docs/superpowers/plans/2026-05-15-order-form-upgrades.md`).

## Goal

Bring the order-entry experience up to the polish bar of the rest of the dashboard and add the decision-support Tim actually wants when trading from the cab:

1. **Spread form chip parity** — the put-credit-spread form is all `<select>` dropdowns and looks unfinished next to the chip-based stock/option forms. Make it consistent.
2. **Interactive P/L payoff chart** — every order form (stock, option, spread) gets a Robinhood-style payoff diagram with max-profit / breakeven / max-loss and a **draggable scrubber** showing P/L at any underlying price. Updates live as the user changes inputs.
3. **Options-chain live spot slider** — the chain on `/lookup/:symbol` gets a "share price" divider that sits between the bracketing strikes and **moves as the underlying ticks**, so you never lose your place.
4. **Suggested limit price helper** — instead of a Robinhood-style opaque "fill likelihood" badge, a **transparent tap-to-apply price helper** (Fast / Balanced / Best price) computed from live bid/ask/spread/liquidity, so Tim stops hand-modifying limit prices to find the midpoint.

Terminal aesthetic preserved throughout (monospace, `pbtn` chips, green phosphor). Frontend + CSS + pure-TS only — **no API, no data-model, no new Vercel function, no bot change.**

## Why these, why now

Tim trades manual/live by hand from a phone. The forms are the highest-friction surface: the spread form looks half-built, there's no payoff visualization anywhere, and he repeatedly re-modifies limit prices (e.g. the Ford put: $0.08 → $0.07 → $0.05 before fill) because nothing tells him where the fillable price is. These four close that gap. They're sequenced so earlier phases lay the data plumbing the later ones reuse (the payoff chart and the fill helper both need live bid/ask/mid on the forms).

## Non-goals (explicitly out of scope)

- **Cloning Robinhood's ML "fill likelihood."** It's a proprietary model trained on their private order/fill data. We build a transparent deterministic heuristic instead and label it as such. Decided with Tim 2026-05-15.
- **A general multi-leg strategy builder.** The forms produce exactly three order shapes: stock, single option, put-credit spread. The payoff engine supports exactly those. No iron condors, no covered-call builder UI (covered calls are wheel-bot-managed, not hand-entered here).
- **Order-mutation / submission changes.** The chart and the fill helper are display-only. The spread cleanup is UI-only except adding a `tags` field to the spread draft (parity with the stock form). No change to `/api/trades/submit` semantics, rule-checking, TOTP gating, or live-account guards.
- **Replacing the expiration / strike pickers with chips.** 25+ expirations and dozens of strikes are data-driven lists; chips don't scale and Robinhood itself uses pickers there. Those stay `<select>`. This is a deliberate decision, not an unfinished edge — see Phase 1.
- **lightweight-charts for the payoff diagram.** lightweight-charts is a time-series library; a payoff curve is P/L-vs-price with a custom drag interaction. We hand-roll an SVG (precedent: `EquityChart.tsx`).
- **Empirical fill model from `modify_history`.** Noted as the future evolution path for the fill helper; not built in this effort.
- **Pixel-perfect visual regression / drag automation tests.** jsdom has no layout engine and synthetic pointer drag is approximate. Pure math is exhaustively unit-tested; component state is asserted in vitest; visual/drag correctness is a manual device pass (like the mobile effort's E2).

## The four features in detail

### Phase 1 — Spread form chip parity

`SpreadOrderForm.tsx` currently renders **account, grade as `<select>`**, has **no tags field**, and uses `<textarea>` for reasoning. `StockOrderForm.tsx` renders account/side/type/tif/grade as inline `pbtn` chips (`globals.css:115`) and has a tags chip picker.

**Convert to chip parity, mirroring the existing inline `pbtn` pattern (no new shared component — the codebase deliberately renders chips inline; follow that convention):**

| Field | Today (spread) | After |
|---|---|---|
| Account | `<select>` | `pbtn` chip row: `conservative_paper` / `aggressive_paper` / `manual_paper` / `live` — `live` chip **disabled with tooltip** (preserves the existing Phase-4 spread rule that live spreads are bot-only) |
| Entry Grade | `<select>` | `pbtn` chip row `A+ … F` (identical to `StockOrderForm`) |
| Tags | *(absent)* | tag chip picker identical to `StockOrderForm`; `tags` added to the spread draft payload |
| Expiration | `<select>` | **unchanged** — data-driven list, stays a `<select>` (deliberate) |
| Short / Long Strike | `<select>` | **unchanged** — data-driven list, stays a `<select>` (deliberate) |
| Qty, Limit Credit | number inputs | unchanged (visual style already matches) |
| Reasoning | `<textarea>` | unchanged (matches stock form) |

Net: the spread form looks like the stock form for every field where chips make sense, and gains the missing tags affordance. Submission payload gains `tags: string[]` (the submit endpoint already stores tags for stock/option trades; spread trades just weren't sending them).

### Phase 2 — Interactive P/L payoff chart

**Pure engine — `dashboard/src/lib/payoff.ts`.** Leg-based, not per-named-strategy (cleaner and matches what the forms produce). All P/L in account dollars (per-share × 100 for options × qty).

Leg primitives (per share, at expiration, underlying price `S`):

- **Stock leg**, entry `E`, direction `d`:
  - long: `S − E`
  - short: `E − S`
- **Option leg**, type `t∈{call,put}`, direction `d∈{long,short}`, strike `K`, premium `P` (price paid/received per share):
  - long call: `max(S − K, 0) − P`
  - short call: `P − max(S − K, 0)`
  - long put: `max(K − S, 0) − P`
  - short put: `P − max(K − S, 0)`

Order → legs:

- **Stock order**: one stock leg. `buy` → long `E = limit/mid`; `sell_short` → short. (`sell` of an existing long is a position close — payoff diagram suppressed; see Phase 2 task notes.)
- **Single option order**: one option leg. `BTO` → long, `STO` → short; type/strike from the OCC contract; `P` = limit price (or live mid for market).
- **Put-credit spread**: short put leg at `Kshort` + long put leg at `Klong` (`Klong < Kshort`); premiums = each leg's live mid; net credit `C = Pshort − Plong` = the user's Limit Credit input.

`buildPayoff(legs, qty, currentPrice)` → `PayoffResult`:

```ts
interface PayoffResult {
  points: { price: number; pl: number }[];   // sampled curve over the price window
  maxProfit: number | null;                  // null = unbounded (e.g. long stock upside)
  maxLoss: number | null;                    // null = unbounded (e.g. naked short call)
  breakevens: number[];                      // ascending
  currentPrice: number;
  window: { lo: number; hi: number };
}
```

- **Window**: strike-aware. For options/spreads: span the strikes ± a margin (≈ 1.5× the widest strike-to-spot distance, min ±8% of spot). For stock: spot ±25%. Always include `currentPrice`.
- **Sampling**: piecewise-linear; sample at every strike, every breakeven, the window ends, and `currentPrice`, plus enough intermediate points (≥ 64) for a smooth line. Because every supported payoff is piecewise-linear with ≤3 segments, `maxProfit`/`maxLoss`/`breakevens` are computed **closed-form per supported order kind** (exact, not curve-scanned):
  - **Short put / CSP** (strike `K`, credit `C`, qty `q`): maxProfit `= C·100·q`; maxLoss `= −(K−C)·100·q`; breakeven `= K − C`.
  - **Long put** (`K`, debit `P`): maxProfit `= (K−P)·100·q`; maxLoss `= −P·100·q`; breakeven `= K − P`.
  - **Long call** (`K`, debit `P`): maxProfit `= null`; maxLoss `= −P·100·q`; breakeven `= K + P`.
  - **Short call** (`K`, credit `P`): maxProfit `= P·100·q`; maxLoss `= null`; breakeven `= K + P`.
  - **Put-credit spread** (short `Ks`, long `Kl`, credit `C`, qty `q`): maxProfit `= C·100·q`; maxLoss `= −((Ks−Kl) − C)·100·q`; breakeven `= Ks − C`.
  - **Long stock** (`E`, qty `n` shares): maxProfit `= null`; maxLoss `= −E·n`; breakeven `= E`.
  - **Short stock** (`E`, `n`): maxProfit `= E·n`; maxLoss `= null`; breakeven `= E`.

**Component — `dashboard/src/components/order/PayoffChart.tsx`** (hand-rolled SVG, EquityChart precedent):

- X = underlying price across `window`; Y = P/L. Emphasized `pl = 0` axis.
- Payoff polyline, **green where pl ≥ 0, red where pl < 0** (two-segment colouring like Robinhood).
- Static markers: vertical line at `currentPrice` ("now"), dotted verticals at each breakeven, tick marks at each strike.
- **Draggable scrubber**: a vertical handle the user drags along X via **Pointer Events** (`pointerdown`/`pointermove`/`pointerup`/`pointercancel` — one path for mouse + touch). Clamped to `window`. Default position = `currentPrice`. Arrow-key nudge for a11y; the SVG handle has `role="slider"`, `aria-valuemin/max/now`, `aria-label="P/L at underlying price"`.
- Live readout (updates on drag): **"Underlying at exp: $X"** and **"P/L: $Y"** (Y coloured by sign), formatted via `lib/format.ts` (`fmtUsd`).
- Stat strip: **Max profit · Breakeven · Max loss** from `PayoffResult` (unbounded → `∞` / `−∞`), `fmtUsd`.
- Mobile: full-width, height `200 max-md:170`; the scrubber handle has a ≥44px touch target (invisible padded hitbox around the visual line).

**Wiring:** each form derives its leg(s) from current state and renders `<PayoffChart>` reactively, so changing qty / limit / strike redraws immediately (mirrors Robinhood). The premium/credit used is the user's limit input; if order type is `market`, fall back to live mid.

### Phase 3 — Options-chain live spot slider

`OptionsChain.tsx` sorts strikes ascending and already fetches the underlying spot (`snap?.latestTrade?.p ?? snap?.dailyBar?.c`) but never shows it in the ladder.

- Insert a **spot divider row** into the rendered strike list at the correct rung: between `strike[i]` and `strike[i+1]` where `strike[i] ≤ spot < strike[i+1]`. Full-width within the `.chain-scroll` container (spans all columns; does not break the horizontal-scroll mobile exception). Style: highlighted band, monospace, `Share price: $X.XX` — terminal-styled, not Robinhood pink.
- **Make it live:** the quote query in `OptionsChain` currently has no refetch interval. Add `refetchInterval: 5000` (matches the order-form quote cadence) **only while the chain panel is mounted/visible**. On each refetch the divider re-inserts at the new rung — it "slides" between strikes as price moves. A short CSS transition softens the jump.
- Default visible-strike window already centers on spot — unchanged.

### Phase 4 — Suggested limit price helper

**Pure engine — `dashboard/src/lib/fillHint.ts`:**

```ts
interface FillHintInput {
  side: 'buy' | 'sell';      // net direction: pay debit vs collect credit
  bid: number;
  ask: number;
  last?: number;
  oi?: number;               // open interest (options)
  volume?: number;           // daily volume
  tick?: number;             // price increment; default 0.01
}
interface FillHintTier { price: number; label: string; note: string }
interface FillHint {
  bid: number; mid: number; ask: number;
  fast: FillHintTier;        // cross the spread — near-instant
  balanced: FillHintTier;    // mid — fair, usually fills
  patient: FillHintTier;     // toward the far side — best price, lower odds
  confidence: string;        // one-line plain-English shading
}
```

Logic (deterministic, transparent — round all prices to `tick`):

- `mid = round((bid + ask) / 2)`
- **sell** (collect credit, want a high price): `fast = bid`, `balanced = mid`, `patient = min(round(mid + step), ask − tick)`
- **buy** (pay debit, want a low price): `fast = ask`, `balanced = mid`, `patient = max(round(mid − step), bid + tick)`
- `step = max(tick, round((ask − bid) / 4))` (concession size scales with spread width)
- **confidence** from relative spread `r = (ask − bid) / mid` and liquidity `liq = (oi ?? 0) ≥ 250 || (volume ?? 0) ≥ 250`:
  - `r ≤ 0.03 && liq` → "Tight spread, liquid — mid usually fills."
  - `r ≤ 0.03 && !liq` → "Tight spread but thin — mid likely, may need a tick."
  - `r > 0.08` → "Wide spread — expect to concede toward the {bid|ask}."
  - else → "Moderate spread — mid is a reasonable start."
- Degrade gracefully: if `bid`/`ask` missing or `bid ≥ ask` (crossed/stale) → return a `null`-flagged hint; UI shows "no live quote — can't suggest."

**Component — `dashboard/src/components/order/FillHint.tsx`:** compact block above the limit-price input. Renders live `Bid · Mid · Ask`, three **tappable `pbtn` chips** — `[fast $X]` `[balanced $Y]` `[best $Z]` — and the one-line confidence note + a muted "estimate, not a guarantee" caption. Tapping a chip calls a `onPick(price)` prop that sets the form's limit field. Reuses the existing `pbtn` styling for visual consistency with Phase 1.

**Wiring:** stock, option, and spread forms render `<FillHint>` fed by their live quote (`{bp, ap}` from the existing quote/chain query; for spreads the "quote" is the net `shortMid − longMid` against the spread's combined bid/ask). `onPick` writes the limit-price / limit-credit state already in each form.

Future (documented, not built): `modify_history` on filled trades is our own empirical fill record; a later iteration can blend "on your actual fills, mid filled N% within M min" into `confidence`.

## Architecture / file structure

Pure TS + React + CSS only. No `dashboard/api/**` change. No new Vercel function (stays 10/12 Hobby). No bot/`config.py`/workflow change.

### New files

| File | Responsibility |
|---|---|
| `dashboard/src/lib/payoff.ts` | Pure leg/payoff engine — `optionLegPL`, `stockLegPL`, `buildPayoff`, closed-form extrema. No React. |
| `dashboard/src/lib/fillHint.ts` | Pure suggested-price engine — `computeFillHint(input) → FillHint | null`. No React. |
| `dashboard/src/components/order/PayoffChart.tsx` | SVG payoff diagram + draggable Pointer-Events scrubber + stat strip. |
| `dashboard/src/components/order/FillHint.tsx` | Bid/Mid/Ask + 3 tappable suggestion chips + confidence note. |
| `dashboard/tests/lib/payoff.test.ts` | Exhaustive unit tests for every leg type + closed-form extrema. |
| `dashboard/tests/lib/fillHint.test.ts` | Unit tests for buy/sell tiers, spread/liquidity confidence, degraded input. |
| `dashboard/tests/components/PayoffChart.test.tsx` | Renders curve/markers; scrubber pointer-drag updates readout; a11y attrs. |
| `dashboard/tests/components/FillHint.test.tsx` | Renders tiers; tap fires `onPick`; degraded-quote message. |

### Modified files

| File | Phase(s) | Change |
|---|---|---|
| `dashboard/src/components/order/SpreadOrderForm.tsx` | 1, 2, 4 | account/grade → `pbtn` chips; add tags chip picker + `tags` in draft; render `<PayoffChart>`; render `<FillHint>`. |
| `dashboard/src/components/order/StockOrderForm.tsx` | 2, 4 | render `<PayoffChart>`; render `<FillHint>`. |
| `dashboard/src/components/order/OptionOrderForm.tsx` | 2, 4 | render `<PayoffChart>`; render `<FillHint>`. |
| `dashboard/src/components/lookup/OptionsChain.tsx` | 3 | spot-divider row in the strike ladder; add visible-only `refetchInterval` to the quote query. |
| `dashboard/tests/components/SpreadOrderForm.test.tsx` | 1 | update assertions for chip markup (label→role/text); add tags + payoff/hint presence. Not weakened. |
| `dashboard/src/styles/globals.css` | 2, 3 | payoff scrubber hitbox / handle styles; spot-divider band + slide transition. All additive. |

### No-touch (verify only)

- `dashboard/api/**` — unchanged. Vercel function count unchanged at 10/12.
- `dashboard/api/_lib/trade-types.ts` — `SpreadDetails` already exists; spread draft simply also sends `tags` (already a `Trade` field).
- Bot code, workflows, `config.py`, state files — untouched. Zero trading-account risk.

## Testing strategy

- **Pure libs (`payoff.ts`, `fillHint.ts`): strict TDD, exhaustive.** Deterministic math — failing test first, then implementation, every leg type and every closed-form extremum, edge cases (zero credit, breakeven exactly at strike, crossed quote). This is the correctness core.
- **Components:** mirror the existing pattern (`dashboard/tests/setup.ts`, global `fetch` mock returning `Response(JSON)`, RTL `render`/`screen`/`fireEvent`, payload capture via `init.body`). Scrubber drag tested with synthetic `pointerdown/move/up` asserting the readout text changes. Chain slider tested by mocking the quote and asserting the divider row renders between the expected strike rows, and that changing the mocked spot moves it.
- **No-regression gate:** full `npx vitest run --pool=threads` stays green (baseline 395; net new tests added). Phase 1 legitimately changes `SpreadOrderForm` markup → its existing tests get updated (label-query → role/text query) — updated, never weakened.
- **Typecheck gate:** `npx tsc -p tsconfig.app.json --noEmit` zero errors. Respect `erasableSyntaxOnly` (no enums/namespaces/param-properties — union string-literal types + explicit fields).
- **Manual device pass (the real visual/drag validation):** production, real phone, like the mobile effort's E2 — scrubber drag on touch, chart redraw on input change, chain divider sliding as SPY ticks, tap-to-apply writing the limit field.

## Rollout

1. Branch `claude/order-form-upgrades` (already created off `claude/mobile-dashboard` HEAD).
2. Implement phase-by-phase; each phase is independently shippable and leaves `npm test` green.
3. Per phase or at end: deploy `cd dashboard && npx vercel link --yes --project tradingbot-dashboard` (worktree gotcha) then `npx vercel --prod`.
4. Manual device checklist on production.
5. Update `CLAUDE.md` dashboard section + test-count bump.
6. Branch is **not pushed and no PR opened** unless Tim asks (matches mobile-effort handling).

## Open decisions / accepted compromises

- **Branch base.** RESOLVED 2026-05-15: Tim chose to merge mobile to `main` first (PR #18, merged) and rebase this branch onto fresh `main`. `claude/order-form-upgrades` is now `main` + the plan docs only; mobile is no longer a stacked dependency. The forms here already carry the mobile responsive treatment (it's in `main`).
- **Fill helper is heuristic, not ML.** Accepted with Tim 2026-05-15. Transparent and labelled "estimate."
- **Expiration/strike stay `<select>`.** Deliberate; chips don't scale to data-driven lists.
- **`sell`-to-close stock orders show no payoff diagram.** A position-closing sell has no forward payoff shape; the chart is suppressed with a one-line note rather than drawn misleadingly.
- **Scrubber/visual correctness is manual-tested.** jsdom can't lay out SVG or truly drag; unit tests cover state, a person covers the feel.
- **Options tick approximated at $0.01.** Real OPRA ticks vary ($0.01 < $3, $0.05 ≥ $3). The helper rounds to $0.01 by default (documented approximation; a `tick` input allows refinement later).
