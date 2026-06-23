# Trade-detail Break-even Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a position's fill-based break-even on the trade detail screen (`/trade/:id`) — as a readout and as a line on the price chart — recomputed client-side from the stored trade record.

**Architecture:** A pure helper maps a `Trade` to payoff `Leg[]` (using fill prices) and runs the existing `buildPayoff` engine to read the break-even. No schema change, works retroactively. `TradeHeader` renders the readout; `TradeChart` draws a horizontal price line via the same `createPriceLine` mechanism the spread strikes already use.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, lightweight-charts v5.

**Spec:** [docs/superpowers/specs/2026-06-23-trade-detail-breakeven-design.md](../specs/2026-06-23-trade-detail-breakeven-design.md)

---

## File Structure

- **Create** `dashboard/src/lib/trade-breakeven.ts` — pure helper: `tradeToLegs(trade)` + `tradeBreakevens(trade)`. Reuses `buildPayoff` from `payoff.ts`. One responsibility: turn a stored trade into its break-even price(s).
- **Create** `dashboard/tests/lib/trade-breakeven.test.ts` — unit tests for the helper.
- **Modify** `dashboard/src/components/trade/TradeHeader.tsx` — add a `break-even $X` readout line.
- **Create** `dashboard/tests/components/TradeHeader.test.tsx` — render test for the readout.
- **Modify** `dashboard/src/components/trade/TradeChart.tsx` — add break-even price line(s).
- **Modify** `dashboard/src/data/changelog.ts` — add a `feature` entry.

---

## Task 1: Pure break-even helper

**Files:**
- Create: `dashboard/src/lib/trade-breakeven.ts`
- Test: `dashboard/tests/lib/trade-breakeven.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/lib/trade-breakeven.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tradeBreakevens } from '../../src/lib/trade-breakeven';
import type { Trade } from '../../src/lib/trade-types';

// Minimal Trade factory — fills required fields with inert defaults so each
// test only sets what it cares about.
function mkTrade(p: Partial<Trade>): Trade {
  return {
    id: 'T-2026-06-23-001', account: 'conservative_paper', asset_class: 'stock',
    symbol: 'F', side: 'buy', qty: 1, order_type: 'limit', limit_price: null,
    stop_price: null, trail_pct: null, tif: 'day', contract_symbol: null,
    strike: null, expiration: null, contract_type: null, greeks_at_entry: null,
    alpaca_order_id: 'x', alpaca_close_order_id: null, submitted_at: '2026-06-23T13:00:00Z',
    filled_at: null, filled_avg_price: null, closed_at: null, closed_avg_price: null,
    realized_pnl: null, closed_by: null, tags: [], entry_grade: 'B',
    entry_reasoning: 'r', journal: '', exposure_at_submit: 0,
    rule_warnings_at_entry: [], schema: 1, ...p,
  } as Trade;
}

describe('tradeBreakevens', () => {
  it('long stock → break-even is the fill price (cost basis)', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'stock', side: 'buy', qty: 10, filled_avg_price: 14.5,
    }));
    expect(be).toHaveLength(1);
    expect(be[0]).toBeCloseTo(14.5, 2);
  });

  it('long call → strike + premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'call', strike: 400,
      qty: 1, filled_avg_price: 2.0,
    }));
    expect(be[0]).toBeCloseTo(402, 2);
  });

  it('long put → strike − premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'put', strike: 100,
      qty: 1, filled_avg_price: 1.5,
    }));
    expect(be[0]).toBeCloseTo(98.5, 2);
  });

  it('short put (CSP) → strike − premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'STO', contract_type: 'put', strike: 12.5,
      qty: 1, filled_avg_price: 0.4,
    }));
    expect(be[0]).toBeCloseTo(12.1, 2);
  });

  it('put-credit spread → short strike − net credit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'A', strike: 12.5, entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg: { occ: 'B', strike: 11.5, entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        expiration: '2026-07-17', width: 1, net_credit: 0.25, max_loss: 0.75, max_profit: 0.25,
      },
    }));
    expect(be[0]).toBeCloseTo(12.25, 2);
  });

  it('call-credit spread → short strike + net credit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'call_credit',
        short_leg: { occ: 'A', strike: 100, entry_premium: 1.2, fill_price: 1.2, qty: 1 },
        long_leg: { occ: 'B', strike: 105, entry_premium: 0.6, fill_price: 0.6, qty: 1 },
        expiration: '2026-07-17', width: 5, net_credit: 0.6, max_loss: 4.4, max_profit: 0.6,
      },
    }));
    expect(be[0]).toBeCloseTo(100.6, 2);
  });

  it('spread with no leg fill prices falls back to entry_premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'A', strike: 12.5, entry_premium: 0.37, fill_price: null, qty: 1 },
        long_leg: { occ: 'B', strike: 11.5, entry_premium: 0.12, fill_price: null, qty: 1 },
        expiration: '2026-07-17', width: 1, net_credit: 0.25, max_loss: 0.75, max_profit: 0.25,
      },
    }));
    expect(be[0]).toBeCloseTo(12.25, 2);
  });

  it('unfilled single-leg falls back to the order limit price', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'call', strike: 400,
      qty: 1, filled_avg_price: null, limit_price: 2.0,
    }));
    expect(be[0]).toBeCloseTo(402, 2);
  });

  it('canceled / no usable price → empty', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'call', strike: 400,
      qty: 1, filled_avg_price: null, limit_price: null, closed_by: 'canceled',
    }));
    expect(be).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/trade-breakeven.test.ts --pool=forks`
Expected: FAIL — `Failed to resolve import "../../src/lib/trade-breakeven"` (module not created yet).

Note: the `--pool=forks` flag is required — the default threads pool times out in git worktrees on this machine.

- [ ] **Step 3: Write the helper**

Create `dashboard/src/lib/trade-breakeven.ts`:

```ts
// dashboard/src/lib/trade-breakeven.ts
//
// Recompute a trade's break-even price(s) from its stored record, reusing the
// same payoff engine the order form uses (single source of truth). Break-even
// is a pure function of a position's legs — strikes, entry premium, side — all
// persisted on the Trade, so no snapshot/schema change is needed and this works
// retroactively on every existing trade.
//
// Fill-based: uses actual fill prices, falling back to the order limit (single
// leg) or the stored net credit/debit (spreads) when fills aren't recorded.
import { buildPayoff } from './payoff';
import type { Leg, OptionLeg, OptionType, LegDir } from './payoff';
import type { Trade } from './trade-types';

function num(x: number | null | undefined): number | null {
  return x != null && isFinite(x) ? x : null;
}

/** Map a trade record to payoff legs using fill prices (entry-time basis). */
export function tradeToLegs(trade: Trade): Leg[] {
  if (trade.asset_class === 'stock') {
    const entry = num(trade.filled_avg_price) ?? num(trade.limit_price);
    if (entry == null) return [];
    const dir: LegDir = trade.side === 'buy' ? 'long' : 'short';
    return [{ kind: 'stock', dir, entry, shares: trade.qty }];
  }

  if (trade.asset_class === 'option') {
    const premium = num(trade.filled_avg_price) ?? num(trade.limit_price);
    if (premium == null || trade.strike == null || trade.contract_type == null) return [];
    const dir: LegDir = trade.side === 'BTO' || trade.side === 'BTC' ? 'long' : 'short';
    return [{
      kind: 'option', dir, type: trade.contract_type,
      strike: trade.strike, premium, contracts: trade.qty,
    }];
  }

  if (trade.asset_class === 'spread' && trade.spread) {
    const sp = trade.spread;
    const type: OptionType =
      sp.spread_type === 'put_credit' || sp.spread_type === 'put_debit' ? 'put' : 'call';
    const mk = (dir: LegDir, strike: number, premium: number): OptionLeg => ({
      kind: 'option', dir, type, strike, premium, contracts: trade.qty,
    });

    const shortPrem = num(sp.short_leg.fill_price) ?? num(sp.short_leg.entry_premium);
    const longPrem = num(sp.long_leg.fill_price) ?? num(sp.long_leg.entry_premium);
    if (shortPrem != null && longPrem != null) {
      return [mk('short', sp.short_leg.strike, shortPrem), mk('long', sp.long_leg.strike, longPrem)];
    }

    // Fallback: synthesize per-leg premiums from the stored net so the
    // break-even is still correct. Break-even depends only on net + the
    // relevant strike, so loading the whole net onto one leg (and 0 on the
    // other) yields the right zero-crossing. Max profit/loss would be
    // meaningless this way, but we only read `breakevens`.
    const isCredit = sp.spread_type === 'put_credit' || sp.spread_type === 'call_credit';
    const net = isCredit ? num(sp.net_credit) : num(sp.net_debit);
    if (net == null || net <= 0) return [];
    return isCredit
      ? [mk('short', sp.short_leg.strike, net), mk('long', sp.long_leg.strike, 0)]
      : [mk('short', sp.short_leg.strike, 0), mk('long', sp.long_leg.strike, net)];
  }

  return [];
}

/** Reference price that only sets buildPayoff's search window (not the BE values). */
function refPrice(legs: Leg[]): number {
  for (const l of legs) if (l.kind === 'option') return l.strike;
  for (const l of legs) if (l.kind === 'stock') return l.entry;
  return 1;
}

/** Break-even price(s) for a trade, ascending. Empty when not computable. */
export function tradeBreakevens(trade: Trade): number[] {
  const legs = tradeToLegs(trade);
  if (legs.length === 0) return [];
  return buildPayoff(legs, refPrice(legs)).breakevens;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run tests/lib/trade-breakeven.test.ts --pool=forks`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/trade-breakeven.ts dashboard/tests/lib/trade-breakeven.test.ts
git commit -m "feat(dashboard): trade break-even helper (recompute from stored record)"
```

---

## Task 2: Break-even readout in TradeHeader

**Files:**
- Modify: `dashboard/src/components/trade/TradeHeader.tsx`
- Test: `dashboard/tests/components/TradeHeader.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/components/TradeHeader.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TradeHeader } from '../../src/components/trade/TradeHeader';
import { fmtUsd } from '../../src/lib/format';
import type { Trade } from '../../src/lib/trade-types';

function mkTrade(p: Partial<Trade>): Trade {
  return {
    id: 'T-2026-06-23-001', account: 'live', asset_class: 'option',
    symbol: 'F', side: 'BTO', qty: 1, order_type: 'limit', limit_price: 2.0,
    stop_price: null, trail_pct: null, tif: 'day', contract_symbol: 'F260717C00400000',
    strike: 400, expiration: '2026-07-17', contract_type: 'call', greeks_at_entry: null,
    alpaca_order_id: 'x', alpaca_close_order_id: null, submitted_at: '2026-06-23T13:00:00Z',
    filled_at: '2026-06-23T13:01:00Z', filled_avg_price: 2.0, closed_at: null,
    closed_avg_price: null, realized_pnl: null, closed_by: null, tags: [],
    entry_grade: 'B', entry_reasoning: 'r', journal: '', exposure_at_submit: 200,
    rule_warnings_at_entry: [], schema: 1, ...p,
  } as Trade;
}

describe('TradeHeader break-even readout', () => {
  it('renders the break-even for an open option trade (strike + premium)', () => {
    render(<TradeHeader trade={mkTrade({})} />);
    expect(screen.getByText(/break-even/i)).toBeTruthy();
    expect(screen.getByText(fmtUsd(402))).toBeTruthy();
  });

  it('renders an em-dash when break-even is not computable', () => {
    render(<TradeHeader trade={mkTrade({ filled_avg_price: null, limit_price: null })} />);
    expect(screen.getByText(/break-even/i)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run tests/components/TradeHeader.test.tsx --pool=forks`
Expected: FAIL — no element with text `/break-even/i` (readout not added yet).

- [ ] **Step 3: Add the readout**

In `dashboard/src/components/trade/TradeHeader.tsx`:

Add the import at the top (after the existing imports):

```tsx
import { tradeBreakevens } from '../../lib/trade-breakeven';
```

Inside the component body, after the `statusText` declaration, add:

```tsx
  const bes = tradeBreakevens(trade);
  const beText = bes.length ? bes.map((b) => fmtUsd(b)).join(' / ') : '—';
```

Then, in the left column `<div>`, add a new line immediately after the existing summary `<div className="text-mid text-[10px]">// …</div>`:

```tsx
        <div className="text-mid text-[10px]">
          break-even <span className="text-fg">{beText}</span>
        </div>
```

(`fmtUsd` is already imported in this file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run tests/components/TradeHeader.test.tsx --pool=forks`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/trade/TradeHeader.tsx dashboard/tests/components/TradeHeader.test.tsx
git commit -m "feat(dashboard): break-even readout on trade detail header"
```

---

## Task 3: Break-even line on TradeChart

**Files:**
- Modify: `dashboard/src/components/trade/TradeChart.tsx`

No unit test: the chart renders to a canvas via lightweight-charts (not assertable in jsdom). The break-even *values* are covered by Task 1's helper tests; this task is a thin `createPriceLine` call verified by `tsc` + visual check.

- [ ] **Step 1: Add the import**

In `dashboard/src/components/trade/TradeChart.tsx`, after the existing imports:

```tsx
import { tradeBreakevens } from '../../lib/trade-breakeven';
```

- [ ] **Step 2: Draw the break-even line(s)**

In the `useEffect`, immediately after the spread-strikes block (the `if (trade.asset_class === 'spread' && trade.spread) { … }` that ends with the two `series.createPriceLine` calls) and before the `ResizeObserver` is created, add:

```tsx
    // Break-even — recomputed from the trade's entry data (same engine the
    // order form uses). Drawn for every asset class as a dashed cyan line so
    // it's obvious whether price sits above or below it.
    for (const be of tradeBreakevens(trade)) {
      series.createPriceLine({
        price: be,
        color: '#5ad1e6',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `BE $${be.toFixed(2)}`,
      });
    }
```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/trade/TradeChart.tsx
git commit -m "feat(dashboard): break-even line on trade detail chart"
```

---

## Task 4: Changelog + full verification

**Files:**
- Modify: `dashboard/src/data/changelog.ts`

- [ ] **Step 1: Add the changelog entry**

Prepend a new entry at the TOP of the `CHANGELOG` array in `dashboard/src/data/changelog.ts` (newest first):

```ts
  {
    date: '2026-06-23',
    category: 'feature',
    title: 'Trade detail now shows the break-even — readout + a line on the chart',
    details:
      'Break-even used to be visible only while placing an order. The trade detail screen '
      + '(/trade/:id) now shows it after the fact too: a "break-even" readout in the header '
      + 'and a dashed cyan line on the price chart, so you can see at a glance whether price '
      + 'is above or below it. It is the fill-based break-even of the position you actually '
      + 'entered, recomputed from the stored trade with the same payoff engine the order form '
      + 'uses — so it works retroactively on every trade already in the system, with no data '
      + 'migration. Shown for stocks, options, and spreads.',
  },
```

- [ ] **Step 2: Run the full dashboard suite**

Run: `cd dashboard && npx vitest run --pool=forks`
Expected: PASS — all files green (prior count 775 + 11 new = 786).

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/data/changelog.ts
git commit -m "docs(dashboard): changelog — trade-detail break-even"
```

---

## Ship (orchestrator, after all tasks pass review)

Not a subagent task — handled by the orchestrator after task review:
1. `cd dashboard && npm run bump` (ticks the dashboard digit; all changes are under `dashboard/**`)
2. Commit the version bump.
3. Rebase onto latest `origin/main` (bot pushes state continuously) and push to `main`.
4. `npx vercel link --yes --project tradingbot-dashboard` then `npx vercel --prod --yes`.

---

## Self-Review

**Spec coverage:**
- Fill-based break-even, retroactive, reuse `buildPayoff` → Task 1. ✓
- Readout for all trades → Task 2. ✓
- Chart line for all asset classes → Task 3. ✓
- Fallbacks (fill → limit → net; empty when uncomputable) → Task 1 helper + tests. ✓
- Tests: stock, long call, long/short put, put-credit, call-credit, unfilled fallback, empty → Task 1. ✓

**Placeholder scan:** none — every step has full code or an exact command.

**Type consistency:** `tradeToLegs` / `tradeBreakevens` signatures match across Tasks 1–3; `Leg`/`OptionLeg`/`OptionType`/`LegDir` imported from `payoff.ts` (verified exported); `Trade`/`SpreadDetails` field names (`filled_avg_price`, `limit_price`, `strike`, `contract_type`, `spread.short_leg.fill_price`, `spread.net_credit`, `spread.net_debit`, `spread.spread_type`) match `api/_lib/trade-types.ts`.
