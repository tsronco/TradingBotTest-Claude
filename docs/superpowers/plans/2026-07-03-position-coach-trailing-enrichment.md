# Position Coach — Trailing-Stop Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the `/lookup/:symbol` Position Coach so its trailing-stop explanation shows the actual price figures a trader would act on — the activation price when OFF, and the exact trigger + locked-in floor + next-raise price when ON.

**Architecture:** All math stays in Layer 1 (deterministic code) per the coach's existing "the model phrases but cannot fabricate" contract. A new pure helper `computeTrailingCoach()` produces a typed `TrailingCoach` object inside `buildPositionFacts()`; the LLM prompt, the server fallback readout, and the mirrored client fallback readout all *format* that precomputed object — none of them recompute. The object rides to the client in the existing `facts` JSON, so the client needs only a type addition plus the mirrored formatter.

**Tech stack:** TypeScript (Vercel serverless + React 19 client), vitest. No new deps, no new Vercel functions.

**Confirmed from code before planning:**
- Trailing has an **activation threshold**: arms automatically at `entry × 1.10` (`TRAIL_TRIGGER_PCT = 0.10`), [strategy.py:35](../../../strategy.py), [strategy.py:809](../../../strategy.py). Not a manual toggle.
- Trail distance is a **percentage**: floor = `HWM × 0.95` (`TRAIL_DISTANCE_PCT = 0.05`), [strategy.py:36](../../../strategy.py), [strategy.py:823](../../../strategy.py).
- HWM only ratchets while ON ([strategy.py:821-822](../../../strategy.py)) — so the OFF state never references HWM (it's frozen at entry); distance is measured from **current price**.
- `entry_price` is already in KV (`tsla-monitor-manual.yml` pushes the whole `strategy_state_manual.json`, [tsla-monitor-manual.yml:97-98](../../../.github/workflows/tsla-monitor-manual.yml)); `RawStrategySym` just doesn't read it yet.
- `high_water_mark` already surfaces in `PositionFacts`; the client type just ignores it.

**Two design decisions (approved by Tim):**
1. Use `entry_price` (not `avg_cost`) for the activation price — matches what the bot triggers on; diverges from avg_cost after a ladder fires. Fall back to `avg_cost` only if `entry_price` is absent.
2. When the trailing trigger sits **at or above** current price (can happen legitimately between 10-min cron cycles, price has crossed the stop but the bot hasn't sold yet), do NOT print a nonsensical "locked-in gain" — flip to *"price has fallen to your stop; the bot sells on its next cycle."*

---

## File Structure

- **Modify** `dashboard/api/_lib/position-coach.ts` — add constants, `TrailingCoach` type + `computeTrailingCoach()` helper, wire into `buildPositionFacts`/`PositionFacts`, update `buildCoachPrompt`, `deterministicReadout`, `coachSignature`, and `SYSTEM_PROMPT`. (One file owns all the trailing math + server rendering.)
- **Modify** `dashboard/src/components/lookup/PositionCoachPanel.tsx` — add `trailing_coach` to the local `Facts` type (type-only import of `TrailingCoach`) and mirror the trailing sentences in the client `deterministicReadout`.
- **Modify** `dashboard/tests/lib/position-coach.test.ts` — unit tests for the math + server rendering.
- **Create** `dashboard/tests/lib/position-coach-parity.test.ts` — assert the client fallback string equals the server fallback string across a fact matrix (closes the pre-existing parity gap).

---

## Task 1: Trailing-stop math (constants + `TrailingCoach` + `computeTrailingCoach`)

**Files:**
- Modify: `dashboard/api/_lib/position-coach.ts` (add constants after imports ~line 25; add type + helper before `buildPositionFacts` ~line 116; wire into `PositionFacts` lines 63-84 and `buildPositionFacts` lines 122-157; extend `coachSignature` lines 259-274)
- Modify: `dashboard/tests/lib/position-coach.test.ts`

- [ ] **Step 1: Write the failing tests for `computeTrailingCoach`**

Add to `dashboard/tests/lib/position-coach.test.ts` — first extend the imports at the top:

```typescript
import {
  buildPositionFacts,
  buildCoachPrompt,
  deterministicReadout,
  coachSignature,
  computeTrailingCoach,
  TRAIL_TRIGGER_PCT,
  TRAIL_DISTANCE_PCT,
  SYSTEM_PROMPT,
  type RawPosition,
  type RawStrategySym,
} from '../../api/_lib/position-coach';
```

Then append this describe block:

```typescript
describe('computeTrailingCoach', () => {
  const base = {
    asset_class: 'stock' as const,
    avg_cost: 4.53,
    entry_price: 4.53,
    qty: 5,
  };

  it('exposes the bot constants as fractions', () => {
    expect(TRAIL_TRIGGER_PCT).toBe(0.10);
    expect(TRAIL_DISTANCE_PCT).toBe(0.05);
  });

  it('OFF: reports the activation price and the gap from CURRENT price', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: false, stop_price: 4.08, high_water_mark: 4.53, current_price: 4.42 })!;
    expect(tc.state).toBe('off');
    expect(tc.activation_price).toBe(4.98); // 4.53 * 1.10 = 4.983 -> 4.98
    expect(tc.activation_gap_abs).toBe(0.56); // 4.98 - 4.42, from CURRENT not HWM
    expect(tc.activation_gap_pct).toBeCloseTo(12.67, 1);
    expect(tc.trigger_price).toBeNull();
    expect(tc.trail_distance_pct).toBe(0.05);
  });

  it('OFF: uses entry_price (not avg_cost) for the activation price after a ladder', () => {
    // entry stayed at 4.53 but avg_cost blended up to 5.00 after a ladder buy
    const tc = computeTrailingCoach({ ...base, avg_cost: 5.00, entry_price: 4.53, trailing_active: false, stop_price: 4.50, high_water_mark: 4.53, current_price: 4.42 })!;
    expect(tc.activation_price).toBe(4.98); // keyed off entry 4.53, not avg 5.00
  });

  it('OFF: falls back to avg_cost when entry_price is missing', () => {
    const tc = computeTrailingCoach({ ...base, entry_price: null, trailing_active: false, stop_price: 4.08, high_water_mark: 4.53, current_price: 4.42 })!;
    expect(tc.activation_price).toBe(4.98); // avg_cost 4.53 * 1.10
  });

  it('ON: reports the trigger, the locked-in gain per-share + total, and the next-raise price', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: true, stop_price: 4.94, high_water_mark: 5.20, current_price: 5.00 })!;
    expect(tc.state).toBe('on');
    expect(tc.trigger_price).toBe(4.94);
    expect(tc.locked_kind).toBe('gain');
    expect(tc.locked_per_share).toBe(0.41); // 4.94 - 4.53
    expect(tc.locked_total).toBe(2.05);     // 0.41 * 5
    expect(tc.next_raise_above).toBe(5.20);
    expect(tc.activation_price).toBeNull();
  });

  it('ON: flips to a worst-case LOSS when the trigger sits below avg cost', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: true, stop_price: 4.40, high_water_mark: 4.75, current_price: 4.60 })!;
    expect(tc.state).toBe('on');
    expect(tc.locked_kind).toBe('loss');
    expect(tc.locked_per_share).toBe(0.13); // |4.40 - 4.53|
    expect(tc.locked_total).toBe(0.65);     // 0.13 * 5
  });

  it('SANITY GUARD: trigger at/above current price => "triggering", no locked-in figure', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: true, stop_price: 4.94, high_water_mark: 5.20, current_price: 4.90 })!;
    expect(tc.state).toBe('triggering');
    expect(tc.trigger_price).toBe(4.94);
    expect(tc.locked_kind).toBeNull();
    expect(tc.locked_per_share).toBeNull();
    expect(tc.next_raise_above).toBeNull();
  });

  it('returns null for non-stock instruments', () => {
    expect(computeTrailingCoach({ ...base, asset_class: 'option', trailing_active: false, stop_price: 4.08, high_water_mark: 4.53, current_price: 4.42 })).toBeNull();
  });

  it('returns null when the bot has no trailing state or stop recorded', () => {
    expect(computeTrailingCoach({ ...base, asset_class: 'stock', trailing_active: null, stop_price: null, high_water_mark: null, current_price: 4.42 })).toBeNull();
  });
});

describe('buildPositionFacts trailing_coach wiring', () => {
  const POS_OFF: RawPosition = { symbol: 'SNAP', qty: '5', avg_entry_price: '4.53', current_price: '4.42', asset_class: 'us_equity', side: 'long' };
  it('attaches a computed trailing_coach when the bot manages the stock', () => {
    const strat: RawStrategySym = { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53, ladder_done: [false, false, false], initial_qty: 5 };
    const f = buildPositionFacts('SNAP', 'live', POS_OFF, strat, null, []);
    expect(f.trailing_coach?.state).toBe('off');
    expect(f.trailing_coach?.activation_price).toBe(4.98);
  });
  it('leaves trailing_coach null when there is no bot state', () => {
    const f = buildPositionFacts('SNAP', 'manual', POS_OFF, null, null, []);
    expect(f.trailing_coach).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && npx vitest run tests/lib/position-coach.test.ts --pool=threads`
Expected: FAIL — `computeTrailingCoach is not a function` / `TRAIL_TRIGGER_PCT` undefined.

- [ ] **Step 3: Add the constants**

In `dashboard/api/_lib/position-coach.ts`, immediately after the existing `const CACHE_TTL_SECONDS = ...` line (~line 25), add:

```typescript
// Mirror of strategy.py:35-36. These are stable bot constants — if TRAIL_TRIGGER_PCT
// or TRAIL_DISTANCE_PCT ever change in strategy.py, update them here too.
export const TRAIL_TRIGGER_PCT = 0.10;  // trailing arms at +10% above entry
export const TRAIL_DISTANCE_PCT = 0.05; // floor rides 5% below the high-water mark
```

- [ ] **Step 4: Add the `TrailingCoach` type and `computeTrailingCoach` helper**

In `dashboard/api/_lib/position-coach.ts`, add the type right before the `PositionFacts` interface (~line 62), and the helper in the "pure helpers" section right before `buildPositionFacts` (~line 116):

```typescript
/**
 * Precomputed, plain-number trailing-stop figures for the coach to narrate. All
 * arithmetic lives here so neither the LLM nor the mirrored client readout ever
 * recomputes. `state` selects the narrative branch:
 *   'off'        — trail hasn't armed; show the activation price + gap from current.
 *   'on'         — trail is live; show the trigger, locked-in floor, next-raise price.
 *   'triggering' — trigger has reached/passed current price (bot sells next cycle);
 *                  suppress the locked-in figure (a stop above current would be a bug).
 */
export interface TrailingCoach {
  state: 'off' | 'on' | 'triggering';
  activation_pct: number;       // 0.10 — for "+10% above entry" phrasing
  trail_distance_pct: number;   // 0.05 — for "5% behind the high" phrasing
  // OFF branch
  activation_price: number | null;   // entry × (1 + activation_pct)
  activation_gap_abs: number | null; // activation_price − current_price (measured from CURRENT)
  activation_gap_pct: number | null; // gap as a percent of current_price
  // ON / triggering branch
  trigger_price: number | null;      // = stop_price (the live trailing floor)
  locked_kind: 'gain' | 'loss' | null;
  locked_per_share: number | null;   // |trigger − avg_cost|
  locked_total: number | null;       // locked_per_share × qty
  next_raise_above: number | null;   // = high_water_mark; stop climbs on a print above this
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the trailing-stop narrative figures from raw position + bot state.
 * Returns null when the concept doesn't apply (non-stock, or the bot has no
 * trailing state / stop recorded for the symbol). Pure / testable.
 */
export function computeTrailingCoach(args: {
  asset_class: 'stock' | 'option' | 'other';
  trailing_active: boolean | null;
  stop_price: number | null;
  entry_price: number | null;
  avg_cost: number;
  current_price: number | null;
  high_water_mark: number | null;
  qty: number;
}): TrailingCoach | null {
  const { asset_class, trailing_active, stop_price, entry_price, avg_cost, current_price, high_water_mark, qty } = args;
  // Trailing stops are a stock-strategy concept; options/wheel don't have one.
  if (asset_class !== 'stock') return null;
  // Need a recorded trailing state and a stop to say anything.
  if (trailing_active == null || stop_price == null) return null;

  const blank = {
    activation_pct: TRAIL_TRIGGER_PCT,
    trail_distance_pct: TRAIL_DISTANCE_PCT,
    activation_price: null,
    activation_gap_abs: null,
    activation_gap_pct: null,
    trigger_price: null,
    locked_kind: null,
    locked_per_share: null,
    locked_total: null,
    next_raise_above: null,
  };

  if (!trailing_active) {
    // Bot triggers off entry_price; fall back to avg_cost only if it's missing.
    const basis = entry_price ?? avg_cost;
    const activation = round2(basis * (1 + TRAIL_TRIGGER_PCT));
    const gapAbs = current_price != null ? round2(activation - current_price) : null;
    const gapPct = current_price != null && current_price !== 0
      ? ((activation - current_price) / current_price) * 100
      : null;
    return { ...blank, state: 'off', activation_price: activation, activation_gap_abs: gapAbs, activation_gap_pct: gapPct };
  }

  // ON. A stop sells on a FALL, so it must sit below current. If price has already
  // reached/passed it (legitimate between 10-min cron cycles), it's mid-trigger —
  // don't print a "locked-in" figure that would read as a gain.
  if (current_price != null && stop_price >= current_price) {
    return { ...blank, state: 'triggering', trigger_price: stop_price };
  }

  const perShareRaw = stop_price - avg_cost; // >0 gain, <=0 worst-case loss
  const perShare = round2(Math.abs(perShareRaw));
  return {
    ...blank,
    state: 'on',
    trigger_price: stop_price,
    locked_kind: perShareRaw >= 0 ? 'gain' : 'loss',
    locked_per_share: perShare,
    locked_total: round2(perShare * qty), // from the rounded per-share so displayed figures reconcile
    next_raise_above: high_water_mark,
  };
}
```

- [ ] **Step 5: Add `entry_price` to `RawStrategySym`, `trailing_coach` to `PositionFacts`, and wire `buildPositionFacts`**

In `RawStrategySym` (~lines 50-56) add the `entry_price` field:

```typescript
export interface RawStrategySym {
  stop_price?: number | null;
  high_water_mark?: number | null;
  trailing_active?: boolean | null;
  entry_price?: number | null;
  ladder_done?: boolean[] | null;
  initial_qty?: number | null;
}
```

In `PositionFacts` (~lines 63-84), add the field just after `high_water_mark`:

```typescript
  high_water_mark: number | null;
  // Precomputed trailing-stop figures for narration; null when N/A (non-stock,
  // or the bot has no trailing state for this symbol).
  trailing_coach: TrailingCoach | null;
```

In `buildPositionFacts` (~lines 138-156), compute and attach it. Add, just before the `return {`:

```typescript
  const avgCost = num(position.avg_entry_price) ?? 0;
  const currentPrice = num(position.current_price);
  const trailingCoach = computeTrailingCoach({
    asset_class: classify(position.asset_class),
    trailing_active: strategySym?.trailing_active ?? null,
    stop_price: num(strategySym?.stop_price),
    entry_price: num(strategySym?.entry_price),
    avg_cost: avgCost,
    current_price: currentPrice,
    high_water_mark: num(strategySym?.high_water_mark),
    qty,
  });
```

Then in the returned object, reuse the locals and add the field:

```typescript
    avg_cost: avgCost,
    current_price: currentPrice,
```
```typescript
    high_water_mark: num(strategySym?.high_water_mark),
    trailing_coach: trailingCoach,
```

(Replace the existing `avg_cost:` / `current_price:` lines with the local-reusing versions so `computeTrailingCoach` and the facts object agree.)

- [ ] **Step 6: Extend `coachSignature` so narration refreshes when the activation/next-raise inputs move**

In `coachSignature` (~lines 263-273), add `entry_price` and `high_water_mark` to the joined array (they drive the activation price and next-raise price):

```typescript
  return [
    facts.symbol,
    facts.mode,
    facts.qty,
    facts.avg_cost,
    facts.stop_price ?? 'na',
    facts.trailing_active ?? 'na',
    facts.high_water_mark ?? 'na',
    facts.trailing_coach?.state ?? 'na',
    facts.ladder_rungs_remaining ?? 'na',
    facts.wheel_stage ?? 'na',
    px,
  ].join('|');
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd dashboard && npx vitest run tests/lib/position-coach.test.ts --pool=threads`
Expected: PASS (all existing + new `computeTrailingCoach` / wiring tests).

- [ ] **Step 8: Commit**

```bash
git add dashboard/api/_lib/position-coach.ts dashboard/tests/lib/position-coach.test.ts
git commit -m "feat(coach): compute trailing-stop figures (activation, locked-in floor, next-raise)"
```

---

## Task 2: Server rendering — LLM prompt, fallback readout, system prompt

**Files:**
- Modify: `dashboard/api/_lib/position-coach.ts` (`buildCoachPrompt` lines ~181-224; `deterministicReadout` lines ~230-256; `SYSTEM_PROMPT` lines ~159-174)
- Modify: `dashboard/tests/lib/position-coach.test.ts`

- [ ] **Step 1: Write the failing tests for the rendered strings**

Append to `dashboard/tests/lib/position-coach.test.ts`:

```typescript
describe('trailing-stop rendering', () => {
  const P = (over: Partial<RawPosition> = {}): RawPosition => ({ symbol: 'SNAP', qty: '5', avg_entry_price: '4.53', current_price: '4.42', asset_class: 'us_equity', side: 'long', ...over });

  it('prompt (OFF): hands the LLM the activation price and gap from current', () => {
    const f = buildPositionFacts('SNAP', 'live', P(), { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53 }, null, []);
    const p = buildCoachPrompt(f);
    expect(p).toContain('Trailing stop: OFF');
    expect(p).toContain('$4.98'); // activation price
    expect(p).toContain('$0.56'); // gap above current
  });

  it('prompt (ON): hands the LLM the trigger, locked-in floor, and next-raise price', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '5.00' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const p = buildCoachPrompt(f);
    expect(p).toContain('Trailing stop: ON');
    expect(p).toContain('$4.94');            // trigger
    expect(p).toContain('$0.41');            // per-share locked in
    expect(p).toContain('$2.05');            // total across 5 shares
    expect(p).toContain('$5.20');            // next-raise (HWM)
  });

  it('prompt (triggering): tells the LLM the bot will sell next cycle', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '4.90' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const p = buildCoachPrompt(f);
    expect(p).toMatch(/sells? on its next cycle/i);
    expect(p).toContain('$4.94');
  });

  it('readout (OFF): states off + activation price + distance from current', () => {
    const f = buildPositionFacts('SNAP', 'live', P(), { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toMatch(/trailing stop is off/i);
    expect(t).toContain('$4.98');
    expect(t).toContain('$0.56');
  });

  it('readout (ON gain): trigger + locked-in per-share and total + next-raise', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '5.00' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toContain('$4.94');
    expect(t).toContain('$0.41');
    expect(t).toContain('$2.05');
    expect(t).toContain('$5.20');
    expect(t).toMatch(/locks in|locked in|at least/i);
  });

  it('readout (ON loss): frames a worst-case loss, not a negative gain', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '4.60' }), { stop_price: 4.40, high_water_mark: 4.75, trailing_active: true, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toMatch(/loss/i);
    expect(t).not.toMatch(/-\$/); // never print a negative dollar amount
    expect(t).toContain('$0.13');
  });

  it('readout (triggering): sell-next-cycle language, no locked-in figure', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '4.90' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toMatch(/sells? on its next cycle/i);
  });

  it('readout stays advice-free with the new trailing detail', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '5.00' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    expect(deterministicReadout(f)).not.toMatch(/you should|recommend|good entry|consider|i'?d (buy|sell)/i);
  });
});
```

Also update the existing `SYSTEM_PROMPT` test (the `'at most 4 sentences'` assertion at ~line 92) to the new cap:

```typescript
    expect(SYSTEM_PROMPT).toContain('at most 6 sentences');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && npx vitest run tests/lib/position-coach.test.ts --pool=threads`
Expected: FAIL — prompt/readout don't yet contain the enriched figures; SYSTEM_PROMPT still says "4 sentences".

- [ ] **Step 3: Add a shared sentence formatter and update the fallback readout**

In `dashboard/api/_lib/position-coach.ts`, add a formatter helper right after `fmtUsd` (~line 178). This produces the exact trailing sentences reused by the fallback readout; the client mirrors it (Task 3) and a parity test guards them:

```typescript
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/**
 * Plain-English trailing-stop sentences built ONLY from a precomputed
 * TrailingCoach (no math here). Returned as an array of sentences so callers can
 * join them. Mirrored verbatim in PositionCoachPanel.tsx — see the parity test.
 */
export function trailingReadoutSentences(tc: TrailingCoach, qty: number): string[] {
  const unit = qty === 1 ? 'share' : 'shares';
  if (tc.state === 'off') {
    const out = ['The trailing stop is off — it arms on its own once the price climbs to ' + fmtUsd(tc.activation_price) + ` (${Math.round(tc.activation_pct * 100)}% above entry).`];
    if (tc.activation_gap_abs != null && tc.activation_gap_pct != null) {
      out.push(`That's ${fmtUsd(tc.activation_gap_abs)} (${fmtPct(tc.activation_gap_pct)}) above the current price.`);
    }
    return out;
  }
  if (tc.state === 'triggering') {
    return [`The trailing stop is on and the price has fallen to its ${fmtUsd(tc.trigger_price)} trigger — the bot sells on its next cycle.`];
  }
  // state === 'on'
  const out = [`The trailing stop is on, with its trigger at ${fmtUsd(tc.trigger_price)} — a stop that ratchets up as the price rises but never moves down.`];
  if (tc.locked_kind === 'gain') {
    out.push(`If it triggers, that locks in a gain of at least ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${qty} ${unit}) over your cost.`);
  } else {
    out.push(`Its trigger sits below your cost, so if it fires it caps the loss at ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${qty} ${unit}).`);
  }
  if (tc.next_raise_above != null) {
    out.push(`Your floor climbs the moment the price prints above ${fmtUsd(tc.next_raise_above)}; every new high drags the stop up ${Math.round(tc.trail_distance_pct * 100)}% behind it.`);
  }
  return out;
}
```

Then in `deterministicReadout` (~lines 241-245), replace the trailing clause. The current block is:

```typescript
  if (facts.stop_price != null) {
    parts.push(`The bot's stop is set at ${fmtUsd(facts.stop_price)} — it sells automatically if the price falls there, which would realize the loss. Trailing stop is ${facts.trailing_active ? 'on' : 'off'}.`);
  } else if (!facts.is_excluded) {
```

Change the first `parts.push(...)` to drop the trailing clause (the trailing detail now comes from the formatter) and append the enriched sentences:

```typescript
  if (facts.stop_price != null) {
    parts.push(`The bot's stop is set at ${fmtUsd(facts.stop_price)} — it sells automatically if the price falls there, which would realize the loss.`);
    if (facts.trailing_coach) parts.push(...trailingReadoutSentences(facts.trailing_coach, facts.qty));
  } else if (!facts.is_excluded) {
```

- [ ] **Step 4: Update `buildCoachPrompt` to hand the LLM the enriched figures**

In `buildCoachPrompt` (~lines 202-207), replace the current trailing/HWM lines:

```typescript
  if (facts.trailing_active != null) {
    lines.push(`- Trailing stop: ${facts.trailing_active ? 'ON' : 'OFF'}`);
  }
  if (facts.high_water_mark != null) {
    lines.push(`- Highest price seen since entry (high-water mark): ${fmtUsd(facts.high_water_mark)}`);
  }
```

with an explicit, labeled fact block driven by `trailing_coach`:

```typescript
  const tc = facts.trailing_coach;
  if (tc == null) {
    if (facts.trailing_active != null) lines.push(`- Trailing stop: ${facts.trailing_active ? 'ON' : 'OFF'}`);
  } else if (tc.state === 'off') {
    lines.push(`- Trailing stop: OFF (arms automatically at +${Math.round(tc.activation_pct * 100)}% above entry)`);
    lines.push(`  - Arms at: ${fmtUsd(tc.activation_price)}`);
    if (tc.activation_gap_abs != null && tc.activation_gap_pct != null) {
      lines.push(`  - Distance to arm: ${fmtUsd(tc.activation_gap_abs)} (${fmtPct(tc.activation_gap_pct)}) above the current price`);
    }
  } else if (tc.state === 'triggering') {
    lines.push(`- Trailing stop: ON, and the price has fallen to the ${fmtUsd(tc.trigger_price)} trigger — the bot sells on its next cycle.`);
  } else {
    lines.push('- Trailing stop: ON (a stop that ratchets up as price rises but never down)');
    lines.push(`  - Trigger (sells if price falls here): ${fmtUsd(tc.trigger_price)}`);
    if (tc.locked_kind === 'gain') {
      lines.push(`  - Locks in at least: ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${facts.qty} share(s)) over cost`);
    } else {
      lines.push(`  - Worst-case loss if it fires: ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${facts.qty} share(s)) — trigger is below cost`);
    }
    if (tc.next_raise_above != null) {
      lines.push(`  - Floor next rises when price prints above: ${fmtUsd(tc.next_raise_above)} (stays ${Math.round(tc.trail_distance_pct * 100)}% behind each new high)`);
    }
  }
```

- [ ] **Step 5: Bump the `SYSTEM_PROMPT` sentence cap and widen the "may explain" clause**

In `SYSTEM_PROMPT` (~lines 170-174): in the "What you MAY do" list, replace the trailing bullet clause `whether the trailing stop is on` within the bot bullet with:

```
- Explain what the bot is currently set to do with it: the stop level; for the trailing stop, whether it is on, the price it arms at (when off) or its current trigger and the gain it has locked in (when on); how many ladder rungs remain; the wheel stage.
```

And change the final style line from `at most 4 sentences` to `at most 6 sentences`:

```
Style: at most 6 sentences. Plain language, calm, no hype, no markdown, no preamble. Present tense, second person ("you own…"). The UI appends its own "not advice" disclaimer, so do not add one.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd dashboard && npx vitest run tests/lib/position-coach.test.ts --pool=threads`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/api/_lib/position-coach.ts dashboard/tests/lib/position-coach.test.ts
git commit -m "feat(coach): narrate enriched trailing-stop figures in prompt + fallback readout"
```

---

## Task 3: Client mirror + parity test

**Files:**
- Modify: `dashboard/src/components/lookup/PositionCoachPanel.tsx` (`Facts` interface lines ~13-30; `deterministicReadout` lines ~47-69)
- Create: `dashboard/tests/lib/position-coach-parity.test.ts`

- [ ] **Step 1: Write the failing parity test**

Create `dashboard/tests/lib/position-coach-parity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildPositionFacts, deterministicReadout as serverReadout, type RawPosition, type RawStrategySym } from '../../api/_lib/position-coach';
import { deterministicReadout as clientReadout } from '../../src/components/lookup/PositionCoachPanel';

// The client re-implements deterministicReadout as an LLM-down fallback. It must
// produce a byte-identical string to the server's, or the panel would show
// different text depending on whether the model was up. This asserts parity
// across the trailing-stop branches (off / on-gain / on-loss / triggering / none).
const P = (over: Partial<RawPosition> = {}): RawPosition => ({ symbol: 'SNAP', qty: '5', avg_entry_price: '4.53', current_price: '4.42', asset_class: 'us_equity', side: 'long', ...over });

const CASES: Array<{ name: string; pos: RawPosition; strat: RawStrategySym | null }> = [
  { name: 'off',        pos: P(),                         strat: { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53, ladder_done: [false, false, false], initial_qty: 5 } },
  { name: 'on-gain',    pos: P({ current_price: '5.00' }), strat: { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 } },
  { name: 'on-loss',    pos: P({ current_price: '4.60' }), strat: { stop_price: 4.40, high_water_mark: 4.75, trailing_active: true, entry_price: 4.53 } },
  { name: 'triggering', pos: P({ current_price: '4.90' }), strat: { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 } },
  { name: 'no-state',   pos: P(),                         strat: null },
  { name: 'one-share',  pos: P({ qty: '1', current_price: '5.00' }), strat: { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 } },
];

describe('client/server deterministicReadout parity', () => {
  it.each(CASES)('matches for $name', ({ pos, strat }) => {
    const facts = buildPositionFacts('SNAP', 'live', pos, strat, null, []);
    expect(clientReadout(facts)).toBe(serverReadout(facts));
  });
});
```

- [ ] **Step 2: Run the parity test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/position-coach-parity.test.ts --pool=threads`
Expected: FAIL — the client readout doesn't yet render the trailing sentences (and `Facts` lacks `trailing_coach`).

- [ ] **Step 3: Add `trailing_coach` to the client `Facts` type**

In `dashboard/src/components/lookup/PositionCoachPanel.tsx`, add a type-only import below the existing imports (top of file):

```typescript
import type { TrailingCoach } from '../../../api/_lib/position-coach';
```

Then in the `Facts` interface (~lines 24-27), add the field after `trailing_active`:

```typescript
  stop_price: number | null;
  trailing_active: boolean | null;
  trailing_coach: TrailingCoach | null;
  ladder_rungs_total: number | null;
```

- [ ] **Step 4: Mirror the trailing formatter + readout clause in the client**

In `PositionCoachPanel.tsx`, add the mirrored formatter helpers just after the existing `fmtUsd` (~line 46). These MUST match `trailingReadoutSentences` in `position-coach.ts` exactly (the parity test enforces it):

```typescript
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}
// Mirror of trailingReadoutSentences() in api/_lib/position-coach.ts — kept in
// lockstep by tests/lib/position-coach-parity.test.ts.
function trailingReadoutSentences(tc: TrailingCoach, qty: number): string[] {
  const unit = qty === 1 ? 'share' : 'shares';
  if (tc.state === 'off') {
    const out = ['The trailing stop is off — it arms on its own once the price climbs to ' + fmtUsd(tc.activation_price) + ` (${Math.round(tc.activation_pct * 100)}% above entry).`];
    if (tc.activation_gap_abs != null && tc.activation_gap_pct != null) {
      out.push(`That's ${fmtUsd(tc.activation_gap_abs)} (${fmtPct(tc.activation_gap_pct)}) above the current price.`);
    }
    return out;
  }
  if (tc.state === 'triggering') {
    return [`The trailing stop is on and the price has fallen to its ${fmtUsd(tc.trigger_price)} trigger — the bot sells on its next cycle.`];
  }
  const out = [`The trailing stop is on, with its trigger at ${fmtUsd(tc.trigger_price)} — a stop that ratchets up as the price rises but never moves down.`];
  if (tc.locked_kind === 'gain') {
    out.push(`If it triggers, that locks in a gain of at least ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${qty} ${unit}) over your cost.`);
  } else {
    out.push(`Its trigger sits below your cost, so if it fires it caps the loss at ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${qty} ${unit}).`);
  }
  if (tc.next_raise_above != null) {
    out.push(`Your floor climbs the moment the price prints above ${fmtUsd(tc.next_raise_above)}; every new high drags the stop up ${Math.round(tc.trail_distance_pct * 100)}% behind it.`);
  }
  return out;
}
```

Then update the client `deterministicReadout` trailing clause (~lines 58-62). Replace:

```typescript
  if (f.stop_price != null) {
    parts.push(`The bot's stop is set at ${fmtUsd(f.stop_price)} — it sells automatically if the price falls there, realizing the loss. Trailing stop is ${f.trailing_active ? 'on' : 'off'}.`);
  } else if (!f.is_excluded) {
    parts.push("The bot hasn't recorded a stop for this symbol yet.");
  }
```

with (note: matches the server's wording — "which would realize the loss" — and appends the sentences):

```typescript
  if (f.stop_price != null) {
    parts.push(`The bot's stop is set at ${fmtUsd(f.stop_price)} — it sells automatically if the price falls there, which would realize the loss.`);
    if (f.trailing_coach) parts.push(...trailingReadoutSentences(f.trailing_coach, f.qty));
  } else if (!f.is_excluded) {
    parts.push("The bot hasn't recorded a stop for this symbol yet.");
  }
```

> NOTE: the pre-existing client readout said "realizing the loss" while the server said "which would realize the loss." They were already out of parity on that clause; this step aligns the client to the server. The parity test now locks them together.

- [ ] **Step 5: Run the parity test + full lib suite to verify pass**

Run: `cd dashboard && npx vitest run tests/lib/position-coach-parity.test.ts tests/lib/position-coach.test.ts --pool=threads`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/lookup/PositionCoachPanel.tsx dashboard/tests/lib/position-coach-parity.test.ts
git commit -m "feat(coach): mirror enriched trailing readout on the client + parity test"
```

---

## Task 4: Full verification + changelog + ship

**Files:**
- Modify: `dashboard/src/data/changelog.ts` (prepend one entry)
- Version bump via `npm run bump` (staged-set aware)

- [ ] **Step 1: Type-check the whole dashboard**

Run: `cd dashboard && npx tsc -b`
Expected: clean (no errors). If `TrailingCoach`'s type-only client import trips `erasableSyntaxOnly`, confirm it's `import type` (it is) — that satisfies the strict rule.

- [ ] **Step 2: Run the ENTIRE dashboard test suite**

Run: `cd dashboard && npx vitest run --pool=threads`
Expected: all files green (prior count 761 files-worth + the new parity file). No snapshot or count regressions elsewhere.

- [ ] **Step 3: Prepend a changelog entry**

In `dashboard/src/data/changelog.ts`, add as the FIRST array element (newest first):

```typescript
  {
    date: '2026-07-03',
    category: 'feature',
    title: 'Position Coach shows real trailing-stop numbers',
    details:
      "The /lookup coach now prints the figures a trader acts on. When the trailing stop is off it shows the price it arms at (+10% above entry) and how far that is from the current price; when on it shows the exact trigger, the locked-in floor (per-share and total over cost), and the price above which the stop next ratchets up. Flips to a worst-case-loss framing if the trigger is below cost, and to a 'bot sells next cycle' note if price has already reached the trigger. All figures computed deterministically server-side; the LLM only narrates them.",
  },
```

(If the exact `ChangelogEntry` field names differ, match the file's existing shape — read the first entry and mirror it.)

- [ ] **Step 4: Commit the changelog**

```bash
git add dashboard/src/data/changelog.ts
git commit -m "docs(changelog): position coach trailing-stop enrichment"
```

- [ ] **Step 5: Version bump (dashboard digit)**

From `dashboard/`, with all changes staged/committed:

```bash
cd dashboard && npm run bump
```

This reads the staged/committed set, ticks the dashboard digit (changes are under `dashboard/**`), and stages `build-version.ts`. Then commit:

```bash
git add dashboard/src/build-version.ts
git commit -m "chore: bump dashboard build version"
```

- [ ] **Step 6: Integration + deploy** — handled outside this plan via the finishing-a-development-branch skill (merge to main, then `npx vercel link --yes --project tradingbot-dashboard` + `npx vercel --prod` from `dashboard/`). Do NOT deploy from the worktree without linking first (worktree gotcha).

---

## Self-Review

**Spec coverage:**
- OFF: states it's off ✓ (Task 2/3 readout + prompt); activation price + distance-from-current ✓ (`state:'off'`, `activation_price`, `activation_gap_abs/pct`); distance from CURRENT not HWM ✓ (computed from `current_price`).
- ON: exact trigger ✓ (`trigger_price = stop_price`); locked-in floor $/share + total ✓ (`locked_per_share`/`locked_total`); loss-flip when trigger < cost ✓ (`locked_kind:'loss'`); sanity guard trigger ≥ current ✓ (`state:'triggering'`); next-raise = HWM with wording ✓ (`next_raise_above`); trail distance behind high ✓ (`trail_distance_pct`, "5% behind").
- Both questions confirmed in code and encoded as constants ✓.
- Threshold (not toggle) ✓ — OFF branch shows activation price, never the "enable starts immediately" wording.

**Placeholder scan:** none — every step has full code.

**Type consistency:** `TrailingCoach` field names identical across type def, helper, prompt, both readouts, and tests (`activation_price`, `activation_gap_abs`, `activation_gap_pct`, `trigger_price`, `locked_kind`, `locked_per_share`, `locked_total`, `next_raise_above`, `activation_pct`, `trail_distance_pct`, `state`). `trailingReadoutSentences(tc, qty)` signature identical server + client. `computeTrailingCoach` arg keys match `buildPositionFacts` call site.

**Known parity note:** the client readout's pre-existing "realizing the loss" wording is aligned to the server's "which would realize the loss" in Task 3 Step 4 — intentional, and now locked by the parity test.
