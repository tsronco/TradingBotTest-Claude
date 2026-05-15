# Order Form Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the order forms to chip-parity, add an interactive P/L payoff chart with a draggable scrubber to every form, add a live spot-price slider to the options chain, and add a transparent tap-to-apply suggested-limit-price helper.

**Architecture:** Two pure TS engines (`payoff.ts`, `fillHint.ts`) unit-tested with strict TDD, consumed by two new SVG/JSX components (`PayoffChart`, `FillHint`) wired into the three order forms; one self-contained enhancement to `OptionsChain`. Frontend + CSS + pure-TS only — no API, data-model, Vercel-function, or bot change.

**Tech Stack:** Vite · React 19 · TypeScript (`erasableSyntaxOnly`: no enums/namespaces/param-properties) · Tailwind v4 · React Router · @tanstack/react-query · vitest + jsdom · hand-rolled SVG (EquityChart precedent).

**Spec:** [2026-05-15-order-form-upgrades-design.md](docs/superpowers/specs/2026-05-15-order-form-upgrades-design.md)

**Branch:** `claude/order-form-upgrades` (off `claude/mobile-dashboard` HEAD)

**Test command (sandbox):** `npx vitest run --pool=threads` from `dashboard/` (`npm test`'s default forks pool times out in this sandbox). Typecheck: `npx tsc -p tsconfig.app.json --noEmit`. Baseline before this work: **395 vitest green, 0 tsc errors** — keep green after every task.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `dashboard/src/lib/payoff.ts` | Create | Pure leg/payoff engine: `stockLegPL`, `optionLegPL`, `legPL`, `totalPL`, `buildPayoff`. No React. |
| `dashboard/tests/lib/payoff.test.ts` | Create | Exhaustive unit tests (every leg type + closed-form extrema + breakevens). |
| `dashboard/src/lib/fillHint.ts` | Create | Pure `computeFillHint(input) → FillHint \| null`. No React. |
| `dashboard/tests/lib/fillHint.test.ts` | Create | Buy/sell tiers, spread/liquidity confidence, degraded-quote → null. |
| `dashboard/src/components/order/PayoffChart.tsx` | Create | SVG payoff curve + breakeven/strike/now markers + draggable Pointer-Events scrubber + Max/BE/Loss strip. |
| `dashboard/tests/components/PayoffChart.test.tsx` | Create | Renders curve/markers; pointer-drag updates readout; a11y slider attrs. |
| `dashboard/src/components/order/FillHint.tsx` | Create | Bid·Mid·Ask + 3 tappable `pbtn` chips + confidence note; `onPick(price)`. |
| `dashboard/tests/components/FillHint.test.tsx` | Create | Renders tiers; tap → `onPick`; degraded quote → message. |
| `dashboard/src/components/order/SpreadOrderForm.tsx` | Modify | P1: account/grade → `pbtn` chips, add tags + `tags` in draft. P2: `<PayoffChart>`. P4: `<FillHint>`. |
| `dashboard/src/components/order/StockOrderForm.tsx` | Modify | P2: `<PayoffChart>`. P4: `<FillHint>`. |
| `dashboard/src/components/order/OptionOrderForm.tsx` | Modify | P2: `<PayoffChart>`. P4: `<FillHint>`. |
| `dashboard/src/components/lookup/OptionsChain.tsx` | Modify | P3: spot-divider row + visible-only `refetchInterval`. |
| `dashboard/src/styles/globals.css` | Modify | P2 scrubber hitbox/handle; P3 spot-divider band + slide transition. Additive only. |
| `dashboard/tests/components/SpreadOrderForm.test.tsx` | Modify | P1: chip-markup assertions (not weakened); tags + payoff/hint presence. |

**No new Vercel functions. No `dashboard/api/**` change. No bot/workflow/`config.py` change.**

---

## Phase 1 — Spread form chip parity (isolated polish, no new engine)

### Task 1.1: Capture the stock-form chip pattern

**Files:** Read `dashboard/src/components/order/StockOrderForm.tsx` (account chips ~117–144, grade chips ~148–156, tags picker), `dashboard/src/styles/globals.css:115` (`.pbtn`).

- [ ] **Step 1: Read & note the exact pattern.** No code change. Record: the account-chip array + render, the grade-letter array (`A+ A A- B+ B B- C+ C C- D F`) + render, the tag-picker markup and the `tags` state shape, and how `live` is disabled on the stock account chip. The spread form must mirror these verbatim (same classNames, same `[label*]` active-star convention).

- [ ] **Step 2: Read the spread form + its test.** `dashboard/src/components/order/SpreadOrderForm.tsx` (account/grade `<select>` ~178–217 & ~303–315; draft payload ~142–162) and `dashboard/tests/components/SpreadOrderForm.test.tsx` (label-based queries). Note every assertion that queries `getByLabelText(/account|grade/i)` — these change in 1.3.

### Task 1.2: Account & grade → `pbtn` chips; add tags

**Files:** Modify `dashboard/src/components/order/SpreadOrderForm.tsx`

- [ ] **Step 1: Replace the account `<select>`** with a `pbtn` chip row identical in markup to `StockOrderForm`'s account chips: chips for `conservative_paper`, `aggressive_paper`, `manual_paper`, `live`. The `live` chip gets `disabled` + `title="Live spreads are bot-managed"` (preserve the existing rule that live spreads aren't hand-entered). Wire each chip's `onClick` to the existing `setAccount`. Use the existing active-state convention (`pbtn ${account===v?'active':''}`, label `[value*]` when active) exactly as the stock form does.

- [ ] **Step 2: Replace the grade `<select>`** with the same `A+ … F` `pbtn` chip row the stock form uses, bound to the existing `grade` state setter. Keep the empty/unset state valid (no grade selected = no active chip), matching stock-form behavior.

- [ ] **Step 3: Add a tags picker** identical to the stock form's: same tag-source, same chip markup, same `tags` state array. Place it in the same position relative to reasoning as the stock form.

- [ ] **Step 4: Add `tags` to the spread draft.** In the draft payload object (~142–162) add `tags` alongside `entry_grade`/`entry_reasoning`. (`tags` is already a `Trade` field and the submit endpoint stores it for stock/option; spread simply wasn't sending it. No API change.)

- [ ] **Step 5: Leave Expiration / Short Strike / Long Strike as `<select>`.** Deliberate (data-driven lists). Do not convert. Add a one-line code comment above the expiration `<select>`: `{/* data-driven list — intentionally a select, not chips (see order-form-upgrades spec) */}`.

- [ ] **Step 6: Typecheck.** `cd dashboard && npx tsc -p tsconfig.app.json --noEmit` → 0 errors.

### Task 1.3: Update the spread-form test for chip markup

**Files:** Modify `dashboard/tests/components/SpreadOrderForm.test.tsx`

- [ ] **Step 1: Run it to see what breaks.** `cd dashboard && npx vitest run --pool=threads tests/components/SpreadOrderForm.test.tsx`. Expect failures on `getByLabelText(/account|grade/i)` (now chips, not labelled selects).

- [ ] **Step 2: Migrate those queries** from `getByLabelText` to role/text: account/grade selection becomes `fireEvent.click(screen.getByRole('button', { name: /manual_paper/i }))` etc. Keep every behavioral assertion (the captured submit body still must have `account`, `entry_grade`, and now `tags`). Add one assertion that the draft body includes `tags` (e.g. select a tag chip, assert `capturedBody.tags` contains it). **Do not weaken** the existing payload assertions (`kind==='spread'`, `limit_price < 0`, legs present).

- [ ] **Step 3: Green.** `npx vitest run --pool=threads tests/components/SpreadOrderForm.test.tsx` passes.

- [ ] **Step 4: Full no-regression.** `npx vitest run --pool=threads` → all green (395 + any net change here only). `npx tsc -p tsconfig.app.json --noEmit` → 0.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/components/order/SpreadOrderForm.tsx dashboard/tests/components/SpreadOrderForm.test.tsx
git commit -m "order-form(P1): spread form chip parity (account/grade chips + tags)"
```

---

## Phase 2 — Interactive P/L payoff chart

### Task 2.1: Payoff engine — types + leg primitives (TDD)

**Files:** Create `dashboard/src/lib/payoff.ts`, `dashboard/tests/lib/payoff.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// dashboard/tests/lib/payoff.test.ts
import { describe, it, expect } from 'vitest';
import { stockLegPL, optionLegPL, totalPL, buildPayoff, type Leg } from '../../src/lib/payoff';

describe('leg primitives', () => {
  it('long stock P/L is linear', () => {
    expect(stockLegPL(110, { kind: 'stock', dir: 'long', entry: 100, shares: 10 })).toBe(100);
    expect(stockLegPL(90, { kind: 'stock', dir: 'long', entry: 100, shares: 10 })).toBe(-100);
  });
  it('short stock P/L inverts', () => {
    expect(stockLegPL(90, { kind: 'stock', dir: 'short', entry: 100, shares: 10 })).toBe(100);
  });
  it('short put (CSP) pays the credit above strike, loses below', () => {
    const leg: Leg = { kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 };
    expect(optionLegPL(105, leg)).toBe(200);          // credit kept, ×100
    expect(optionLegPL(100, leg)).toBe(200);          // at strike
    expect(optionLegPL(90, leg)).toBe(2 * 100 - 10 * 100); // (2 - 10)*100 = -800
  });
  it('long call P/L', () => {
    const leg: Leg = { kind: 'option', dir: 'long', type: 'call', strike: 100, premium: 3, contracts: 2 };
    expect(optionLegPL(100, leg)).toBe(-3 * 100 * 2); // -600
    expect(optionLegPL(110, leg)).toBe((10 - 3) * 100 * 2); // 1400
  });
  it('totalPL sums legs', () => {
    const legs: Leg[] = [
      { kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 3, contracts: 1 },
      { kind: 'option', dir: 'long', type: 'put', strike: 95, premium: 1, contracts: 1 },
    ];
    expect(totalPL(120, legs)).toBe((3 - 1) * 100); // both OTM: net credit 2 ×100 = 200
  });
});
```

- [ ] **Step 2: Run → FAIL** (`payoff` not found). `npx vitest run --pool=threads tests/lib/payoff.test.ts`.

- [ ] **Step 3: Implement `payoff.ts` primitives.**

```ts
// dashboard/src/lib/payoff.ts
export type LegDir = 'long' | 'short';
export type OptionType = 'call' | 'put';

export interface StockLeg { kind: 'stock'; dir: LegDir; entry: number; shares: number; }
export interface OptionLeg {
  kind: 'option'; dir: LegDir; type: OptionType; strike: number; premium: number; contracts: number;
}
export type Leg = StockLeg | OptionLeg;

export interface PayoffResult {
  points: { price: number; pl: number }[];
  maxProfit: number | null;   // null = unbounded
  maxLoss: number | null;     // null = unbounded
  breakevens: number[];       // ascending, rounded to cents
  currentPrice: number;
  window: { lo: number; hi: number };
}

const MULT = 100;

export function stockLegPL(s: number, leg: StockLeg): number {
  const per = leg.dir === 'long' ? s - leg.entry : leg.entry - s;
  return per * leg.shares;
}

export function optionLegPL(s: number, leg: OptionLeg): number {
  const intrinsic = leg.type === 'call' ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0);
  const per = leg.dir === 'long' ? intrinsic - leg.premium : leg.premium - intrinsic;
  return per * MULT * leg.contracts;
}

export function legPL(s: number, leg: Leg): number {
  return leg.kind === 'stock' ? stockLegPL(s, leg) : optionLegPL(s, leg);
}

export function totalPL(s: number, legs: Leg[]): number {
  return legs.reduce((acc, l) => acc + legPL(s, l), 0);
}
```

- [ ] **Step 4: Run → PASS** for the `describe('leg primitives')` block.

### Task 2.2: `buildPayoff` — window, sampling, closed-form extrema, breakevens (TDD)

**Files:** Modify `dashboard/src/lib/payoff.ts`, `dashboard/tests/lib/payoff.test.ts`

- [ ] **Step 1: Add failing tests** (append to the test file):

```ts
describe('buildPayoff', () => {
  it('CSP: short $100 put, $2 credit, 1 contract', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 }], 101);
    expect(r.maxProfit).toBe(200);
    expect(r.maxLoss).toBe(-(100 - 2) * 100); // -9800
    expect(r.breakevens).toEqual([98]);
    expect(r.window.lo).toBeLessThanOrEqual(101);
    expect(r.window.hi).toBeGreaterThanOrEqual(101);
    expect(r.points.length).toBeGreaterThan(64);
  });
  it('put credit spread: short 100 / long 95, $2 net credit', () => {
    const r = buildPayoff([
      { kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 3, contracts: 1 },
      { kind: 'option', dir: 'long', type: 'put', strike: 95, premium: 1, contracts: 1 },
    ], 102);
    expect(r.maxProfit).toBe(200);                 // credit 2 ×100
    expect(r.maxLoss).toBe(-((100 - 95) - 2) * 100); // -(width-credit)*100 = -300
    expect(r.breakevens).toEqual([98]);            // Ks - credit
  });
  it('long call: unbounded upside', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'long', type: 'call', strike: 100, premium: 3, contracts: 1 }], 100);
    expect(r.maxProfit).toBeNull();
    expect(r.maxLoss).toBe(-300);
    expect(r.breakevens).toEqual([103]);
  });
  it('long stock: maxLoss bounded at 0 price, upside unbounded', () => {
    const r = buildPayoff([{ kind: 'stock', dir: 'long', entry: 50, shares: 10 }], 50);
    expect(r.maxProfit).toBeNull();
    expect(r.maxLoss).toBe(-500);
    expect(r.breakevens).toEqual([50]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`buildPayoff` not defined).

- [ ] **Step 3: Implement `buildPayoff`** (append to `payoff.ts`):

```ts
export function buildPayoff(legs: Leg[], currentPrice: number, samples = 96): PayoffResult {
  const strikes = legs.filter((l): l is OptionLeg => l.kind === 'option').map((l) => l.strike);
  const refs = strikes.length ? strikes : [currentPrice];
  const maxRef = Math.max(currentPrice, ...refs);
  const minRef = Math.min(currentPrice, ...refs);
  const span = Math.max(maxRef - minRef, currentPrice * 0.08);
  let lo = Math.max(0, minRef - span * 1.5);
  let hi = maxRef + span * 1.5;
  if (legs.every((l) => l.kind === 'stock')) {
    lo = Math.max(0, currentPrice * 0.75);
    hi = currentPrice * 1.25;
  }
  lo = Math.min(lo, currentPrice);
  hi = Math.max(hi, currentPrice);

  const points: { price: number; pl: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const price = lo + ((hi - lo) * i) / samples;
    points.push({ price, pl: totalPL(price, legs) });
  }
  for (const k of [0, ...strikes, currentPrice]) {
    if (k >= lo && k <= hi) points.push({ price: k, pl: totalPL(k, legs) });
  }
  points.sort((a, b) => a.price - b.price);

  const top = (strikes.length ? Math.max(...strikes) : currentPrice) + 1;
  const rightSlope = totalPL(top + 1, legs) - totalPL(top, legs);
  const candidates = [0, ...strikes].filter((x) => x >= 0).map((s) => totalPL(s, legs));

  let maxProfit: number | null;
  let maxLoss: number | null;
  if (rightSlope > 1e-9) {
    maxProfit = null;
    maxLoss = Math.min(...candidates);
  } else if (rightSlope < -1e-9) {
    maxLoss = null;
    maxProfit = Math.max(...candidates);
  } else {
    maxProfit = Math.max(...candidates);
    maxLoss = Math.min(...candidates);
  }

  const xs = Array.from(new Set([0, ...strikes, top * 2])).sort((a, b) => a - b);
  const bes: number[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    const fa = totalPL(a, legs);
    const fb = totalPL(b, legs);
    if (fa === 0) bes.push(a);
    else if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) bes.push(a + (fa / (fa - fb)) * (b - a));
  }
  const breakevens = Array.from(new Set(bes.map((x) => Math.round(x * 100) / 100))).sort((a, b) => a - b);

  return { points, maxProfit, maxLoss, breakevens, currentPrice, window: { lo, hi } };
}
```

- [ ] **Step 4: Run → PASS** all of `payoff.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/lib/payoff.ts dashboard/tests/lib/payoff.test.ts
git commit -m "order-form(P2): pure payoff engine with closed-form extrema"
```

### Task 2.3: `PayoffChart` component — SVG + scrubber (TDD)

**Files:** Create `dashboard/src/components/order/PayoffChart.tsx`, `dashboard/tests/components/PayoffChart.test.tsx`; modify `dashboard/src/styles/globals.css`

- [ ] **Step 1: Write the failing test.**

```tsx
// dashboard/tests/components/PayoffChart.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PayoffChart from '../../src/components/order/PayoffChart';
import type { Leg } from '../../src/lib/payoff';

const csp: Leg[] = [{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 }];

describe('PayoffChart', () => {
  it('renders the stat strip from buildPayoff', () => {
    render(<PayoffChart legs={csp} currentPrice={101} />);
    expect(screen.getByText(/max profit/i)).toBeInTheDocument();
    expect(screen.getByText(/break-?even/i)).toBeInTheDocument();
    expect(screen.getByText(/max loss/i)).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument(); // max profit
  });
  it('exposes an accessible slider with a P/L readout that updates on keyboard', () => {
    render(<PayoffChart legs={csp} currentPrice={101} />);
    const slider = screen.getByRole('slider', { name: /p\/l at underlying/i });
    expect(slider).toBeInTheDocument();
    const before = screen.getByTestId('payoff-readout').textContent;
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(screen.getByTestId('payoff-readout').textContent).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run → FAIL** (component missing).

- [ ] **Step 3: Implement `PayoffChart.tsx`.** Hand-rolled SVG (EquityChart pattern). Requirements the test pins: a stat strip with "Max profit / Break-even / Max loss" using `fmtUsd` from `dashboard/src/lib/format.ts` (unbounded → `∞`/`−∞`); an element `[data-testid="payoff-readout"]` showing `Underlying $X · P/L $Y`; an SVG `<g>`/`<rect>` handle with `role="slider"`, `aria-label="P/L at underlying price"`, `aria-valuemin={window.lo}`, `aria-valuemax={window.hi}`, `aria-valuenow={scrubPrice}`, `tabIndex={0}`, `onKeyDown` for ArrowLeft/Right (± one sample step, clamped), and Pointer-Events (`onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel` with `setPointerCapture`) mapping clientX→price across `window`. Curve drawn as two polylines clipped at `pl=0` (green ≥0, red <0) using `--color-hi`/`--color-red`. Static markers: vertical line at `currentPrice`, dotted verticals at each `breakevens[]`, small ticks at each option strike. Props: `{ legs: Leg[]; currentPrice: number }`. Internal `useMemo(() => buildPayoff(legs, currentPrice), [legs, currentPrice])`. `scrubPrice` state defaults to `currentPrice`; readout = `fmtUsd` of `totalPL(scrubPrice, legs)`. Height `h-[200px] max-md:h-[170px]`, `w-full`. Wrap the SVG in the `ErrorBoundary` pattern used elsewhere in lookup panels if the form already does so; otherwise plain.

- [ ] **Step 4: globals.css** — append scrubber affordances:

```css
/* payoff scrubber: invisible ≥44px touch hitbox around the visual handle */
.payoff-scrub { cursor: ew-resize; touch-action: none; }
.payoff-scrub-hit { fill: transparent; }
@media (max-width: 767px) { .payoff-scrub-hit { /* widened in component via width prop */ } }
```

- [ ] **Step 5: Run → PASS** `PayoffChart.test.tsx`. Then full `npx vitest run --pool=threads` green; `npx tsc -p tsconfig.app.json --noEmit` 0.

- [ ] **Step 6: Commit.**

```bash
git add dashboard/src/components/order/PayoffChart.tsx dashboard/tests/components/PayoffChart.test.tsx dashboard/src/styles/globals.css
git commit -m "order-form(P2): interactive SVG PayoffChart with draggable scrubber"
```

### Task 2.4: Wire `PayoffChart` into the three forms

**Files:** Modify `StockOrderForm.tsx`, `OptionOrderForm.tsx`, `SpreadOrderForm.tsx`

- [ ] **Step 1: Stock form.** Derive legs from state: if `side==='buy'` → `[{kind:'stock',dir:'long',entry: Number(limitPrice)||liveMid, shares: Number(qty)||0}]`; if `side==='sell_short'` → `dir:'short'`; if `side==='sell'` (closing a long) → render a one-line muted note `"payoff diagram n/a for a position-closing sell"` instead of the chart (spec compromise). `liveMid` = `(quote.bid+quote.ask)/2` from the existing quote query. Render `<PayoffChart legs={legs} currentPrice={liveLast} />` below "size & price", above the entry-grade chips. Guard: if `qty`/price not yet entered, render nothing (no NaN chart).

- [ ] **Step 2: Option form.** From the parsed OCC contract (type/strike already available in the form for the greeks/quote) build one option leg: `dir = action==='open' ? (side==='STO'?'short':'long') : (side==='STC'?'short':'long')` — i.e. STO/SC = short, BTO/BC = long; `premium = Number(limitPrice)||liveMid`; `contracts = Number(qty)||0`. Render `<PayoffChart>` in the same position.

- [ ] **Step 3: Spread form.** Build two option legs from existing computed state (`shortContract`, `longContract`, `shortMid`, `longMid` at ~116–123): `[{kind:'option',dir:'short',type:'put',strike: shortContract.strike, premium: shortMid, contracts: Number(qty)||0}, {kind:'option',dir:'long',type:'put',strike: longContract.strike, premium: longMid, contracts: Number(qty)||0}]`. `currentPrice` = underlying spot (fetch via the existing quote query pattern used elsewhere, `/api/alpaca/quote?symbol=${symbol}` → `latestTrade.p ?? dailyBar.c`; add the query if the spread form doesn't already have a spot — it currently only fetches the chain). Render `<PayoffChart>` above the existing "Live mid credit / Max loss / Break-even" text (keep that text; the chart complements it).

- [ ] **Step 4: Verify no NaN/poison render.** Each form: when inputs incomplete, `PayoffChart` not rendered. `npx tsc … --noEmit` 0. `npx vitest run --pool=threads` green (existing stock/option/spread form tests must still pass — chart is additive; if a form test snapshot/text query collides, update the query, never weaken behavior).

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/components/order/StockOrderForm.tsx dashboard/src/components/order/OptionOrderForm.tsx dashboard/src/components/order/SpreadOrderForm.tsx
git commit -m "order-form(P2): wire PayoffChart into stock/option/spread forms"
```

---

## Phase 3 — Options-chain live spot slider

### Task 3.1: Spot-divider row in the strike ladder

**Files:** Modify `dashboard/src/components/lookup/OptionsChain.tsx`, `dashboard/src/styles/globals.css`; test `dashboard/tests/components/OptionsChain.test.tsx` (create if absent, else extend)

- [ ] **Step 1: Write/extend the failing test.** Mock the chain + quote fetch (mirror the global-`fetch` mock in `SpreadOrderForm.test.tsx`); render `OptionsChain` for a symbol whose sorted visible strikes bracket the mocked spot (e.g. strikes 95/100/105, spot 101). Assert a row with text `/share price/i` and the spot value renders, and that in DOM order it appears **after** the 100 row and **before** the 105 row (query all strike cells, find the divider's index between them).

```tsx
// add to dashboard/tests/components/OptionsChain.test.tsx
it('renders a spot divider between the bracketing strikes', async () => {
  // fetch mock returns contracts {95,100,105} for the expiration + quote latestTrade.p = 101
  render(<OptionsChain symbol="SPY" />);
  const divider = await screen.findByText(/share price/i);
  expect(divider).toHaveTextContent(/101/);
  const rowText = [...document.querySelectorAll('tr')].map((r) => r.textContent ?? '');
  const i100 = rowText.findIndex((t) => t.includes('100'));
  const iDiv = rowText.findIndex((t) => /share price/i.test(t));
  const i105 = rowText.findIndex((t) => t.includes('105'));
  expect(i100).toBeLessThan(iDiv);
  expect(iDiv).toBeLessThan(i105);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the divider.** In the strike-row map (ascending sorted rows, ~123–141 / render ~219–231): compute `spot = snap?.latestTrade?.p ?? snap?.dailyBar?.c` (already derived in component). When rendering rows, after the row whose `strike ≤ spot` and before the first row whose `strike > spot`, emit a full-width `<tr className="chain-spot">` with a single `<td colSpan={N}>Share price: {fmtUsd(spot)}</td>` (N = current column count incl. greeks-toggle state). If `spot` is below all / above all visible strikes, render the divider at the top / bottom respectively. Pure render-time insertion; no data change.

- [ ] **Step 4: globals.css** — divider band + slide easing:

```css
.chain-spot td {
  background: color-mix(in oklab, var(--color-hi) 14%, var(--color-bg));
  color: var(--color-hi);
  text-align: center;
  letter-spacing: 0.18em;
  font-size: 11px;
  padding: 4px 0;
  border-top: 1px solid var(--color-hi);
  border-bottom: 1px solid var(--color-hi);
}
.chain-spot { transition: transform 220ms ease; }
```

- [ ] **Step 5: Run → PASS**; full `npx vitest run --pool=threads` green; tsc 0.

### Task 3.2: Make it live (visible-only refetch)

**Files:** Modify `dashboard/src/components/lookup/OptionsChain.tsx`

- [ ] **Step 1: Add `refetchInterval` to the quote query** (the dedup'd quote `useQuery` ~86–89): `refetchInterval: 5000`. Scope to mounted-only is automatic (React Query stops when the component unmounts; the chain panel only mounts on `/lookup/:symbol`). If the codebase has a `document.hidden`/visibility helper used elsewhere, also gate with `refetchIntervalInBackground: false` (default) so it pauses on a backgrounded tab.

- [ ] **Step 2: Manual-reasoned test.** jsdom can't tick real intervals meaningfully; add a focused test that re-renders `OptionsChain` with a changed mocked spot (95→106) and asserts the divider moved to the new rung (between 105 and the next, or to bottom). Reuse the 3.1 mock harness with a settable spot.

- [ ] **Step 3: Run → PASS**; full suite green; tsc 0.

- [ ] **Step 4: Commit.**

```bash
git add dashboard/src/components/lookup/OptionsChain.tsx dashboard/src/styles/globals.css dashboard/tests/components/OptionsChain.test.tsx
git commit -m "order-form(P3): live spot-price slider in the options chain"
```

---

## Phase 4 — Suggested limit price helper

### Task 4.1: `fillHint` engine (TDD)

**Files:** Create `dashboard/src/lib/fillHint.ts`, `dashboard/tests/lib/fillHint.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// dashboard/tests/lib/fillHint.test.ts
import { describe, it, expect } from 'vitest';
import { computeFillHint } from '../../src/lib/fillHint';

describe('computeFillHint', () => {
  it('sell: fast=bid, balanced=mid, patient toward ask', () => {
    const h = computeFillHint({ side: 'sell', bid: 2.30, ask: 2.40, oi: 500 })!;
    expect(h.fast.price).toBeCloseTo(2.30, 2);
    expect(h.balanced.price).toBeCloseTo(2.35, 2);
    expect(h.patient.price).toBeGreaterThan(2.35);
    expect(h.patient.price).toBeLessThan(2.40);
  });
  it('buy: fast=ask, patient toward bid', () => {
    const h = computeFillHint({ side: 'buy', bid: 1.00, ask: 1.20 })!;
    expect(h.fast.price).toBeCloseTo(1.20, 2);
    expect(h.patient.price).toBeGreaterThan(1.00);
    expect(h.patient.price).toBeLessThan(1.10);
  });
  it('tight + liquid → confident mid', () => {
    const h = computeFillHint({ side: 'sell', bid: 5.00, ask: 5.05, oi: 1000 })!;
    expect(h.confidence).toMatch(/mid usually fills/i);
  });
  it('wide spread → concede note', () => {
    const h = computeFillHint({ side: 'sell', bid: 1.00, ask: 1.40 })!;
    expect(h.confidence).toMatch(/concede toward the bid/i);
  });
  it('crossed/missing quote → null', () => {
    expect(computeFillHint({ side: 'sell', bid: 0, ask: 0 })).toBeNull();
    expect(computeFillHint({ side: 'buy', bid: 2.5, ask: 2.4 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `fillHint.ts`.**

```ts
// dashboard/src/lib/fillHint.ts
export interface FillHintInput {
  side: 'buy' | 'sell';
  bid: number;
  ask: number;
  last?: number;
  oi?: number;
  volume?: number;
  tick?: number;
}
export interface FillHintTier { price: number; label: string; note: string }
export interface FillHint {
  bid: number; mid: number; ask: number;
  fast: FillHintTier; balanced: FillHintTier; patient: FillHintTier;
  confidence: string;
}

function rnd(x: number, tick: number): number {
  return Math.round(x / tick) * tick;
}

export function computeFillHint(input: FillHintInput): FillHint | null {
  const tick = input.tick && input.tick > 0 ? input.tick : 0.01;
  const { bid, ask, side } = input;
  if (!(bid > 0) || !(ask > 0) || bid >= ask) return null;
  const mid = rnd((bid + ask) / 2, tick);
  const step = Math.max(tick, rnd((ask - bid) / 4, tick));
  let fast: number;
  let patient: number;
  if (side === 'sell') {
    fast = rnd(bid, tick);
    patient = Math.min(rnd(mid + step, tick), rnd(ask - tick, tick));
  } else {
    fast = rnd(ask, tick);
    patient = Math.max(rnd(mid - step, tick), rnd(bid + tick, tick));
  }
  const r = (ask - bid) / mid;
  const liq = (input.oi ?? 0) >= 250 || (input.volume ?? 0) >= 250;
  const far = side === 'sell' ? 'bid' : 'ask';
  let confidence: string;
  if (r <= 0.03 && liq) confidence = 'Tight spread, liquid — mid usually fills.';
  else if (r <= 0.03) confidence = 'Tight spread but thin — mid likely, may need a tick.';
  else if (r > 0.08) confidence = `Wide spread — expect to concede toward the ${far}.`;
  else confidence = 'Moderate spread — mid is a reasonable start.';
  return {
    bid, mid, ask,
    fast: { price: fast, label: 'fast', note: side === 'sell' ? 'cross to bid — near-instant' : 'cross to ask — near-instant' },
    balanced: { price: mid, label: 'balanced', note: 'mid — fair, usually fills' },
    patient: { price: patient, label: 'best', note: side === 'sell' ? 'toward ask — best credit' : 'toward bid — best price' },
    confidence,
  };
}
```

- [ ] **Step 4: Run → PASS** all `fillHint.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/lib/fillHint.ts dashboard/tests/lib/fillHint.test.ts
git commit -m "order-form(P4): transparent suggested-limit-price engine"
```

### Task 4.2: `FillHint` component (TDD)

**Files:** Create `dashboard/src/components/order/FillHint.tsx`, `dashboard/tests/components/FillHint.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
// dashboard/tests/components/FillHint.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FillHint from '../../src/components/order/FillHint';

describe('FillHint', () => {
  it('renders three tiers and fires onPick with the tier price', () => {
    const onPick = vi.fn();
    render(<FillHint side="sell" bid={2.30} ask={2.40} oi={500} onPick={onPick} />);
    expect(screen.getByText(/2\.35/)).toBeInTheDocument();           // mid
    fireEvent.click(screen.getByRole('button', { name: /balanced/i }));
    expect(onPick).toHaveBeenCalledWith(2.35);
  });
  it('shows a no-quote message when degraded', () => {
    render(<FillHint side="sell" bid={0} ask={0} onPick={vi.fn()} />);
    expect(screen.getByText(/no live quote/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `FillHint.tsx`.** Props `{ side: 'buy'|'sell'; bid: number; ask: number; last?: number; oi?: number; volume?: number; tick?: number; onPick: (price: number) => void }`. Call `computeFillHint`. If `null` → render muted `"no live quote — can't suggest a price"`. Else render: a `Bid · Mid · Ask` line (`fmtUsd`), three `pbtn` chips `[{label} ${fmtUsd(price)}]` (reuse the exact `.pbtn` class + active convention as Phase 1; not active by default, click→`onPick(price)`), the `confidence` line, and a muted caption `estimate — not a guarantee`. Each chip `title={tier.note}`.

- [ ] **Step 4: Run → PASS**; full suite green; tsc 0.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/components/order/FillHint.tsx dashboard/tests/components/FillHint.test.tsx
git commit -m "order-form(P4): FillHint component with tap-to-apply chips"
```

### Task 4.3: Wire `FillHint` into the three forms

**Files:** Modify `StockOrderForm.tsx`, `OptionOrderForm.tsx`, `SpreadOrderForm.tsx`

- [ ] **Step 1: Stock & option forms.** Above the limit-price input, render `<FillHint side={netSide} bid={quote.bid} ask={quote.ask} last={quote.last} oi={quote.oi} volume={quote.volume} onPick={(p)=>setLimitPrice(String(p))} />` where `netSide` = for stock `side==='buy'?'buy':'sell'`; for option `STO/SC→'sell'`(collect credit), `BTO/BC→'buy'`. Only render when order type is `limit`/`stop_limit` (no limit field otherwise). Quote bid/ask from the existing quote query (`latestQuote.bp/ap`); `oi`/`volume` from the option snapshot when present, omit for stock.

- [ ] **Step 2: Spread form.** The "quote" is the net spread: `bid = shortBid - longAsk`, `ask = shortAsk - longBid` (worst/best net), `side='sell'` (credit). Render `<FillHint side="sell" bid={netBid} ask={netAsk} onPick={(p)=>setLimitCredit(String(p))} />` above the Limit Credit input. Use the existing per-leg snapshot bid/ask already fetched (~116–123 area).

- [ ] **Step 3: Verify** tsc 0; `npx vitest run --pool=threads` full green (form tests additive; update any colliding query, never weaken). Confirm no double-render / infinite loop (FillHint is pure off props).

- [ ] **Step 4: Commit.**

```bash
git add dashboard/src/components/order/StockOrderForm.tsx dashboard/src/components/order/OptionOrderForm.tsx dashboard/src/components/order/SpreadOrderForm.tsx
git commit -m "order-form(P4): wire FillHint tap-to-apply into all order forms"
```

---

## Phase 5 — Validation, deploy, document

### Task 5.1: Full gate

- [ ] `cd dashboard && npx tsc -p tsconfig.app.json --noEmit` → 0 errors.
- [ ] `cd dashboard && npx vitest run --pool=threads` → all green (395 baseline + net-new lib/component tests; investigate any regression — fix the test only if it asserted incidental structure that legitimately changed in P1; never weaken a behavioral assertion).

### Task 5.2: Manual device checklist (the real visual/drag validation — jsdom can't)

Production, real phone (or responsive devtools at 390×844), authenticated:

- [ ] Spread form: account/grade/tags render as chips matching the stock form; `live` chip disabled with tooltip; expiration/strikes still selects; submit still produces a valid spread (paper only — do **not** submit live).
- [ ] Each form (stock buy, option STO, put-credit spread): payoff chart renders; **drag the scrubber** on touch → readout updates; change qty/limit → chart redraws; Max/BE/Loss strip matches the spread form's existing text where both shown.
- [ ] `sell`-to-close stock order shows the "n/a" note, not a misleading chart.
- [ ] `/lookup/SPY` chain: spot divider sits between the bracketing strikes; leave it open a minute during market hours → it slides as SPY ticks.
- [ ] FillHint: three tappable chips; tapping writes the limit field; degraded quote shows the no-quote message; confidence note reads sensibly.
- [ ] Desktop ≥768px unchanged except the new additive panels.

### Task 5.3: Deploy + document

- [ ] `cd dashboard` → if worktree: `npx vercel link --yes --project tradingbot-dashboard` first (CLAUDE.md gotcha).
- [ ] `npx vercel --prod` (git push does NOT auto-deploy). **Gate production deploy on Tim's explicit confirmation** (matches mobile-effort handling).
- [ ] Update `CLAUDE.md` "Dashboard subproject" section: note order-form upgrades shipped + test-count bump.
- [ ] Commit on `claude/order-form-upgrades`. Do **not** push or open a PR unless Tim asks.

---

## Risk / rollback

- **Pure-TS engines are exhaustively unit-tested** before any UI consumes them — correctness is locked at the lib layer.
- **Everything is additive** to the forms except Phase 1's spread-form markup swap (covered by updated tests) — the chart/hint are new panels, the chain divider is a new row. No order-submission, rule-check, TOTP, or live-guard path is touched. **Zero trading-account risk.**
- **Highest-risk piece is the `PayoffChart` scrubber** (Pointer Events + SVG coordinate mapping) — mitigated by the a11y/keyboard test + the manual device pass.
- **Rollback:** revert the branch — no migrations, no API, no schema, no Vercel-config change. Each phase is an independent commit range and independently revertible.

## Self-review notes (filled during writing)

- **Spec coverage:** P1↔spread chip parity; P2↔payoff engine+chart+wiring; P3↔chain slider+live; P4↔fillHint engine+component+wiring; P5↔validation/deploy/doc. All four spec features mapped.
- **Type consistency:** `Leg`/`StockLeg`/`OptionLeg`/`PayoffResult` defined in Task 2.1 and used unchanged in 2.2–2.4; `FillHint`/`FillHintInput`/`FillHintTier` defined in 4.1 and used unchanged in 4.2–4.3. `buildPayoff(legs, currentPrice, samples?)` signature stable across all call sites.
- **No placeholders:** every code step contains complete code (libs/tests fully inlined) or precise structural instructions with exact file anchors for component wiring (mirrors the proven mobile-plan fidelity).
