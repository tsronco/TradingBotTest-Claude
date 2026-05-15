# Dashboard Spread Order Form (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard order form for opening put credit spreads on the manual paper account, with live + auto-graded follow-through.

**Architecture:** Backend gets a new `spread` payload shape on `/api/trades/preview` and `/api/trades/submit`, a `SpreadDetails` extension to the `Trade` type, an mleg branch in `syncFillData`, and a spread-aware AI grading prompt. Frontend gets a new `SpreadOrderForm.tsx`, a third URL-param branch in `OrderNew.tsx`, a "Build Put Credit Spread" button on every options-chain-bearing symbol in `Lookup.tsx`, and spread-aware rendering on `Trades.tsx` + `TradeDetail.tsx`. A new `max_risk_per_spread` rule trigger is added to the existing manual rules engine with a $500 warn default seeded on first /rules visit.

**Tech Stack:** React 19 · Vite · Vercel serverless · Upstash Redis (KV) · vitest · Alpaca paper API (`order_class: mleg`).

**Spec:** [2026-05-15-dashboard-spread-form-design.md](docs/superpowers/specs/2026-05-15-dashboard-spread-form-design.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `dashboard/api/_lib/trade-types.ts` | Modify | Add `SpreadDetails` interface and optional `spread?: SpreadDetails` field on `Trade`. Frontend re-export shim at `dashboard/src/lib/trade-types.ts` is unchanged — TypeScript flows the new fields through automatically. |
| `dashboard/api/_lib/exposure.ts` | Modify | Add spread branch returning `(width - net_credit) × 100 × qty`. |
| `dashboard/api/_lib/rules-types.ts` | Modify | Add new trigger kind `max_risk_per_spread` with `{ max_dollars: number }` config. |
| `dashboard/api/_lib/rule-check.ts` | Modify | Evaluator branch for the new trigger: fires when input has `spread` populated and `(spread.max_loss * 100 * qty) > max_dollars`. |
| `dashboard/api/_lib/grading.ts` | Modify | New prompt branch in `buildEntryGradingPrompt` and `buildHindsightGradingPrompt` when `trade.spread != null`. |
| `dashboard/api/trades/[action].ts` | Modify | Preview + submit handlers detect spread payloads and route accordingly. Spread submit builds the mleg Alpaca order. |
| `dashboard/api/cron/[job].ts` | Modify | `syncFillData` walks both leg fills from the mleg Alpaca order response and populates `trade.spread.short_leg.fill_price` + `long_leg.fill_price`. |
| `dashboard/api/rules/[resource].ts` | Modify | GET on `resource=manual` seeds a default `max_risk_per_spread` rule with `$500 warn` if no rule of that trigger kind exists. |
| `dashboard/src/routes/OrderNew.tsx` | Modify | Add third URL-param branch `?spread=put_credit&symbol=AAL` → renders `SpreadOrderForm`. |
| `dashboard/src/components/order/SpreadOrderForm.tsx` | Create | Two-strike spread form with grade + reasoning + review flow. |
| `dashboard/src/components/order/ConfirmModal.tsx` | Modify | Spread-aware confirm copy showing both legs + net credit + max loss. |
| `dashboard/src/routes/Lookup.tsx` | Modify | Add "Build Put Credit Spread" button when symbol has an options chain. |
| `dashboard/src/routes/Trades.tsx` | Modify | Single-row render for `trade.spread != null`. |
| `dashboard/src/routes/TradeDetail.tsx` | Modify | Spread metadata block + both strike markers on the chart. |
| `dashboard/src/routes/Rules.tsx` | Modify | Display the `max_risk_per_spread` rule with edit affordance. |

**No new Vercel functions added.** All backend changes live in existing function files (`trades/[action].ts`, `cron/[job].ts`, `rules/[resource].ts`, `_lib/`). Confirmed dashboard stays at 10 of 12 Hobby cap.

---

### Task 1: `SpreadDetails` type + `Trade.spread` field

**Files:**
- Modify: `dashboard/api/_lib/trade-types.ts`
- Test: `dashboard/tests/types.spec.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/types.spec.ts`:

```ts
import type { Trade, SpreadDetails } from '../api/_lib/trade-types';

it('Trade has optional spread field with full SpreadDetails shape', () => {
  const sp: SpreadDetails = {
    spread_type: 'put_credit',
    short_leg: {
      occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37,
      fill_price: 0.37, qty: 1,
    },
    long_leg: {
      occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12,
      fill_price: 0.12, qty: 1,
    },
    expiration: '2026-05-29',
    width: 1.0,
    net_credit: 0.25,
    max_loss: 0.75,
  };
  const trade: Partial<Trade> = { id: 'T-2026-05-15-001', spread: sp };
  expect(trade.spread?.short_leg.strike).toBe(12.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- tests/types.spec.ts
```
Expected: FAIL with "SpreadDetails is not exported".

- [ ] **Step 3: Add `SpreadDetails` and `Trade.spread`**

In `dashboard/api/_lib/trade-types.ts`, after the `ModifyEvent` interface declaration (around line 56), add:

```ts
export interface SpreadLeg {
  occ: string;
  strike: number;
  entry_premium: number | null;   // null until fill
  fill_price: number | null;      // null until fill; populated by syncFillData
  qty: number;
}

export interface SpreadDetails {
  spread_type: 'put_credit';      // call_credit / debit added later
  short_leg: SpreadLeg;
  long_leg: SpreadLeg;
  expiration: string;             // ISO date "2026-05-29"
  width: number;                  // |short_strike - long_strike|
  net_credit: number;             // updated from order target to actual on fill
  max_loss: number;               // width - net_credit
}
```

Then inside `Trade`, add immediately before the `ai_grade_inherited?: boolean;` field:

```ts
  spread?: SpreadDetails;
```

In the frontend re-export shim `dashboard/src/lib/trade-types.ts`, add `SpreadLeg, SpreadDetails` to the existing `export type {...}` block.

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test -- tests/types.spec.ts
```
Expected: PASS.

```bash
cd dashboard && npm test
```
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/trade-types.ts dashboard/src/lib/trade-types.ts dashboard/tests/types.spec.ts
git commit -m "trade-types: add SpreadDetails + Trade.spread field"
```

---

### Task 2: Spread exposure branch

**Files:**
- Modify: `dashboard/api/_lib/exposure.ts`
- Test: `dashboard/tests/exposure.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/exposure.spec.ts`:

```ts
import { computeExposure } from '../api/_lib/exposure';

it('computes spread exposure as (width - credit) * 100 * qty', () => {
  const exposure = computeExposure({
    asset_class: 'spread',
    side: 'STO',  // ignored for spreads
    qty: 1,
    order_type: 'limit',
    limit_price: -0.25,
    spread: {
      width: 1.0,
      net_credit: 0.25,
      max_loss: 0.75,
    },
  });
  expect(exposure).toBe(75);  // 0.75 * 100 * 1
});

it('scales spread exposure by qty', () => {
  const exposure = computeExposure({
    asset_class: 'spread',
    side: 'STO',
    qty: 3,
    order_type: 'limit',
    limit_price: -0.25,
    spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
  });
  expect(exposure).toBe(225);  // 0.75 * 100 * 3
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- tests/exposure.spec.ts
```
Expected: FAIL with type error on `asset_class: 'spread'`.

- [ ] **Step 3: Extend `computeExposure`**

In `dashboard/api/_lib/trade-types.ts`, update the `AssetClass` union:

```ts
export type AssetClass = 'stock' | 'option' | 'spread';
```

In `dashboard/api/_lib/exposure.ts`, replace the file's content with:

```ts
import type { AssetClass, OrderSide, OrderType, ContractType } from './trade-types.js';

export interface ExposureSpreadInput {
  width: number;
  net_credit: number;
  max_loss: number;
}

export interface ExposureInput {
  asset_class: AssetClass;
  side: OrderSide;
  qty: number;
  order_type: OrderType;
  limit_price: number | null;
  contract_type?: ContractType | null;
  strike?: number | null;
  ask?: number | null;
  bid?: number | null;
  spread?: ExposureSpreadInput;
}

export function computeExposure(input: ExposureInput): number {
  const { asset_class, side, qty, order_type, limit_price, ask, bid, strike, contract_type, spread } = input;

  if (asset_class === 'spread') {
    if (!spread) return 0;
    return spread.max_loss * 100 * qty;
  }

  if (asset_class === 'stock') {
    const px = order_type === 'market'
      ? side === 'buy' ? (ask ?? 0) : (bid ?? 0)
      : (limit_price ?? 0);
    return qty * px;
  }

  // option
  const px = order_type === 'market'
    ? (side === 'BTO' || side === 'BTC') ? (ask ?? 0) : (bid ?? 0)
    : (limit_price ?? 0);

  if (side === 'STO' && contract_type === 'put') {
    return (strike ?? 0) * qty * 100;
  }
  return qty * px * 100;
}
```

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test
```
Expected: All pass including the 2 new spread exposure tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/exposure.ts dashboard/api/_lib/trade-types.ts dashboard/src/lib/trade-types.ts dashboard/tests/exposure.spec.ts
git commit -m "exposure: branch for spread asset class (max_loss × 100 × qty)"
```

---

### Task 3: `max_risk_per_spread` rule trigger

**Files:**
- Modify: `dashboard/api/_lib/rules-types.ts`
- Modify: `dashboard/api/_lib/rule-check.ts`
- Test: `dashboard/tests/rule-check.spec.ts` (existing)

- [ ] **Step 1: Read the existing trigger DSL**

Open `dashboard/api/_lib/rules-types.ts` and `dashboard/api/_lib/rule-check.ts`. Note the existing `Trigger` union and how `evaluateTrigger` dispatches on `trigger.kind`. Identify the precise pattern (typically a discriminated union — every trigger kind has `kind: '<name>'` and other config fields).

- [ ] **Step 2: Write the failing test**

Append to `dashboard/tests/rule-check.spec.ts`:

```ts
import { runRuleChecks } from '../api/_lib/rule-check';
import { kv } from '../api/_lib/kv';

it('emits warn when spread risk exceeds max_risk_per_spread cap', async () => {
  await kv().set('rules:manual', [
    {
      id: 'r1',
      title: 'Max risk per spread',
      severity: 'warn',
      triggers: [{ kind: 'max_risk_per_spread', max_dollars: 50 }],
    },
  ]);
  const violations = await runRuleChecks({
    asset_class: 'spread',
    symbol: 'AAL',
    qty: 1,
    account: 'manual_paper',
    spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
  });
  expect(violations).toContainEqual(
    expect.objectContaining({ rule: 'r1', severity: 'warn' })
  );
});

it('does not fire max_risk_per_spread when risk is under cap', async () => {
  await kv().set('rules:manual', [
    {
      id: 'r1', title: 'Max risk per spread', severity: 'warn',
      triggers: [{ kind: 'max_risk_per_spread', max_dollars: 100 }],
    },
  ]);
  const violations = await runRuleChecks({
    asset_class: 'spread', symbol: 'AAL', qty: 1, account: 'manual_paper',
    spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
  });
  expect(violations.filter(v => v.rule === 'r1')).toHaveLength(0);
});

it('blocks when severity is block and risk exceeds cap', async () => {
  await kv().set('rules:manual', [
    {
      id: 'r1', title: 'Max risk per spread', severity: 'block',
      triggers: [{ kind: 'max_risk_per_spread', max_dollars: 50 }],
    },
  ]);
  const violations = await runRuleChecks({
    asset_class: 'spread', symbol: 'AAL', qty: 1, account: 'manual_paper',
    spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
  });
  expect(violations).toContainEqual(
    expect.objectContaining({ rule: 'r1', severity: 'block' })
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd dashboard && npm test -- tests/rule-check.spec.ts
```
Expected: FAIL with type error on `kind: 'max_risk_per_spread'` (not in `Trigger` union) and on `RuleCheckInput.spread` (field doesn't exist).

- [ ] **Step 4: Add the new trigger kind to `rules-types.ts`**

In `dashboard/api/_lib/rules-types.ts`, find the `Trigger` union (it's a discriminated union of trigger shapes). Add a new variant:

```ts
| { kind: 'max_risk_per_spread'; max_dollars: number }
```

- [ ] **Step 5: Add `spread` field to `RuleCheckInput`**

In `dashboard/api/_lib/rule-check.ts`, extend the `RuleCheckInput` interface:

```ts
export interface RuleCheckInput {
  asset_class: AssetClass;
  symbol: string;
  qty: number;
  account: AccountId;
  side?: OrderSide;
  option_type?: 'put' | 'call';
  strike?: number | null;
  expiration?: string | null;
  tags?: string[];
  spread?: { width: number; net_credit: number; max_loss: number };
}
```

- [ ] **Step 6: Add the trigger evaluator branch**

In `dashboard/api/_lib/rule-check.ts`, find the `evaluateTrigger` function. Add a new case for `max_risk_per_spread`:

```ts
case 'max_risk_per_spread': {
  if (!input.spread) return false;
  const risk_dollars = input.spread.max_loss * 100 * input.qty;
  return risk_dollars > t.max_dollars;
}
```

(Place this case alongside the other `case` blocks in the `switch (t.kind)` statement.)

- [ ] **Step 7: Run tests**

```bash
cd dashboard && npm test -- tests/rule-check.spec.ts
```
Expected: All 3 new tests PASS.

```bash
cd dashboard && npm test
```
Expected: Full suite passes.

- [ ] **Step 8: Commit**

```bash
git add dashboard/api/_lib/rules-types.ts dashboard/api/_lib/rule-check.ts dashboard/tests/rule-check.spec.ts
git commit -m "rules: add max_risk_per_spread trigger kind"
```

---

### Task 4: Default `max_risk_per_spread` seeding on `GET /api/rules?resource=manual`

**Files:**
- Modify: `dashboard/api/rules/[resource].ts`
- Test: `dashboard/tests/rules-api.spec.ts` (new or existing)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/rules-api.spec.ts` (create if missing — verify file existence first, otherwise create with imports and one test):

```ts
import { kv } from '../api/_lib/kv';
import { GET as rulesGET } from '../api/rules/[resource]';
import { rulesKey } from '../api/_lib/kv-keys';

it('seeds a default max_risk_per_spread rule with $500 warn on first GET', async () => {
  await kv().del(rulesKey('manual'));
  const req = new Request('http://localhost/api/rules?resource=manual', {
    method: 'GET',
    headers: { cookie: 'session=test-valid' },
  });
  const res = await rulesGET(req);
  const data = await res.json() as any[];
  const defaultRule = data.find((r) => r.triggers?.some((t: any) => t.kind === 'max_risk_per_spread'));
  expect(defaultRule).toBeTruthy();
  expect(defaultRule.severity).toBe('warn');
  expect(defaultRule.triggers[0].max_dollars).toBe(500);
});

it('does not overwrite an existing user-edited max_risk_per_spread rule', async () => {
  await kv().set('rules:manual', [
    {
      id: 'user-rule', title: 'My custom cap', severity: 'block',
      triggers: [{ kind: 'max_risk_per_spread', max_dollars: 250 }],
    },
  ]);
  const req = new Request('http://localhost/api/rules?resource=manual', {
    method: 'GET',
    headers: { cookie: 'session=test-valid' },
  });
  const res = await rulesGET(req);
  const data = await res.json() as any[];
  const userRule = data.find((r) => r.id === 'user-rule');
  expect(userRule.severity).toBe('block');
  expect(userRule.triggers[0].max_dollars).toBe(250);
});
```

(If `dashboard/tests/rules-api.spec.ts` doesn't exist, also add at the top:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
```)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- tests/rules-api.spec.ts
```
Expected: FAIL — no auto-seeded rule.

- [ ] **Step 3: Add the seeding logic**

In `dashboard/api/rules/[resource].ts`, find the GET handler for `resource=manual`. Add seeding logic immediately after reading the rules from KV:

```ts
async function ensureDefaultSpreadRiskRule(rules: ManualRule[]): Promise<ManualRule[]> {
  const hasRule = rules.some(r =>
    r.triggers?.some(t => t.kind === 'max_risk_per_spread')
  );
  if (hasRule) return rules;
  const seeded: ManualRule = {
    id: newId(),
    title: 'Max risk per spread',
    severity: 'warn',
    triggers: [{ kind: 'max_risk_per_spread', max_dollars: 500 }],
  };
  const updated = [...rules, seeded];
  await kv().set(rulesKey('manual'), updated);
  return updated;
}
```

Then call it in the GET path right before the response is built:

```ts
const manualRulesRaw = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];
const manualRules = await ensureDefaultSpreadRiskRule(manualRulesRaw);
return Response.json(manualRules);
```

(Adapt to the existing handler signature — if the GET handler uses `req.query.resource` to dispatch, only seed when resource === 'manual'.)

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test -- tests/rules-api.spec.ts
```
Expected: Both tests pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/rules/[resource].ts dashboard/tests/rules-api.spec.ts
git commit -m "rules: seed default max_risk_per_spread \$500 warn on first GET"
```

---

### Task 5: Spread preview + submit handlers

**Files:**
- Modify: `dashboard/api/trades/[action].ts`
- Test: `dashboard/tests/trades-submit.spec.ts`, `dashboard/tests/trades-preview.spec.ts`

- [ ] **Step 1: Write the failing preview test**

Append to `dashboard/tests/trades-preview.spec.ts`:

```ts
import { POST as previewPOST } from '../api/trades/[action]';

it('previews a spread payload and returns spread exposure', async () => {
  const body = {
    action: 'preview',
    payload: {
      kind: 'spread',
      account: 'manual_paper',
      symbol: 'AAL',
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
      expiration: '2026-05-29',
      qty: 1,
      limit_price: -0.25,
      entry_grade: 'B+',
      entry_reasoning: 'Bullish AAL above $12.50',
    },
  };
  const req = new Request('http://localhost/api/trades/preview', {
    method: 'POST',
    headers: { cookie: 'session=test-valid', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await previewPOST(req);
  const data = await res.json() as any;
  expect(res.status).toBe(200);
  expect(data.exposure).toBe(75);
  expect(Array.isArray(data.rule_warnings)).toBe(true);
});
```

- [ ] **Step 2: Write the failing submit test**

Append to `dashboard/tests/trades-submit.spec.ts`:

```ts
import { POST as submitPOST } from '../api/trades/[action]';
import { kv } from '../api/_lib/kv';

it('submits a spread payload and writes a trade record with spread block', async () => {
  // Mock the Alpaca mleg POST
  const fetchMock = vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ id: 'alpaca-mleg-1', status: 'new' }),
    { status: 200 },
  ));
  vi.stubGlobal('fetch', fetchMock);

  const body = {
    action: 'submit',
    payload: {
      kind: 'spread',
      account: 'manual_paper',
      symbol: 'AAL',
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
      expiration: '2026-05-29',
      qty: 1,
      limit_price: -0.25,
      entry_grade: 'B+',
      entry_reasoning: 'Bullish AAL above $12.50',
    },
  };
  const req = new Request('http://localhost/api/trades/submit', {
    method: 'POST',
    headers: { cookie: 'session=test-valid', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await submitPOST(req);
  const data = await res.json() as any;
  expect(res.status).toBe(200);
  expect(data.trade_id).toMatch(/^T-\d{4}-\d{2}-\d{2}-\d{3}$/);
  expect(data.alpaca_order_id).toBe('alpaca-mleg-1');

  // Verify the Alpaca call shape
  const alpacaCall = fetchMock.mock.calls[0];
  expect(alpacaCall[0]).toContain('/v2/orders');
  const sentBody = JSON.parse(alpacaCall[1].body);
  expect(sentBody.order_class).toBe('mleg');
  expect(sentBody.qty).toBe('1');
  expect(sentBody.legs).toHaveLength(2);
  expect(sentBody.legs.find((l: any) => l.symbol === 'AAL260529P00012500').side).toBe('sell');
  expect(sentBody.legs.find((l: any) => l.symbol === 'AAL260529P00011500').side).toBe('buy');

  // Verify the trade record
  const trade = await kv().get<any>(`trade:${data.trade_id}`);
  expect(trade.spread).toBeTruthy();
  expect(trade.spread.short_leg.strike).toBe(12.5);
  expect(trade.spread.long_leg.strike).toBe(11.5);
  expect(trade.spread.net_credit).toBe(0.25);
  expect(trade.spread.max_loss).toBe(0.75);
  expect(trade.filled_at).toBeNull();
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd dashboard && npm test -- tests/trades-preview.spec.ts tests/trades-submit.spec.ts
```
Expected: FAIL — handler doesn't recognize `kind: 'spread'`.

- [ ] **Step 4: Add spread preview branch in `[action].ts`**

In `dashboard/api/trades/[action].ts`, find the preview handler. Add a branch near the top of the handler logic (after parsing the body):

```ts
if (payload.kind === 'spread') {
  const exposure = computeExposure({
    asset_class: 'spread',
    side: 'STO',  // unused but required by signature
    qty: payload.qty,
    order_type: 'limit',
    limit_price: payload.limit_price,
    spread: {
      width: Math.abs(payload.short_leg.strike - payload.long_leg.strike),
      net_credit: Math.abs(payload.limit_price),  // negative limit = credit
      max_loss: Math.abs(payload.short_leg.strike - payload.long_leg.strike) - Math.abs(payload.limit_price),
    },
  });
  const ruleWarnings = await runRuleChecks({
    asset_class: 'spread',
    symbol: payload.symbol,
    qty: payload.qty,
    account: payload.account,
    expiration: payload.expiration,
    spread: {
      width: Math.abs(payload.short_leg.strike - payload.long_leg.strike),
      net_credit: Math.abs(payload.limit_price),
      max_loss: Math.abs(payload.short_leg.strike - payload.long_leg.strike) - Math.abs(payload.limit_price),
    },
  });
  const requires_totp = await checkTotpRequired(payload.account, exposure);
  return Response.json({
    exposure,
    requires_totp,
    rule_warnings: ruleWarnings,
    draft: payload,
  });
}
```

- [ ] **Step 5: Add spread submit branch in `[action].ts`**

In the submit handler, add a parallel branch (before the existing stock/option branches):

```ts
if (payload.kind === 'spread') {
  const tradeId = await generateTradeId();
  const width = Math.abs(payload.short_leg.strike - payload.long_leg.strike);
  const netCredit = Math.abs(payload.limit_price);
  const maxLoss = width - netCredit;

  // Build mleg Alpaca order
  const alpacaBody = {
    order_class: 'mleg',
    qty: String(payload.qty),
    type: 'limit',
    limit_price: String(payload.limit_price),
    time_in_force: 'day',
    legs: [
      { symbol: payload.short_leg.occ, side: 'sell', ratio_qty: '1', position_intent: 'sell_to_open' },
      { symbol: payload.long_leg.occ,  side: 'buy',  ratio_qty: '1', position_intent: 'buy_to_open'  },
    ],
  };
  const order = await alpacaTradeMutation(payload.account, '/orders', 'POST', alpacaBody);

  const trade: Trade = {
    id: tradeId,
    account: payload.account,
    asset_class: 'spread',
    symbol: payload.symbol,
    side: 'STO',  // not really meaningful for spreads but Trade requires it
    qty: payload.qty,
    order_type: 'limit',
    limit_price: payload.limit_price,
    stop_price: null,
    trail_pct: null,
    tif: 'day',
    contract_symbol: payload.short_leg.occ,  // short leg for back-compat
    strike: payload.short_leg.strike,
    expiration: payload.expiration,
    contract_type: 'put',
    greeks_at_entry: null,
    alpaca_order_id: order.id,
    alpaca_close_order_id: null,
    submitted_at: new Date().toISOString(),
    filled_at: null,
    filled_avg_price: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    tags: [],
    entry_grade: payload.entry_grade,
    entry_reasoning: payload.entry_reasoning,
    journal: '',
    exposure_at_submit: maxLoss * 100 * payload.qty,
    rule_warnings_at_entry: payload.rule_warnings_at_entry ?? [],
    schema: 1,
    spread: {
      spread_type: 'put_credit',
      short_leg: {
        occ: payload.short_leg.occ,
        strike: payload.short_leg.strike,
        entry_premium: payload.short_leg.entry_premium,
        fill_price: null,
        qty: payload.qty,
      },
      long_leg: {
        occ: payload.long_leg.occ,
        strike: payload.long_leg.strike,
        entry_premium: payload.long_leg.entry_premium,
        fill_price: null,
        qty: payload.qty,
      },
      expiration: payload.expiration,
      width,
      net_credit: netCredit,
      max_loss: maxLoss,
    },
  };
  await kv().set(`trade:${tradeId}`, trade);
  await kv().rpush('trades:index:open', tradeId);
  return Response.json({ trade_id: tradeId, alpaca_order_id: order.id });
}
```

(Adapt imports as needed — `alpacaTradeMutation`, `Trade`, `runRuleChecks`, `computeExposure`, `generateTradeId`, `checkTotpRequired` may already be imported in this file.)

- [ ] **Step 6: Run tests**

```bash
cd dashboard && npm test -- tests/trades-preview.spec.ts tests/trades-submit.spec.ts
```
Expected: Both new spread tests pass; existing tests untouched.

```bash
cd dashboard && npm test
```
Expected: Full suite green.

- [ ] **Step 7: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/trades-preview.spec.ts dashboard/tests/trades-submit.spec.ts
git commit -m "trades-api: preview + submit branches for spread payloads"
```

---

### Task 6: `syncFillData` mleg branch in cron

**Files:**
- Modify: `dashboard/api/cron/[job].ts`
- Test: `dashboard/tests/cron-grade.spec.ts` (existing, find the syncFillData tests)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/cron-grade.spec.ts`:

```ts
it('syncFillData populates both leg fills for an mleg spread order', async () => {
  // Seed an open spread trade
  const trade = {
    id: 'T-2026-05-15-001',
    account: 'manual_paper',
    asset_class: 'spread',
    alpaca_order_id: 'alpaca-mleg-1',
    submitted_at: '2026-05-15T14:00:00Z',
    filled_at: null,
    spread: {
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37, fill_price: null, qty: 1 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12, fill_price: null, qty: 1 },
      net_credit: 0.25, max_loss: 0.75, width: 1.0, expiration: '2026-05-29',
    },
    // ... rest of Trade fields filled in
  };
  await kv().set('trade:T-2026-05-15-001', trade);

  // Mock Alpaca returning a filled mleg order with both legs populated
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'alpaca-mleg-1',
    status: 'filled',
    filled_at: '2026-05-15T14:05:00Z',
    legs: [
      { symbol: 'AAL260529P00012500', side: 'sell', filled_avg_price: '0.37', filled_qty: '1' },
      { symbol: 'AAL260529P00011500', side: 'buy',  filled_avg_price: '0.12', filled_qty: '1' },
    ],
  }), { status: 200 })));

  await syncFillData(trade);

  const updated = await kv().get<any>('trade:T-2026-05-15-001');
  expect(updated.filled_at).toBe('2026-05-15T14:05:00Z');
  expect(updated.spread.short_leg.fill_price).toBe(0.37);
  expect(updated.spread.long_leg.fill_price).toBe(0.12);
  expect(updated.spread.net_credit).toBeCloseTo(0.25);  // actual from fills
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- tests/cron-grade.spec.ts -t "mleg spread"
```
Expected: FAIL — `syncFillData` doesn't know how to walk legs.

- [ ] **Step 3: Add mleg branch in `syncFillData`**

In `dashboard/api/cron/[job].ts`, find the `syncFillData` function. Add a branch at the top of the body that handles spreads:

```ts
async function syncFillData(trade: Trade): Promise<void> {
  // Spread (mleg) path
  if (trade.asset_class === 'spread' && trade.spread) {
    const order = await fetchAlpacaOrder(trade.account, trade.alpaca_order_id);
    if (!order || order.status !== 'filled') return;
    const legs = order.legs ?? [];
    const shortFill = legs.find((l: any) => l.symbol === trade.spread!.short_leg.occ);
    const longFill = legs.find((l: any) => l.symbol === trade.spread!.long_leg.occ);
    if (!shortFill || !longFill) return;
    trade.filled_at = order.filled_at ?? new Date().toISOString();
    trade.spread.short_leg.fill_price = parseFloat(shortFill.filled_avg_price);
    trade.spread.long_leg.fill_price = parseFloat(longFill.filled_avg_price);
    trade.spread.net_credit = trade.spread.short_leg.fill_price - trade.spread.long_leg.fill_price;
    trade.spread.max_loss = trade.spread.width - trade.spread.net_credit;
    trade.filled_avg_price = trade.spread.net_credit;  // for legacy fields
    await kv().set(tradeKey(trade.id), trade);
    return;
  }

  // ... existing single-leg path stays here unchanged ...
}
```

(If `fetchAlpacaOrder` doesn't exist, use the same helper the single-leg path uses.)

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test -- tests/cron-grade.spec.ts
```
Expected: All existing + 1 new test pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/cron/[job].ts dashboard/tests/cron-grade.spec.ts
git commit -m "cron: syncFillData branch for mleg spread fills"
```

---

### Task 7: AI grading prompt branch for spreads

**Files:**
- Modify: `dashboard/api/_lib/grading.ts`
- Test: `dashboard/tests/grading.spec.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/grading.spec.ts`:

```ts
import { buildEntryGradingPrompt, buildHindsightGradingPrompt } from '../api/_lib/grading';

it('entry grading prompt mentions both legs and credit for spread trades', () => {
  const trade: any = {
    asset_class: 'spread',
    symbol: 'AAL',
    submitted_at: '2026-05-15T14:00:00Z',
    entry_grade: 'B+',
    entry_reasoning: 'Bullish AAL above $12.50',
    spread: {
      spread_type: 'put_credit',
      short_leg: { strike: 12.5 },
      long_leg: { strike: 11.5 },
      net_credit: 0.25,
      max_loss: 0.75,
      expiration: '2026-05-29',
    },
  };
  const prompt = buildEntryGradingPrompt(trade);
  expect(prompt).toContain('put credit spread');
  expect(prompt).toContain('12.5');
  expect(prompt).toContain('11.5');
  expect(prompt).toContain('0.25');
  expect(prompt).toContain('0.75');
});

it('hindsight grading prompt computes spread close P&L from leg mids', () => {
  const trade: any = {
    asset_class: 'spread',
    symbol: 'AAL',
    closed_at: '2026-05-25T20:00:00Z',
    closed_avg_price: 0.12,  // half of credit
    closed_by: 'manual',
    spread: {
      spread_type: 'put_credit',
      short_leg: { strike: 12.5, fill_price: 0.37 },
      long_leg: { strike: 11.5, fill_price: 0.12 },
      net_credit: 0.25,
      max_loss: 0.75,
      expiration: '2026-05-29',
    },
  };
  const prompt = buildHindsightGradingPrompt(trade);
  expect(prompt).toContain('put credit spread');
  expect(prompt).toContain('closed');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- tests/grading.spec.ts -t "spread"
```
Expected: FAIL — prompt doesn't include spread-specific text.

- [ ] **Step 3: Add spread branch in `buildEntryGradingPrompt`**

In `dashboard/api/_lib/grading.ts`, find `buildEntryGradingPrompt`. At the top of the function body, add a guard:

```ts
export function buildEntryGradingPrompt(trade: Trade): string {
  if (trade.asset_class === 'spread' && trade.spread) {
    const sp = trade.spread;
    return `You are grading a paper put credit spread trade entry.

Underlying: ${trade.symbol}
Short ${sp.short_leg.strike} put / Long ${sp.long_leg.strike} put
Expiration: ${sp.expiration}
Net credit at open: $${sp.net_credit.toFixed(2)}
Max loss: $${sp.max_loss.toFixed(2)}

User self-grade: ${trade.entry_grade}
User reasoning: ${trade.entry_reasoning}

Grade the entry decision A+ through F. Return your grade letter, then a one-paragraph review of the entry, considering: (1) strike selection vs spot, (2) DTE choice, (3) risk/reward (credit vs max loss), (4) overall setup quality. Do not consider hindsight.`;
  }
  // ... existing single-leg path ...
}
```

(Keep the existing single-leg path unchanged after this guard.)

- [ ] **Step 4: Add spread branch in `buildHindsightGradingPrompt`**

In the same file, find `buildHindsightGradingPrompt`. Add a similar guard:

```ts
export function buildHindsightGradingPrompt(trade: Trade): string {
  if (trade.asset_class === 'spread' && trade.spread) {
    const sp = trade.spread;
    const closeValue = trade.closed_avg_price ?? 0;
    const profitDollars = (sp.net_credit - closeValue) * 100 * sp.short_leg.qty;
    return `You are doing a hindsight review of a closed paper put credit spread.

Underlying: ${trade.symbol}
Short ${sp.short_leg.strike} put / Long ${sp.long_leg.strike} put
Expiration: ${sp.expiration}
Net credit at open: $${sp.net_credit.toFixed(2)}
Cost to close: $${closeValue.toFixed(2)}
Realized: $${profitDollars.toFixed(2)} (${trade.closed_by})

User entry grade: ${trade.entry_grade}
User reasoning: ${trade.entry_reasoning}

With hindsight, grade the entry decision A+ through F. Return your grade letter, then a one-paragraph review considering whether the result confirms or undermines the entry thesis. Discuss any tendencies you notice.`;
  }
  // ... existing single-leg path ...
}
```

- [ ] **Step 5: Run tests**

```bash
cd dashboard && npm test -- tests/grading.spec.ts
```
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/api/_lib/grading.ts dashboard/tests/grading.spec.ts
git commit -m "grading: prompt branches for spread trades (entry + hindsight)"
```

---

### Task 8: `SpreadOrderForm` component

**Files:**
- Create: `dashboard/src/components/order/SpreadOrderForm.tsx`
- Test: `dashboard/tests/SpreadOrderForm.spec.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/SpreadOrderForm.spec.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SpreadOrderForm } from '../src/components/order/SpreadOrderForm';

const chainResponse = {
  expirations: ['2026-05-29', '2026-06-19'],
  contracts: [
    { symbol: 'AAL260529P00012500', strike: 12.5, expiration: '2026-05-29', type: 'put', bid: 0.36, ask: 0.42 },
    { symbol: 'AAL260529P00011500', strike: 11.5, expiration: '2026-05-29', type: 'put', bid: 0.10, ask: 0.14 },
    { symbol: 'AAL260529P00010500', strike: 10.5, expiration: '2026-05-29', type: 'put', bid: 0.03, ask: 0.06 },
  ],
};

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(chainResponse), { status: 200 }));
});

it('renders expiration + both strike dropdowns + grade + reasoning', async () => {
  const setAccount = vi.fn();
  const onReview = vi.fn();
  render(<SpreadOrderForm symbol="AAL" account="manual_paper" setAccount={setAccount} onReview={onReview} />);
  expect(screen.getByLabelText(/expiration/i)).toBeInTheDocument();
  await waitFor(() => screen.getByLabelText(/short strike/i));
  expect(screen.getByLabelText(/short strike/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/long strike/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/grade/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/reasoning/i)).toBeInTheDocument();
});

it('filters long-strike options to strikes below the selected short strike', async () => {
  render(<SpreadOrderForm symbol="AAL" account="manual_paper" setAccount={vi.fn()} onReview={vi.fn()} />);
  await waitFor(() => screen.getByLabelText(/expiration/i));
  fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
  await waitFor(() => screen.getByLabelText(/short strike/i));
  fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
  const longSelect = screen.getByLabelText(/long strike/i) as HTMLSelectElement;
  const longOptions = Array.from(longSelect.options).map(o => o.value).filter(v => v);
  expect(longOptions).toContain('11.5');
  expect(longOptions).toContain('10.5');
  expect(longOptions).not.toContain('12.5');
});

it('submits the spread payload to /api/trades/preview when Review is clicked', async () => {
  const onReview = vi.fn();
  render(<SpreadOrderForm symbol="AAL" account="manual_paper" setAccount={vi.fn()} onReview={onReview} />);
  await waitFor(() => screen.getByLabelText(/expiration/i));
  fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
  await waitFor(() => screen.getByLabelText(/short strike/i));
  fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
  fireEvent.change(screen.getByLabelText(/long strike/i), { target: { value: '11.5' } });
  fireEvent.change(screen.getByLabelText(/grade/i), { target: { value: 'B+' } });
  fireEvent.change(screen.getByLabelText(/reasoning/i), { target: { value: 'Bullish AAL above $12.50' } });

  globalThis.fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(chainResponse), { status: 200 }))  // chain re-fetch
    .mockResolvedValueOnce(new Response(JSON.stringify({
      exposure: 75, requires_totp: false, rule_warnings: [], draft: {},
    }), { status: 200 }));

  fireEvent.click(screen.getByRole('button', { name: /review/i }));
  await waitFor(() => expect(onReview).toHaveBeenCalled());
  expect(onReview.mock.calls[0][0].exposure).toBe(75);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- tests/SpreadOrderForm.spec.tsx
```
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Create `SpreadOrderForm.tsx`**

Create `dashboard/src/components/order/SpreadOrderForm.tsx`:

```tsx
// dashboard/src/components/order/SpreadOrderForm.tsx
import { useEffect, useMemo, useState } from 'react';
import type { AccountId, GradeLetter } from '../../lib/trade-types';
import { GRADE_LETTERS } from '../../lib/trade-types';

interface ChainContract {
  symbol: string;
  strike: number;
  expiration: string;
  type: 'put' | 'call';
  bid: number;
  ask: number;
}

interface ChainResponse {
  expirations: string[];
  contracts: ChainContract[];
}

interface Props {
  symbol: string;
  account: AccountId;
  setAccount: (a: AccountId) => void;
  onReview: (preview: { exposure: number; requires_totp: boolean; rule_warnings: any[]; draft: any }) => void;
}

export function SpreadOrderForm({ symbol, account, setAccount, onReview }: Props) {
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [expiration, setExpiration] = useState<string>('');
  const [shortStrike, setShortStrike] = useState<number | null>(null);
  const [longStrike, setLongStrike] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [limitCredit, setLimitCredit] = useState<number>(0);
  const [grade, setGrade] = useState<GradeLetter>('B');
  const [reasoning, setReasoning] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/alpaca/contracts?symbol=${symbol}&type=put`)
      .then(r => r.json() as Promise<ChainResponse>)
      .then(setChain)
      .catch(e => setErr(String(e)));
  }, [symbol]);

  const strikesAtExpiry = useMemo(
    () => (chain?.contracts ?? [])
      .filter(c => c.expiration === expiration && c.type === 'put')
      .sort((a, b) => b.strike - a.strike),
    [chain, expiration]
  );

  const longStrikeOptions = useMemo(
    () => strikesAtExpiry.filter(c => shortStrike == null || c.strike < shortStrike),
    [strikesAtExpiry, shortStrike]
  );

  const shortContract = strikesAtExpiry.find(c => c.strike === shortStrike) ?? null;
  const longContract = strikesAtExpiry.find(c => c.strike === longStrike) ?? null;

  const shortMid = shortContract ? (shortContract.bid + shortContract.ask) / 2 : 0;
  const longMid = longContract ? (longContract.bid + longContract.ask) / 2 : 0;
  const liveCredit = shortMid - longMid;
  const width = shortContract && longContract ? Math.abs(shortContract.strike - longContract.strike) : 0;
  const maxLoss = width - liveCredit;

  useEffect(() => {
    // Default the limit price to the live mid credit
    if (shortContract && longContract && limitCredit === 0) {
      setLimitCredit(Number(liveCredit.toFixed(2)));
    }
  }, [shortContract, longContract, liveCredit, limitCredit]);

  async function handleReview() {
    if (!shortContract || !longContract || !reasoning.trim()) {
      setErr('Pick both strikes and write reasoning before reviewing.');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch('/api/trades/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          payload: {
            kind: 'spread',
            account,
            symbol,
            spread_type: 'put_credit',
            short_leg: { occ: shortContract.symbol, strike: shortContract.strike, entry_premium: shortMid },
            long_leg:  { occ: longContract.symbol,  strike: longContract.strike,  entry_premium: longMid },
            expiration,
            qty,
            limit_price: -limitCredit,  // negative = credit
            entry_grade: grade,
            entry_reasoning: reasoning,
          },
        }),
      });
      const data = await res.json();
      onReview(data);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (err) return <div className="text-red text-[12px]">error: {err}</div>;
  if (!chain) return <div className="text-mid text-[12px]">loading chain…</div>;

  return (
    <div className="space-y-4 text-[12px]">
      <div>
        <label htmlFor="account" className="text-mid">Account</label>
        <select id="account" value={account}
                onChange={(e) => setAccount(e.target.value as AccountId)}
                className="ml-2 bg-bg border border-border px-2 py-1">
          <option value="manual_paper">manual_paper</option>
          <option value="live" disabled title="spread_management: False on live — enable in a future plan">live (disabled)</option>
        </select>
      </div>

      <div>
        <label htmlFor="expiration" className="text-mid">Expiration</label>
        <select id="expiration" value={expiration}
                onChange={(e) => setExpiration(e.target.value)}
                className="ml-2 bg-bg border border-border px-2 py-1">
          <option value="">pick…</option>
          {chain.expirations.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="short-strike" className="text-mid">Short Strike</label>
        <select id="short-strike" value={shortStrike ?? ''}
                onChange={(e) => setShortStrike(e.target.value ? Number(e.target.value) : null)}
                disabled={!expiration}
                className="ml-2 bg-bg border border-border px-2 py-1">
          <option value="">pick…</option>
          {strikesAtExpiry.map(c => <option key={c.strike} value={c.strike}>${c.strike.toFixed(2)}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="long-strike" className="text-mid">Long Strike</label>
        <select id="long-strike" value={longStrike ?? ''}
                onChange={(e) => setLongStrike(e.target.value ? Number(e.target.value) : null)}
                disabled={shortStrike == null}
                className="ml-2 bg-bg border border-border px-2 py-1">
          <option value="">pick…</option>
          {longStrikeOptions.map(c => <option key={c.strike} value={c.strike}>${c.strike.toFixed(2)}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="qty" className="text-mid">Qty (spreads)</label>
        <input id="qty" type="number" min={1} value={qty}
               onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
               className="ml-2 bg-bg border border-border px-2 py-1 w-20" />
      </div>

      <div>
        <label htmlFor="limit-credit" className="text-mid">Limit Credit ($)</label>
        <input id="limit-credit" type="number" step={0.01} value={limitCredit}
               onChange={(e) => setLimitCredit(Number(e.target.value))}
               className="ml-2 bg-bg border border-border px-2 py-1 w-24" />
      </div>

      {shortContract && longContract && (
        <div className="text-mid">
          <div>Live mid credit: ${liveCredit.toFixed(2)} (${(liveCredit * 100 * qty).toFixed(2)})</div>
          <div>Max loss: ${maxLoss.toFixed(2)} (${(maxLoss * 100 * qty).toFixed(2)})</div>
          <div>Break-even: ${(shortContract.strike - liveCredit).toFixed(2)}</div>
        </div>
      )}

      <div>
        <label htmlFor="grade" className="text-mid">Entry Grade</label>
        <select id="grade" value={grade}
                onChange={(e) => setGrade(e.target.value as GradeLetter)}
                className="ml-2 bg-bg border border-border px-2 py-1">
          {GRADE_LETTERS.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>

      <div>
        <label htmlFor="reasoning" className="text-mid block">Reasoning</label>
        <textarea id="reasoning" value={reasoning}
                  onChange={(e) => setReasoning(e.target.value)}
                  rows={3}
                  className="w-full mt-1 bg-bg border border-border px-2 py-1" />
      </div>

      <button onClick={handleReview} disabled={submitting}
              className="border border-border px-3 py-1 hover:bg-mid/10">
        {submitting ? 'reviewing…' : 'Review'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test -- tests/SpreadOrderForm.spec.tsx
```
Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/order/SpreadOrderForm.tsx dashboard/tests/SpreadOrderForm.spec.tsx
git commit -m "ui: SpreadOrderForm with two-strike dropdowns + grade + reasoning"
```

---

### Task 9: Wire `OrderNew.tsx` third branch + Lookup button

**Files:**
- Modify: `dashboard/src/routes/OrderNew.tsx`
- Modify: `dashboard/src/routes/Lookup.tsx`
- Test: `dashboard/tests/OrderNew.spec.tsx`, `dashboard/tests/Lookup.spec.tsx`

- [ ] **Step 1: Write the failing OrderNew test**

Append to (or create) `dashboard/tests/OrderNew.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrderNew from '../src/routes/OrderNew';

it('renders SpreadOrderForm when ?spread=put_credit&symbol=AAL', () => {
  render(
    <MemoryRouter initialEntries={['/order/new?spread=put_credit&symbol=AAL']}>
      <OrderNew />
    </MemoryRouter>
  );
  expect(screen.queryByRole('button', { name: /review/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Write the failing Lookup test**

Append to (or create) `dashboard/tests/Lookup.spec.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Lookup from '../src/routes/Lookup';

it('shows Build Put Credit Spread button when chain returns expirations', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    expirations: ['2026-05-29'],
    contracts: [{ symbol: 'AAL260529P00012500', strike: 12.5, expiration: '2026-05-29', type: 'put', bid: 0.36, ask: 0.42 }],
    snapshot: { last: 12.71 },
  }), { status: 200 }));

  render(
    <MemoryRouter initialEntries={['/lookup/AAL']}>
      <Routes><Route path="/lookup/:symbol" element={<Lookup />} /></Routes>
    </MemoryRouter>
  );
  await waitFor(() => screen.getByRole('button', { name: /build put credit spread/i }));
  expect(screen.getByRole('button', { name: /build put credit spread/i })).toBeInTheDocument();
});

it('hides Build Put Credit Spread button when chain is empty', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    expirations: [], contracts: [], snapshot: { last: 12.71 },
  }), { status: 200 }));

  render(
    <MemoryRouter initialEntries={['/lookup/LMTQQQ']}>
      <Routes><Route path="/lookup/:symbol" element={<Lookup />} /></Routes>
    </MemoryRouter>
  );
  await waitFor(() => screen.queryByText(/LMTQQQ/i));
  expect(screen.queryByRole('button', { name: /build put credit spread/i })).toBeNull();
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd dashboard && npm test -- tests/OrderNew.spec.tsx tests/Lookup.spec.tsx
```
Expected: FAIL.

- [ ] **Step 4: Add the third branch to `OrderNew.tsx`**

In `dashboard/src/routes/OrderNew.tsx`, replace the existing dispatch block (lines ~33-48) with:

```tsx
  const spreadType = params.get('spread');
  const isOption = !!contract;
  const isSpread = spreadType === 'put_credit';

  return (
    <div className="p-6 max-w-3xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/order</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">
          new {isSpread ? `--spread=${spreadType} --symbol=${symbol}`
                : isOption ? `--contract=${contract} --action=${action}`
                : `--symbol=${symbol} --type=${type}`}
        </span>
      </div>
      <div className="mt-6">
        {isSpread ? (
          <SpreadOrderForm symbol={symbol!} account={account} setAccount={setAccount} onReview={setPreview} />
        ) : isOption ? (
          <OptionOrderForm contractSymbol={contract!} action={action ?? 'open'} account={account} setAccount={setAccount} onReview={setPreview} />
        ) : (
          <StockOrderForm symbol={symbol!} account={account} setAccount={setAccount} onReview={setPreview} />
        )}
      </div>
      {/* ... rest of the file unchanged ... */}
```

Add the import at the top:

```tsx
import { SpreadOrderForm } from '../components/order/SpreadOrderForm';
```

Update the no-symbol guard to also accept the spread case (a spread always has `symbol`, so existing `if (!symbol && !contract)` is fine — no change needed).

- [ ] **Step 5: Add the Lookup button**

In `dashboard/src/routes/Lookup.tsx`, find the action-buttons section (near the existing "Sell Put" / "Buy Stock" buttons). Add:

```tsx
{snapshot.expirations.length > 0 && (
  <Link
    to={`/order/new?spread=put_credit&symbol=${symbol}`}
    className="border border-border px-3 py-1 text-[12px] hover:bg-mid/10"
  >
    Build Put Credit Spread
  </Link>
)}
```

Adapt the variable name (`snapshot.expirations` may be different — read the file first and use whichever variable holds the chain expiration list).

- [ ] **Step 6: Run tests**

```bash
cd dashboard && npm test
```
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/routes/OrderNew.tsx dashboard/src/routes/Lookup.tsx dashboard/tests/OrderNew.spec.tsx dashboard/tests/Lookup.spec.tsx
git commit -m "ui: wire SpreadOrderForm into OrderNew + Lookup button"
```

---

### Task 10: `ConfirmModal` spread copy

**Files:**
- Modify: `dashboard/src/components/order/ConfirmModal.tsx`
- Test: `dashboard/tests/ConfirmModal.spec.tsx`

- [ ] **Step 1: Write the failing test**

Append to (or create) `dashboard/tests/ConfirmModal.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { ConfirmModal } from '../src/components/order/ConfirmModal';

it('renders spread-aware copy when draft.kind === spread', () => {
  const preview = {
    exposure: 75, requires_totp: false, rule_warnings: [],
    draft: {
      kind: 'spread', account: 'manual_paper', symbol: 'AAL',
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
      expiration: '2026-05-29', qty: 1, limit_price: -0.25,
    },
  };
  render(<ConfirmModal preview={preview} onClose={() => {}} />);
  expect(screen.getByText(/AAL put credit/i)).toBeInTheDocument();
  expect(screen.getByText(/\$12\.50.*\$11\.50/i)).toBeInTheDocument();
  expect(screen.getByText(/credit.*\$0\.25/i)).toBeInTheDocument();
  expect(screen.getByText(/max loss.*\$75/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- tests/ConfirmModal.spec.tsx
```
Expected: FAIL.

- [ ] **Step 3: Add a spread render branch in `ConfirmModal.tsx`**

In `dashboard/src/components/order/ConfirmModal.tsx`, find the body that renders the order summary. Add a guard at the top of the summary block:

```tsx
const draft = preview.draft as any;
if (draft.kind === 'spread') {
  const credit = Math.abs(draft.limit_price);
  const width = Math.abs(draft.short_leg.strike - draft.long_leg.strike);
  const maxLoss = width - credit;
  return (
    <div className="p-4 space-y-2 text-[12px]">
      <div className="text-fg">
        {draft.symbol} put credit ${draft.short_leg.strike.toFixed(2)} / ${draft.long_leg.strike.toFixed(2)} × {draft.qty}
      </div>
      <div className="text-mid">Net credit: ${credit.toFixed(2)} (${(credit * 100 * draft.qty).toFixed(2)})</div>
      <div className="text-mid">Max loss: ${maxLoss.toFixed(2)} (${(maxLoss * 100 * draft.qty).toFixed(2)})</div>
      <div className="text-mid">Collateral: ${(maxLoss * 100 * draft.qty).toFixed(2)}</div>
      {preview.rule_warnings.length > 0 && (
        <div className="text-yellow">
          {preview.rule_warnings.map((w, i) => <div key={i}>⚠ {w.message}</div>)}
        </div>
      )}
      {/* existing confirm/cancel buttons stay below */}
    </div>
  );
}
```

(Place this guard BEFORE the existing single-leg render path. The existing path stays unchanged for stock/option draft kinds.)

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test
```
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/order/ConfirmModal.tsx dashboard/tests/ConfirmModal.spec.tsx
git commit -m "ui: ConfirmModal spread-aware copy (both legs + credit + max loss)"
```

---

### Task 11: `Trades.tsx` + `TradeDetail.tsx` spread rendering

**Files:**
- Modify: `dashboard/src/routes/Trades.tsx`
- Modify: `dashboard/src/routes/TradeDetail.tsx`
- Test: `dashboard/tests/Trades.spec.tsx`, `dashboard/tests/TradeDetail.spec.tsx`

- [ ] **Step 1: Write the failing Trades test**

Append to (or create) `dashboard/tests/Trades.spec.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Trades from '../src/routes/Trades';

it('renders a spread trade as a single row with both strikes', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    trades: [{
      id: 'T-2026-05-15-001',
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'AAL',
      submitted_at: '2026-05-15T14:00:00Z',
      filled_at: '2026-05-15T14:05:00Z',
      closed_at: null,
      entry_grade: 'B+',
      spread: {
        spread_type: 'put_credit',
        short_leg: { strike: 12.5, occ: 'AAL260529P00012500', entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg:  { strike: 11.5, occ: 'AAL260529P00011500', entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        net_credit: 0.25, max_loss: 0.75, width: 1, expiration: '2026-05-29',
      },
    }],
    summary: { calibration: 0 },
  }), { status: 200 }));

  render(<MemoryRouter><Trades /></MemoryRouter>);
  await waitFor(() => screen.getByText(/AAL.*put credit.*12\.50.*11\.50/i));
  // exactly one row (not two)
  const rows = screen.getAllByText(/AAL/i);
  expect(rows.length).toBe(1);
});
```

- [ ] **Step 2: Write the failing TradeDetail test**

Append to (or create) `dashboard/tests/TradeDetail.spec.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TradeDetail from '../src/routes/TradeDetail';

it('renders spread metadata block with both legs', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'T-2026-05-15-001',
    asset_class: 'spread',
    symbol: 'AAL',
    submitted_at: '2026-05-15T14:00:00Z',
    spread: {
      spread_type: 'put_credit',
      short_leg: { strike: 12.5, occ: 'AAL260529P00012500', entry_premium: 0.37, fill_price: 0.37, qty: 1 },
      long_leg:  { strike: 11.5, occ: 'AAL260529P00011500', entry_premium: 0.12, fill_price: 0.12, qty: 1 },
      net_credit: 0.25, max_loss: 0.75, width: 1, expiration: '2026-05-29',
    },
  }), { status: 200 }));

  render(
    <MemoryRouter initialEntries={['/trade/T-2026-05-15-001']}>
      <Routes><Route path="/trade/:id" element={<TradeDetail />} /></Routes>
    </MemoryRouter>
  );
  await waitFor(() => screen.getByText(/AAL/i));
  expect(screen.getByText(/short.*\$12\.50/i)).toBeInTheDocument();
  expect(screen.getByText(/long.*\$11\.50/i)).toBeInTheDocument();
  expect(screen.getByText(/net credit/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd dashboard && npm test -- tests/Trades.spec.tsx tests/TradeDetail.spec.tsx
```
Expected: FAIL.

- [ ] **Step 4: Add spread branch to `Trades.tsx`**

In `dashboard/src/routes/Trades.tsx`, find the row-rendering loop (`trades.map(...)`). Inside the row JSX, add a branch on `trade.asset_class === 'spread'`:

```tsx
{trade.asset_class === 'spread' && trade.spread ? (
  <td>
    {trade.symbol} {trade.spread.spread_type.replace('_', ' ')} ${trade.spread.short_leg.strike.toFixed(2)} / ${trade.spread.long_leg.strike.toFixed(2)}
  </td>
) : (
  /* existing stock/option label cell */
)}
```

- [ ] **Step 5: Add spread branch to `TradeDetail.tsx`**

In `dashboard/src/routes/TradeDetail.tsx`, find the metadata block. Add a spread guard before the existing single-leg render:

```tsx
{trade.asset_class === 'spread' && trade.spread && (
  <div className="space-y-1 text-[12px]">
    <div>Type: {trade.spread.spread_type.replace('_', ' ')}</div>
    <div>Short ${trade.spread.short_leg.strike.toFixed(2)} put — entry ${trade.spread.short_leg.entry_premium?.toFixed(2) ?? '—'}, fill ${trade.spread.short_leg.fill_price?.toFixed(2) ?? '—'}</div>
    <div>Long  ${trade.spread.long_leg.strike.toFixed(2)} put — entry ${trade.spread.long_leg.entry_premium?.toFixed(2) ?? '—'}, fill ${trade.spread.long_leg.fill_price?.toFixed(2) ?? '—'}</div>
    <div>Net credit: ${trade.spread.net_credit.toFixed(2)} (${(trade.spread.net_credit * 100).toFixed(2)})</div>
    <div>Max loss: ${trade.spread.max_loss.toFixed(2)} (${(trade.spread.max_loss * 100).toFixed(2)})</div>
    <div>Expiration: {trade.spread.expiration}</div>
  </div>
)}
```

If the chart on this page already adds entry markers based on `trade.strike`, add a second marker for `trade.spread.long_leg.strike` when in spread mode. Look for the existing `createSeriesMarkers` call and extend it:

```tsx
if (trade.asset_class === 'spread' && trade.spread) {
  markers.push({
    time: chartStart, position: 'inBar', color: '#888', shape: 'circle',
    text: `long $${trade.spread.long_leg.strike.toFixed(2)}`,
  });
}
```

- [ ] **Step 6: Run tests**

```bash
cd dashboard && npm test
```
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/routes/Trades.tsx dashboard/src/routes/TradeDetail.tsx dashboard/tests/Trades.spec.tsx dashboard/tests/TradeDetail.spec.tsx
git commit -m "ui: spread-aware rendering on /trades + /trade/:id"
```

---

### Task 12: `Rules.tsx` `max_risk_per_spread` display

**Files:**
- Modify: `dashboard/src/routes/Rules.tsx`
- Test: `dashboard/tests/Rules.spec.tsx`

- [ ] **Step 1: Write the failing test**

Append to (or create) `dashboard/tests/Rules.spec.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Rules from '../src/routes/Rules';

it('renders the max_risk_per_spread rule card with current cap', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
    {
      id: 'r-default-spread',
      title: 'Max risk per spread',
      severity: 'warn',
      triggers: [{ kind: 'max_risk_per_spread', max_dollars: 500 }],
    },
  ]), { status: 200 }));

  render(<MemoryRouter><Rules /></MemoryRouter>);
  await waitFor(() => screen.getByText(/max risk per spread/i));
  expect(screen.getByText(/\$500/)).toBeInTheDocument();
  expect(screen.getByText(/warn/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- tests/Rules.spec.tsx
```
Expected: FAIL — Rules.tsx doesn't yet render `max_risk_per_spread`.

- [ ] **Step 3: Add the rule type to Rules.tsx rendering**

In `dashboard/src/routes/Rules.tsx`, find where existing rules are rendered. Add a case for the new trigger kind. If rule rendering is generic (just shows title/severity/triggers), update the trigger formatter to handle `max_risk_per_spread`:

```tsx
function formatTrigger(t: Trigger): string {
  switch (t.kind) {
    // ... existing cases ...
    case 'max_risk_per_spread':
      return `max risk per spread: $${t.max_dollars}`;
    default:
      return JSON.stringify(t);
  }
}
```

If the page already has a generic rule card, no other change needed. If it has hardcoded rule type blocks, add a new block for `max_risk_per_spread`.

- [ ] **Step 4: Run tests**

```bash
cd dashboard && npm test
```
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/Rules.tsx dashboard/tests/Rules.spec.tsx
git commit -m "ui: Rules page displays max_risk_per_spread cap and severity"
```

---

### Task 13: Smoke test + CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`
- No code changes — pure verification + docs

- [ ] **Step 1: Deploy to Vercel preview and smoke-test the flow**

```bash
cd dashboard && npx vercel --yes
```

Note the preview URL it prints. Open it in a browser, log in, then:
1. Navigate to `/lookup/AAL`. Confirm the "Build Put Credit Spread" button is visible.
2. Click it → lands on `/order/new?spread=put_credit&symbol=AAL`.
3. Pick `2026-06-19` expiration → strike dropdowns populate.
4. Pick short $12, long $11 (or whatever's available cheap).
5. Enter grade B + reasoning "smoke test".
6. Click Review → ConfirmModal shows both legs + credit + max loss.
7. **Do NOT confirm** (we don't want a second spread on the live AAL account just for testing — manually close on Alpaca if you accidentally submit).
8. Verify the existing AAL spread on `/trades` still renders correctly post-deploy.

- [ ] **Step 2: Update CLAUDE.md**

Find the "Spreads — detection + management" section. Add a new paragraph:

```markdown
**Dashboard order form (Phase 4)**: `/order/new?spread=put_credit&symbol=<SYMBOL>` opens a two-leg spread order form. Reachable via a "Build Put Credit Spread" button on every `/lookup/<SYMBOL>` page when the symbol has an options chain. Live mode is disabled in the account dropdown with a tooltip. Default `max_risk_per_spread` rule of $500 (warn-level) is auto-seeded on first /rules visit; configurable on `/rules` like other manual rules. Trade record stores both legs in `trade.spread` (see `SpreadDetails` in `dashboard/api/_lib/trade-types.ts`); `/trades` renders one row per spread; `/trade/:id` shows both legs + both strike markers on the chart. AI grading prompt branches for spread context. Spread close remains bot-driven (Phase 2 management) — no dashboard close action.
```

Also update the "What's NOT yet implemented" bullet list to remove the "Dashboard order form for opening multi-leg spreads" line (now shipped) and the "Phase 4 (dashboard form)" reference under tracking plans.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: spread dashboard form (Phase 4) shipped"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

```bash
cd dashboard && npm test
```
Expected: All passing, including all new spread tests (target ~15-20 new tests).

- [ ] **Step 2: Confirm Vercel function count**

```bash
ls dashboard/api/*.ts dashboard/api/*/*.ts 2>/dev/null | grep -v '_lib' | wc -l
```
Expected: 10 (unchanged from before this plan).

- [ ] **Step 3: PR**

Branch: `claude/dashboard-spread-form-design` (already created). Push and open PR against `main`. Merge before opening any new real spreads so the next one gets the new form treatment.

---

## Self-review notes

- **Spec coverage:** Every spec section maps to at least one task. Trade record schema (Task 1), exposure (Task 2), rule trigger + seeding (Tasks 3 + 4), preview/submit (Task 5), sync fills (Task 6), grading prompt (Task 7), form (Task 8), entry points (Task 9), confirm modal (Task 10), trades/trade detail (Task 11), rules page (Task 12), smoke/docs (Task 13).
- **No new Vercel functions.** All backend changes inside `trades/[action].ts`, `cron/[job].ts`, `rules/[resource].ts`, and `_lib/`. Stays at 10 of 12 Hobby cap.
- **Trade type backward compat:** `Trade.spread` is optional. Existing single-leg trades have `spread: undefined`. Renderers branch on `trade.asset_class === 'spread'` for clarity.
- **No close-from-dashboard.** Bot Phase 2 owns close. If reviewer asks about a close button, point to deferral.
- **`syncFillData` handles two cases:** new spread mleg path (Task 6) + existing single-leg path (unchanged). Both share the same retry-next-cycle semantics when Alpaca returns pending.

## Out-of-scope deferrals (for the implementer's awareness)

If a subagent gets ambitious during a task and starts implementing one of these, STOP and report `DONE_WITH_CONCERNS`:

- Call credit / debit spreads on the form
- User-initiated close from dashboard
- Modify or roll spreads mid-trade
- Multi-spread submits in one click
- Spread-value-over-time chart on TradeDetail
- Live account spread submits (greyed out only — don't make it functional)
- Teaching `rule-check.ts` about `spread_active` overlap when evaluating bot-wheel overlap for single-leg orders
