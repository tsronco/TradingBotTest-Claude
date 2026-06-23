# Grading Scope + Grade-Backlog Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restrict AI hindsight grading to the **manual** and **live** accounts only (not conservative/aggressive/SM), and add a **"grade backlog"** button on `/trades` that drains the needs-grade queue on demand for the account being viewed. Adjust the button row so each button only appears where it's useful.

**Architecture:** A single `isGradeable(account)` policy (in the dependency-light `api/_lib/trade-types.ts`, re-exported to the client) gates every grading trigger: the close-loop, the needs-grade drain, and the manual regrade endpoint/button. A new `?mode=grade` reuses the existing `runGradeOpenTrades` engine with a big grade budget, scoped to the account. The `RefreshButton` gains a third button and a visibility matrix.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Vercel serverless, Upstash Redis.

---

## Design (approved)

**Gradeable accounts:** `manual_paper`, `live`. Everything else (conservative/aggressive/SM) is never AI-graded going forward. Existing grades are left as-is (no retroactive removal).

**Button visibility matrix** (the `account` is the page's `filters.account` — a single `AccountId` or `undefined` for `[any]`):

| Button | cons / agg / SM | manual / live | `[any]` |
|---|---|---|---|
| Refresh | ✓ | ✓ | ✓ |
| Grade backlog | — | ✓ | — |
| Drain backlog | — | — | ✓ |

- **Refresh** unchanged (scoped or global per filter).
- **Drain backlog** behavior unchanged (global, no-grading, unbounded sweep) — only its *visibility* is gated to `[any]`.
- **Grade backlog** is new: `?mode=grade&account=<id>` → drains the needs-grade queue (AI grading) for that account, big budget + 45s cap. Reports `graded N · M queued`.

**Single source of truth:** `isGradeable` lives in `api/_lib/trade-types.ts` (imported by both server and client — the client already re-exports from there via `src/lib/trade-types.ts`). The server gates the cron + regrade endpoint; the client gates button visibility.

---

## Task 1: `isGradeable` grading policy (shared)

**Files:**
- Modify: `dashboard/api/_lib/trade-types.ts` (add the constant + predicate)
- Modify: `dashboard/src/lib/trade-types.ts` (re-export them to the client)
- Test: `dashboard/tests/lib/gradeable.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/lib/gradeable.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isGradeable, GRADEABLE_ACCOUNTS } from '../../api/_lib/trade-types';

describe('isGradeable', () => {
  it('is true only for manual_paper and live', () => {
    expect(isGradeable('manual_paper')).toBe(true);
    expect(isGradeable('live')).toBe(true);
  });
  it('is false for the bot accounts', () => {
    for (const a of ['conservative_paper', 'aggressive_paper', 'sm500_paper', 'sm1000_paper', 'sm2000_paper'] as const) {
      expect(isGradeable(a)).toBe(false);
    }
  });
  it('GRADEABLE_ACCOUNTS holds exactly the two gradeable accounts', () => {
    expect(GRADEABLE_ACCOUNTS.size).toBe(2);
    expect(GRADEABLE_ACCOUNTS.has('manual_paper')).toBe(true);
    expect(GRADEABLE_ACCOUNTS.has('live')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/gradeable.test.ts --pool=forks`
Expected: FAIL — `isGradeable`/`GRADEABLE_ACCOUNTS` not exported. (Use `--pool=forks`; threads pool times out in this worktree.)

- [ ] **Step 3: Add the policy**

In `dashboard/api/_lib/trade-types.ts`, after the `AccountId` type (the first export, ~lines 1-3), add:

```ts
// AI hindsight grading is restricted to the accounts where the user hand-picks
// entry grades — manual + live. The bot accounts (conservative, aggressive, SM)
// auto-open trades with no meaningful self-grade, so grading them is noise and
// Sonnet spend. Single source of truth for every grading gate (cron close-loop,
// needs-grade drain, regrade endpoint) and the client button visibility.
export const GRADEABLE_ACCOUNTS: ReadonlySet<AccountId> = new Set<AccountId>([
  'manual_paper', 'live',
]);

export function isGradeable(account: AccountId): boolean {
  return GRADEABLE_ACCOUNTS.has(account);
}
```

In `dashboard/src/lib/trade-types.ts`, add `GRADEABLE_ACCOUNTS, isGradeable` to the existing value re-export. Change:

```ts
export { GRADE_LETTERS, gradeIndex, calibrationFor } from '../../api/_lib/trade-types';
```

to:

```ts
export { GRADE_LETTERS, gradeIndex, calibrationFor, GRADEABLE_ACCOUNTS, isGradeable } from '../../api/_lib/trade-types';
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard && npx vitest run tests/lib/gradeable.test.ts --pool=forks`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/trade-types.ts dashboard/src/lib/trade-types.ts dashboard/tests/lib/gradeable.test.ts
git commit -m "feat(dashboard): isGradeable policy — grade only manual + live"
```

---

## Task 2: Gate grading in the cron + scope the queue drain

**Files:**
- Modify: `dashboard/api/cron/[job].ts` (`runGradeOpenTrades` close-loop, `drainNeedsGrade`, return shape)
- Test: `dashboard/tests/api/cron-grading-gate.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/api/cron-grading-gate.test.ts`. **Model the mock blocks on `dashboard/tests/api/cron-d11-settlement-backstop.test.ts`** (same `vi.mock` for kv, data-api, alpaca, grading, proposal-prompts, and the `../../api/trades/[action]` auto-import stub). The test exercises the **needs-grade drain path** with an EMPTY open index (so no close detection is needed) and a pre-populated queue:

Set `kvLrange(KV_KEYS.tradesIndexOpen)` → `[]` (nothing to sweep). Seed the needs-grade queue: `kvGet(KV_KEYS.tradesIndexNeedsGrade)` → `['m1','l1','c1']`. `kvGet(tradeKey('m1'))` → closed `manual_paper` trade; `kvGet(tradeKey('l1'))` → closed `live` trade; `kvGet(tradeKey('c1'))` → closed `conservative_paper` trade (all with `closed_at` set, `asset_class:'stock'`). `kvGet(gradeKey(...))` → a grade record with `hindsight: null` for each. Mock `gradeTrade` to resolve a grade object.

```ts
// Scoped grade-drain of manual: grades manual's queued trade, keeps live's
// queued (other gradeable account), DROPS conservative's (not gradeable).
const r = await runGradeOpenTrades({ account: 'manual_paper', gradeBudget: Number.MAX_SAFE_INTEGER });

expect(gradeTrade).toHaveBeenCalledTimes(1);          // only m1 graded
expect(r.ai_graded).toBe(1);
// queue after = [l1] (live kept for its own run; c1 dropped as non-gradeable; m1 graded)
const finalQueue = kvSet.mock.calls.filter(([k]) => k === KV_KEYS.tradesIndexNeedsGrade).at(-1)?.[1];
expect(finalQueue).toEqual(['l1']);
expect(r.grade_queue_remaining).toBe(1);
```

Import `runGradeOpenTrades` from `../../api/cron/[job]`, `KV_KEYS` from `../../api/_lib/kv-keys`, `gradeKey`/`tradeKey` as the cron test does, and the `gradeTrade` mock handle. (You'll need `kvGet` to return per-key values — use a `mockImplementation` switch on the key.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/cron-grading-gate.test.ts --pool=forks`
Expected: FAIL — `runGradeOpenTrades` has no `ai_graded`/`grade_queue_remaining`, `drainNeedsGrade` ignores `account` and doesn't gate non-gradeable, so all three would be graded.

- [ ] **Step 3: Implement the gate + scope**

In `dashboard/api/cron/[job].ts`:

(a) Add the import. Find the existing `trade-types` import and add `isGradeable`:

```ts
import { isGradeable } from '../_lib/trade-types.js';
```

(If there's already an import from `'../_lib/trade-types.js'`, add `isGradeable` to it instead of a second import line.)

(b) Gate the close-loop. Find:

```ts
    if (aiGrades < gradeBudget && !outOfTime()) {
      if (await gradeClosedTrade(closedTrade)) aiGrades += 1;
    } else {
      await enqueueNeedsGrade(closedTrade.id);
    }
```

replace with:

```ts
    // AI grading is restricted to gradeable accounts (manual + live). A bot-account
    // trade closes normally with full P&L recorded above, but never gets an AI
    // hindsight grade and never enters the needs-grade queue.
    if (isGradeable(closedTrade.account)) {
      if (aiGrades < gradeBudget && !outOfTime()) {
        if (await gradeClosedTrade(closedTrade)) aiGrades += 1;
      } else {
        await enqueueNeedsGrade(closedTrade.id);
      }
    }
```

(c) Pass the account scope into the drain. Find:

```ts
    aiGrades += await drainNeedsGrade(Math.max(0, gradeBudget - aiGrades), outOfTime);
```

replace with:

```ts
    aiGrades += await drainNeedsGrade(Math.max(0, gradeBudget - aiGrades), outOfTime, accountFilter);
```

(d) Add `ai_graded` + `grade_queue_remaining` to the return. First widen the return type — find the `Promise<{` return-type block of `runGradeOpenTrades` and add two fields so it reads:

```ts
}): Promise<{
  graded: number;
  synced: number;
  remaining_open: number;
  ai_graded: number;
  grade_queue_remaining: number;
  assignments_spawned: number;
  assignments_skipped: number;
  auto_imported: Record<string, number | string>;
}> {
```

Then find the final `return {` block and replace it with:

```ts
  const grade_queue_remaining =
    ((await kv().get<string[]>(KV_KEYS.tradesIndexNeedsGrade)) ?? []).length;

  return {
    graded,
    synced,
    remaining_open: remaining,
    ai_graded: aiGrades,
    grade_queue_remaining,
    assignments_spawned: drainResult.spawned,
    assignments_skipped: drainResult.skipped,
    auto_imported: importResult,
  };
```

(e) Make `drainNeedsGrade` account-aware + gate non-gradeable. Replace the whole function:

```ts
async function drainNeedsGrade(budget: number, isOutOfTime?: () => boolean): Promise<number> {
  if (budget <= 0) return 0;
  const q = (await kv().get<string[]>(KV_KEYS.tradesIndexNeedsGrade)) ?? [];
  if (q.length === 0) return 0;

  let used = 0;
  const remainingQueue: string[] = [];
  for (const id of q) {
    // Stop spending on grades once the count budget OR the wall-clock budget is
    // hit — the rest stays queued and drains on the next tick.
    if (used >= budget || (isOutOfTime?.() ?? false)) { remainingQueue.push(id); continue; }
    const t = await kv().get<Trade>(tradeKey(id));
    if (!t || !t.closed_at) continue; // gone or no longer closed — drop silently
    // Already graded (e.g. the user hit "grade now")? Drop without re-grading.
    const g = await kv().get<GradeRecord>(gradeKey(id));
    if (g?.hindsight) continue;
    try {
      if (await gradeClosedTrade(t)) used += 1;
    } catch (e) {
      console.error('drainNeedsGrade gradeClosedTrade failed', id, e);
      remainingQueue.push(id); // keep for retry
    }
  }
  await kv().set(KV_KEYS.tradesIndexNeedsGrade, remainingQueue);
  return used;
}
```

with:

```ts
async function drainNeedsGrade(
  budget: number,
  isOutOfTime?: () => boolean,
  account?: string,
): Promise<number> {
  if (budget <= 0) return 0;
  const q = (await kv().get<string[]>(KV_KEYS.tradesIndexNeedsGrade)) ?? [];
  if (q.length === 0) return 0;

  let used = 0;
  const remainingQueue: string[] = [];
  for (const id of q) {
    // Stop spending on grades once the count budget OR the wall-clock budget is
    // hit — the rest stays queued and drains on the next tick.
    if (used >= budget || (isOutOfTime?.() ?? false)) { remainingQueue.push(id); continue; }
    const t = await kv().get<Trade>(tradeKey(id));
    if (!t || !t.closed_at) continue; // gone or no longer closed — drop silently
    // Grading is restricted to manual + live. Anything else in the queue (a bot
    // account queued before this policy) is dropped, never graded.
    if (!isGradeable(t.account)) continue;
    // Scoped drain (the "grade backlog" button): grade only the selected account
    // this pass; keep other gradeable accounts queued for their own run.
    if (account && t.account !== account) { remainingQueue.push(id); continue; }
    // Already graded (e.g. the user hit "grade now")? Drop without re-grading.
    const g = await kv().get<GradeRecord>(gradeKey(id));
    if (g?.hindsight) continue;
    try {
      if (await gradeClosedTrade(t)) used += 1;
    } catch (e) {
      console.error('drainNeedsGrade gradeClosedTrade failed', id, e);
      remainingQueue.push(id); // keep for retry
    }
  }
  await kv().set(KV_KEYS.tradesIndexNeedsGrade, remainingQueue);
  return used;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/cron-grading-gate.test.ts --pool=forks`
Expected: PASS. Iterate the **test mock wiring** (not the production code) until the per-key `kvGet` switch + queue assertions hold.

- [ ] **Step 5: Run the existing cron + account-scope tests (regression)**

Run: `cd dashboard && npx vitest run tests/api/cron-d11-settlement-backstop.test.ts tests/api/cron-assignment-detect.test.ts tests/api/cron-assignment-drain.test.ts tests/api/cron-account-scope.test.ts --pool=forks`
Expected: PASS. Note: these mostly use bot/manual accounts; if any pre-existing test asserted that a **conservative/aggressive/SM** trade gets graded/enqueued on close, that expectation is now intentionally changed — update such a test to expect no grade for the bot account (and document why in a comment). Manual/live close-grade behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add "dashboard/api/cron/[job].ts" dashboard/tests/api/cron-grading-gate.test.ts
git commit -m "feat(dashboard): gate AI grading to manual+live; scope the needs-grade drain"
```

---

## Task 3: Gate the manual regrade endpoint

**Files:**
- Modify: `dashboard/api/trades/[action].ts` (the `regrade` function, ~line 1115)
- Test: `dashboard/tests/api/trades-regrade-gate.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/api/trades-regrade-gate.test.ts`. Model the mock blocks on `dashboard/tests/api/trades-refresh.test.ts` (kv, auth-guard, rule-check, data-api, totp, alpaca, grading mocks). Provide `kvGet` returning a trade + a grade record by key.

```ts
it('refuses to regrade a non-gradeable (conservative) trade with 403', async () => {
  // kvGet: tradeKey → conservative_paper closed trade; gradeKey → a grade record
  const mod = await import('../../api/trades/[action]');
  const res = mockRes();
  await mod.default(mockReq({ id: 'T-x', /* action: 'regrade' */ }), res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'grading_disabled_for_account' }));
});

it('allows regrade on a manual trade', async () => {
  // kvGet: tradeKey → manual_paper closed trade; gradeKey → grade record.
  // gradeTrade mock resolves a hindsight; kvSet resolves OK.
  const mod = await import('../../api/trades/[action]');
  const res = mockRes();
  await mod.default(mockReq({ id: 'T-y' }), res);
  expect(res.status).not.toHaveBeenCalledWith(403);
  expect(res.status).toHaveBeenCalledWith(200);
});
```

`mockReq` must set `query: { action: 'regrade' }` and `body: { id }`. (Match the existing test helpers' shape.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/trades-regrade-gate.test.ts --pool=forks`
Expected: FAIL — regrade currently grades any account (no 403).

- [ ] **Step 3: Implement the gate**

In `dashboard/api/trades/[action].ts`, add `isGradeable` to the existing `'../_lib/trade-types.js'` import. Then in the `regrade` function, find:

```ts
  if (!trade) return res.status(404).json({ error: 'trade_not_found' });
  if (!grade) return res.status(404).json({ error: 'grade_not_found' });
```

and add immediately after:

```ts
  // AI grading is restricted to manual + live. The UI hides the regrade button
  // on other accounts; this is the server-side guard for a hand-crafted request.
  if (!isGradeable(trade.account)) {
    return res.status(403).json({ error: 'grading_disabled_for_account', account: trade.account });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/trades-regrade-gate.test.ts --pool=forks`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add "dashboard/api/trades/[action].ts" dashboard/tests/api/trades-regrade-gate.test.ts
git commit -m "feat(dashboard): regrade endpoint refuses non-gradeable accounts"
```

---

## Task 4: `?mode=grade` on the refresh endpoint

**Files:**
- Modify: `dashboard/api/trades/[action].ts` (the `refresh` function, ~lines 206-220)
- Test: `dashboard/tests/api/trades-refresh.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Append to the `describe('POST /api/trades/refresh', …)` block in `dashboard/tests/api/trades-refresh.test.ts`:

```ts
  it('mode=grade runs with a big grade budget, 45s cap, scoped to the account', async () => {
    runGradeOpenTradesMock.mockResolvedValueOnce({
      graded: 0, synced: 0, remaining_open: 4, ai_graded: 3, grade_queue_remaining: 2,
      assignments_spawned: 0, assignments_skipped: 0,
    });
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ mode: 'grade', account: 'manual_paper' }), res);

    expect(runGradeOpenTradesMock).toHaveBeenCalledWith(expect.objectContaining({
      gradeBudget: Number.MAX_SAFE_INTEGER, timeBudgetMs: 45_000, account: 'manual_paper',
    }));
    // grade mode must NOT lift the sweep cap (that's drain's job)
    expect(runGradeOpenTradesMock.mock.calls[0][0]).not.toHaveProperty('sweepBudget');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, ai_graded: 3, grade_queue_remaining: 2 }));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/trades-refresh.test.ts --pool=forks`
Expected: FAIL — `mode=grade` isn't handled, so `gradeBudget`/`timeBudgetMs` aren't set.

- [ ] **Step 3: Implement grade mode**

In `dashboard/api/trades/[action].ts` `refresh`, find:

```ts
  const drain = String((req.query?.mode ?? '')) === 'drain';
```

replace with:

```ts
  const mode = String(req.query?.mode ?? '');
  const drain = mode === 'drain';
  // Grade mode (?mode=grade): the "grade backlog" button. Run AI grading on the
  // needs-grade queue now — big grade budget, 45s cap — scoped to the account.
  // Unlike drain it does NOT lift the sweep cap; the point is to grade, not to
  // re-walk every open trade.
  const grade = mode === 'grade';
```

Then find:

```ts
  if (drain) { opts.sweepBudget = Number.MAX_SAFE_INTEGER; opts.gradeBudget = 0; opts.timeBudgetMs = 45_000; }
  if (account) opts.account = account;
```

replace with:

```ts
  if (drain) { opts.sweepBudget = Number.MAX_SAFE_INTEGER; opts.gradeBudget = 0; opts.timeBudgetMs = 45_000; }
  if (grade) { opts.gradeBudget = Number.MAX_SAFE_INTEGER; opts.timeBudgetMs = 45_000; }
  if (account) opts.account = account;
```

(Leave the `try`/response unchanged — `...result` now carries `ai_graded`/`grade_queue_remaining`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/trades-refresh.test.ts --pool=forks`
Expected: PASS — all cases incl. the new one and the unchanged originals.

- [ ] **Step 5: Commit**

```bash
git add "dashboard/api/trades/[action].ts" dashboard/tests/api/trades-refresh.test.ts
git commit -m "feat(dashboard): ?mode=grade drains the needs-grade queue on demand"
```

---

## Task 5: Frontend — grade-backlog button, visibility matrix, regrade gating

**Files:**
- Modify: `dashboard/src/components/trades/RefreshButton.tsx`
- Modify: `dashboard/src/components/trade/GradePanel.tsx`
- Test: `dashboard/tests/components/RefreshButton.test.tsx` (update existing + add cases)
- Test: `dashboard/tests/components/GradePanel.test.tsx` (new)

- [ ] **Step 1: Write/Update the failing tests**

In `dashboard/tests/components/RefreshButton.test.tsx`, **the existing `'scopes the drain button too'` test (account `sm500_paper`) is now invalid** — drain no longer renders on a specific account. Replace it and add visibility + grade cases (keep the existing `manual_paper` refresh and `[any]` refresh tests). Add this describe block:

```ts
describe('RefreshButton visibility + grade backlog', () => {
  it('shows grade backlog on manual; clicking it posts ?mode=grade', async () => {
    apiMock.mockResolvedValue({ ok: true, synced: 0, graded: 0, remaining_open: 0, ai_graded: 2, grade_queue_remaining: 1, assignments_spawned: 0, assignments_skipped: 0 });
    renderBtn('manual_paper');
    const gradeBtn = screen.getByText('[grade backlog]');
    fireEvent.click(gradeBtn);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/trades/refresh?mode=grade&account=manual_paper', { method: 'POST' }));
    await waitFor(() => expect(screen.getByText(/2 graded/)).toBeTruthy());
  });

  it('hides grade backlog on a bot account, shows only refresh', () => {
    renderBtn('conservative_paper');
    expect(screen.getByText('[↻ refresh]')).toBeTruthy();
    expect(screen.queryByText('[grade backlog]')).toBeNull();
    expect(screen.queryByText('[drain backlog]')).toBeNull();
  });

  it('shows drain backlog only on [any] (no account), not grade backlog', () => {
    renderBtn(undefined);
    expect(screen.getByText('[↻ refresh]')).toBeTruthy();
    expect(screen.getByText('[drain backlog]')).toBeTruthy();
    expect(screen.queryByText('[grade backlog]')).toBeNull();
  });

  it('shows refresh + grade (not drain) on live', () => {
    renderBtn('live');
    expect(screen.getByText('[↻ refresh]')).toBeTruthy();
    expect(screen.getByText('[grade backlog]')).toBeTruthy();
    expect(screen.queryByText('[drain backlog]')).toBeNull();
  });
});
```

(`renderBtn`, `apiMock`, and the `beforeEach` already exist in the file from the account-scope work. Reuse them. Remove the now-invalid `'scopes the drain button too'` test.)

Create `dashboard/tests/components/GradePanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GradePanel } from '../../src/components/trade/GradePanel';
import type { Trade, GradeRecord } from '../../src/lib/trade-types';

vi.mock('../../src/lib/api', () => ({ api: vi.fn() }));

function mkTrade(account: Trade['account']): Trade {
  return {
    id: 'T-1', account, asset_class: 'stock', symbol: 'F', side: 'buy', qty: 1,
    order_type: 'market', limit_price: null, stop_price: null, trail_pct: null, tif: 'day',
    contract_symbol: null, strike: null, expiration: null, contract_type: null, greeks_at_entry: null,
    alpaca_order_id: 'x', alpaca_close_order_id: null, submitted_at: '2026-06-23T13:00:00Z',
    filled_at: '2026-06-23T13:01:00Z', filled_avg_price: 14, closed_at: '2026-06-23T15:00:00Z',
    closed_avg_price: 15, realized_pnl: 1, closed_by: 'manual', tags: [], entry_grade: 'B',
    entry_reasoning: 'r', journal: '', exposure_at_submit: 14, rule_warnings_at_entry: [], schema: 1,
  } as Trade;
}
const ungraded: GradeRecord = { trade_id: 'T-1', entry: { letter: 'B', reasoning: 'r', ts: '' }, hindsight: null, history: [] };

function renderPanel(trade: Trade) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><GradePanel trade={trade} grade={ungraded} /></QueryClientProvider>);
}

describe('GradePanel regrade gating', () => {
  it('shows grade/re-grade buttons on a manual trade', () => {
    renderPanel(mkTrade('manual_paper'));
    expect(screen.getByText(/grade now/)).toBeTruthy();
    expect(screen.getByText(/re-grade/)).toBeTruthy();
  });
  it('hides them on a conservative trade and explains why', () => {
    renderPanel(mkTrade('conservative_paper'));
    expect(screen.queryByText(/grade now/)).toBeNull();
    expect(screen.queryByText(/re-grade/)).toBeNull();
    expect(screen.getByText(/grading is off for bot accounts/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard && npx vitest run tests/components/RefreshButton.test.tsx tests/components/GradePanel.test.tsx --pool=forks`
Expected: FAIL — no grade button / visibility logic yet; GradePanel always shows regrade buttons.

- [ ] **Step 3: Implement RefreshButton**

In `dashboard/src/components/trades/RefreshButton.tsx`:

Add the import:

```tsx
import { isGradeable } from '../../lib/trade-types';
```

Extend `RefreshResult` with the new optional fields:

```tsx
interface RefreshResult {
  ok: true;
  graded: number;
  synced: number;
  remaining_open: number;
  assignments_spawned: number;
  assignments_skipped: number;
  ai_graded?: number;
  grade_queue_remaining?: number;
}
```

Add a `lastMode` state next to the others:

```tsx
  const [lastMode, setLastMode] = useState<'refresh' | 'drain' | 'grade'>('refresh');
```

Replace the `run` callback signature + path construction. Find `const run = useCallback(async (drain: boolean) => {` … through the `const data = await api<RefreshResult>(path, { method: 'POST' });` line, and replace the callback so it takes a mode:

```tsx
  const run = useCallback(async (mode: 'refresh' | 'drain' | 'grade') => {
    if (loading || cooldownLeft > 0) return;
    setLoading(true);
    setError(null);
    setLastMode(mode);
    try {
      const params = new URLSearchParams();
      if (mode === 'drain') params.set('mode', 'drain');
      if (mode === 'grade') params.set('mode', 'grade');
      if (account) params.set('account', account);
      const qs = params.toString();
      const path = `/api/trades/refresh${qs ? `?${qs}` : ''}`;
      const data = await api<RefreshResult>(path, { method: 'POST' });
      setLastResult(data);
      setCooldownLeft(COOLDOWN_SECONDS);
      await qc.invalidateQueries({ queryKey: ['trades'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'refresh failed');
    } finally {
      setLoading(false);
    }
  }, [loading, cooldownLeft, qc, account]);
```

Update the refresh button's `onClick` from `() => run(false)` to `() => run('refresh')`, and the drain button's from `() => run(true)` to `() => run('drain')`. Wrap the **drain** button so it only renders when there's no account (i.e. `[any]`). Find the drain `<button …>[drain backlog]</button>` and wrap it:

```tsx
      {!account && (
        <button
          type="button"
          onClick={() => run('drain')}
          disabled={disabled}
          className={btnClass(disabled)}
          title="drain the whole open backlog in one pass (syncs + close-detects until ~45s budget; grades fill in later)"
        >
          [drain backlog]
        </button>
      )}
```

Add the **grade** button immediately after the drain button, rendered only for gradeable accounts:

```tsx
      {account && isGradeable(account) && (
        <button
          type="button"
          onClick={() => run('grade')}
          disabled={disabled}
          className={btnClass(disabled)}
          title="run AI grading on this account's closed-but-ungraded trades now (~45s batches; click again to continue)"
        >
          {loading && lastMode === 'grade' ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 bg-hi rounded-sm animate-pulse" />
              grading…
            </span>
          ) : (
            <>[grade backlog]</>
          )}
        </button>
      )}
```

Pass `mode` to the result strip. Change `<ResultSummary result={lastResult} account={account} />` to `<ResultSummary result={lastResult} account={account} mode={lastMode} />`.

Update `ResultSummary` to be mode-aware. Replace the function with:

```tsx
function ResultSummary({ result, account, mode }: { result: RefreshResult; account?: string; mode: 'refresh' | 'drain' | 'grade' }) {
  const scope = account ? ` · ${accountLabel(account)}` : '';

  if (mode === 'grade') {
    const g = result.ai_graded ?? 0;
    const q = result.grade_queue_remaining ?? 0;
    const head = g > 0 ? `${g} graded` : 'nothing to grade';
    const tail = q > 0 ? `${q} queued` : 'queue empty';
    return <span className="text-mid text-[10px]">{head} · {tail}{scope}</span>;
  }

  const parts: string[] = [];
  if (result.synced > 0) parts.push(`${result.synced} synced`);
  if (result.graded > 0) parts.push(`${result.graded} closed`);
  if (result.assignments_spawned > 0) parts.push(`${result.assignments_spawned} assigned`);

  if (parts.length === 0) {
    return <span className="text-dim text-[10px]">nothing to update · {result.remaining_open} open{scope}</span>;
  }
  return <span className="text-mid text-[10px]">{parts.join(' · ')} · {result.remaining_open} still open{scope}</span>;
}
```

(`accountLabel` already exists in this file from the account-scope work.)

- [ ] **Step 4: Implement GradePanel gating**

In `dashboard/src/components/trade/GradePanel.tsx`:

Add the import:

```tsx
import { isGradeable } from '../../lib/trade-types';
```

At the top of the component body (after the `regrade` mutation), add:

```tsx
  const gradeable = isGradeable(trade.account);
```

Gate the ungraded-state "grade now*" button. Find the `else` branch that renders `// ungraded — cron picks up closed trades within 5 min` + the grade-now button, and replace its inner content so non-gradeable accounts get a static note instead of a button:

```tsx
            <div className="mt-2">
              {gradeable ? (
                <>
                  <div className="text-mid text-[10px] pulse">// ungraded — cron picks up closed trades within 5 min</div>
                  <button
                    type="button"
                    className="pbtn active mt-2"
                    onClick={() => regrade.mutate()}
                    disabled={regrading}
                  >[{regrading ? 'grading…' : 'grade now*'}]</button>
                </>
              ) : (
                <div className="text-dim text-[10px]">// grading is off for bot accounts — only manual &amp; live are AI-graded</div>
              )}
            </div>
```

Gate the footer "re-grade*" button. Find the footer `<button … >[{regrading ? 'regrading…' : 're-grade*'}]</button>` and wrap it so it only renders when gradeable:

```tsx
        {gradeable && (
          <button
            type="button" className="pbtn active"
            onClick={() => regrade.mutate()}
            disabled={regrading}
          >[{regrading ? 'regrading…' : 're-grade*'}]</button>
        )}
```

- [ ] **Step 5: Run to verify they pass + typecheck**

Run: `cd dashboard && npx vitest run tests/components/RefreshButton.test.tsx tests/components/GradePanel.test.tsx --pool=forks`
Expected: PASS.

Run: `cd dashboard && npx tsc -b`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/trades/RefreshButton.tsx dashboard/src/components/trade/GradePanel.tsx dashboard/tests/components/RefreshButton.test.tsx dashboard/tests/components/GradePanel.test.tsx
git commit -m "feat(dashboard): grade-backlog button + button visibility matrix + regrade gating"
```

---

## Task 6: Changelog + full verification

**Files:**
- Modify: `dashboard/src/data/changelog.ts`

- [ ] **Step 1: Add the changelog entry**

Prepend at the TOP of the `CHANGELOG` array:

```ts
  {
    date: '2026-06-23',
    category: 'feature',
    title: 'AI grading now manual + live only, plus a "grade backlog" button',
    details:
      'AI hindsight grading is restricted to the accounts where you hand-pick entry grades — manual and '
      + 'live. Conservative, aggressive, and the SM accounts close normally with full P&L but no longer get '
      + 'an AI grade (it was noise and Sonnet spend, since those are bot-opened). Your calibration stats are '
      + 'now manual+live only, which is the population where your grades are real. Existing grades are left '
      + 'as-is. The re-grade button is hidden on the bot accounts.\n\n'
      + 'New on /trades: a [grade backlog] button (manual/live only) that runs the AI grading on the '
      + 'closed-but-ungraded queue on demand instead of waiting for the cron, scoped to the account you\'re '
      + 'viewing — reports "graded N · M queued" and works in ~45s batches. The button row is now '
      + 'context-aware: Refresh everywhere, Grade backlog on manual/live, Drain backlog only on [any] '
      + '(its global-pile job is moot per-account now that Refresh is scoped).',
  },
```

- [ ] **Step 2: Full suite**

Run: `cd dashboard && npx vitest run --pool=forks`
Expected: PASS — all files green (prior 796 + new tests; expect ~810+).

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/data/changelog.ts
git commit -m "docs(dashboard): changelog — grading scope + grade backlog"
```

---

## Ship (orchestrator, after review)

Soft-reset the changelog commit, `npm run bump` (dashboard digit), recommit, rebase onto latest `origin/main`, push, `npx vercel --prod --yes`.

---

## Self-Review

**Spec coverage:** policy single-source = Task 1 (`isGradeable` in trade-types, re-exported); gate close-loop + queue drain = Task 2; gate regrade endpoint = Task 3; `?mode=grade` = Task 4; grade-backlog button + visibility matrix (Refresh all / Grade manual+live / Drain `[any]`) + regrade button hidden = Task 5; existing grades untouched = nothing removes them.

**Placeholder scan:** production code complete. The two mock-heavy tests (cron-grading-gate, regrade-gate) give exact assertions + a model reference (`cron-d11` / `trades-refresh`), verified via `--pool=forks`.

**Type consistency:** `isGradeable(account: AccountId)` used server-side (cron, regrade) and client-side (RefreshButton, GradePanel via the `src/lib/trade-types` re-export); `drainNeedsGrade(budget, isOutOfTime?, account?)` third arg matches `accountFilter` (`string | undefined`); `runGradeOpenTrades` return gains `ai_graded`/`grade_queue_remaining`, surfaced in `RefreshResult` (optional) and read by `ResultSummary`; `?mode=grade` sets `gradeBudget`+`timeBudgetMs` only (no `sweepBudget`), asserted in Task 4.
```
