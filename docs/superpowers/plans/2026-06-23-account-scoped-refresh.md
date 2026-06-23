# Account-Scoped Refresh / Drain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `/trades` refresh + drain buttons scope their work and their "N still open" count to the account currently selected in the page's account filter, instead of always operating globally across all seven accounts.

**Architecture:** The buttons pass the page's `filters.account` to `POST /api/trades/refresh?account=<id>`. The endpoint forwards it to `runGradeOpenTrades({ account })`, which filters the open-trades index to that account, processes that scoped list directly (skipping the global rotating cursor), and returns the scoped `remaining_open`. When no account is passed (the scheduled cron, or the `[any]` filter), behavior is **byte-identical to today**.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Vercel serverless, Upstash Redis.

---

## Design (approved)

- **Scope source:** the `/trades` page already filters its table by an in-page `filters.account` ([Trades.tsx:35](../../dashboard/src/routes/Trades.tsx)) — a single `AccountId` (`manual_paper`, `live`, …) or `undefined` for `[any]`. There are **no groups** here, so scoping is just "one account or all." The button reads this via a new prop (not the global sidebar selector — that doesn't drive this table).
- **Scope the work AND the count.** Scoping only the count would be misleading: the global cursor might sweep other accounts on a given click, so "refresh manual" could close zero manual trades while showing a manual count. So a scoped run processes only that account's open trades.
- **Cron untouched.** The scheduled 5-min cron calls `runGradeOpenTrades()` with no `account`, so it stays global with its rotating cursor — nothing falls through the cracks. Account scoping only happens on a manual button click.
- **Cost:** a scoped run loads each open trade once to read its `.account` (the index stores only ids; there's no per-account index). One extra read per open trade on a manual click — fine, and YAGNI vs. building a per-account index.

---

## Task 1: Scope `runGradeOpenTrades` to an optional account

**Files:**
- Modify: `dashboard/api/cron/[job].ts` (the `runGradeOpenTrades` function, ~lines 112–286)
- Test: `dashboard/tests/api/cron-account-scope.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/api/cron-account-scope.test.ts`. **Model the mock setup on `dashboard/tests/api/cron-d11-settlement-backstop.test.ts`** (same `vi.mock` blocks for `../../api/_lib/kv`, `../../api/_lib/data-api`, `../../api/_lib/alpaca`, `../../api/_lib/grading`, `../../api/_lib/proposal-prompts`, and the `../../api/trades/[action]` auto-import stub). Then:

Set up THREE open trades in the index — two `manual_paper`, one `conservative_paper` — all filled options whose position is still present, so `detectClose` returns null and nothing closes (mirror how cron-d11 case (2) keeps a trade open: `alpacaTrade` resolves a present position / empty activity so no close is detected). Mock `kvLrange(KV_KEYS.tradesIndexOpen)` → `['m1','m2','c1']`, `kvGet(tradeKey('m1'|'m2'))` → `account:'manual_paper'`, `kvGet(tradeKey('c1'))` → `account:'conservative_paper'`, `kvGet(tradesSweepCursor)` → `0`.

Assert exactly these behaviors (the scoping contract):

```ts
// 1. Scoped run counts only the selected account's open trades.
const scoped = await runGradeOpenTrades({ account: 'manual_paper' });
expect(scoped.remaining_open).toBe(2);

// 2. Scoped run never touches the global rotating cursor.
const cursorWrites = kvSet.mock.calls.filter(
  ([key]) => key === KV_KEYS.tradesSweepCursor,
);
expect(cursorWrites).toHaveLength(0);

// 3. Regression: an UNSCOPED run still counts all accounts AND uses the cursor.
kvSet.mockClear();
const global = await runGradeOpenTrades();
expect(global.remaining_open).toBe(3);
expect(
  kvSet.mock.calls.some(([key]) => key === KV_KEYS.tradesSweepCursor),
).toBe(true);
```

Import `runGradeOpenTrades` from `../../api/cron/[job]` and `KV_KEYS` from `../../api/_lib/kv-keys`. (You may need a small per-call reset of `kvGet`/`kvLrange` implementations between the scoped and global calls — keep the same three-trade fixture for both.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/cron-account-scope.test.ts --pool=forks`
Expected: FAIL — `runGradeOpenTrades` doesn't accept `account` yet, so the scoped call still counts 3 (and writes the cursor). Use `--pool=forks` (threads pool times out in this worktree).

- [ ] **Step 3: Implement the account filter + cursor skip**

In `dashboard/api/cron/[job].ts`, change the `runGradeOpenTrades` signature to add `account`:

```ts
export async function runGradeOpenTrades(opts: {
  sweepBudget?: number;
  gradeBudget?: number;
  timeBudgetMs?: number;
  // When set, scope the sweep + the remaining_open count to this one account
  // (a manual /trades refresh of a single account). Skips the global rotating
  // cursor entirely so the scheduled cron sweep is unaffected.
  account?: string;
} = {}): Promise<{
```

(Leave the `Promise<{ ... }>` return type block exactly as-is.)

Just after `const outOfTime = ...;`, add:

```ts
  const accountFilter = opts.account;
```

Replace the open-index read:

```ts
  const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
```

with the filtered version:

```ts
  const allOpenIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
  // Account-scoped manual refresh: keep only this account's open trades and
  // process that list directly. The open index stores ids only, so we load each
  // record to read its `.account` — one extra read per open trade on a manual
  // click (no per-account index; YAGNI).
  let openIds = allOpenIds;
  if (accountFilter) {
    const scoped: string[] = [];
    for (const id of allOpenIds) {
      const t = await kv().get<Trade>(tradeKey(id));
      if (t && t.account === accountFilter) scoped.push(id);
    }
    openIds = scoped;
  }
```

Replace the cursor setup block:

```ts
  const N = openIds.length;
  const startRaw = (await kv().get<number>(KV_KEYS.tradesSweepCursor)) ?? 0;
  const start = N > 0 ? (((startRaw % N) + N) % N) : 0;
  const sweepCount = Math.min(sweepBudget, N);
  // Advance the cursor for next tick before doing the work, so a mid-sweep
  // crash still makes forward progress on the following tick. (When the loop
  // stops early on timeBudget, the post-loop write below corrects this to the
  // actual stopping point so a follow-up call resumes where this one left off.)
  if (N > 0) await kv().set(KV_KEYS.tradesSweepCursor, (start + sweepCount) % N);
```

with a version that skips the cursor entirely when scoped:

```ts
  const N = openIds.length;
  // Scoped runs process from the head of the filtered list and never read or
  // write the global rotating cursor — that cursor belongs to the unscoped cron
  // sweep, and a manual single-account refresh must not perturb its fairness.
  let start = 0;
  if (!accountFilter && N > 0) {
    const startRaw = (await kv().get<number>(KV_KEYS.tradesSweepCursor)) ?? 0;
    start = (((startRaw % N) + N) % N);
  }
  const sweepCount = Math.min(sweepBudget, N);
  // Advance the cursor for next tick before doing the work, so a mid-sweep
  // crash still makes forward progress on the following tick. (When the loop
  // stops early on timeBudget, the post-loop write below corrects this to the
  // actual stopping point so a follow-up call resumes where this one left off.)
  if (!accountFilter && N > 0) await kv().set(KV_KEYS.tradesSweepCursor, (start + sweepCount) % N);
```

Replace the post-loop cursor correction:

```ts
  if (N > 0) await kv().set(KV_KEYS.tradesSweepCursor, (start + processed) % N);
```

with:

```ts
  if (!accountFilter && N > 0) await kv().set(KV_KEYS.tradesSweepCursor, (start + processed) % N);
```

Leave the loop body, `drainNeedsGrade`, `drainAssignmentsAndSpawn`, `runAutoImport`, and the `return` block unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/cron-account-scope.test.ts --pool=forks`
Expected: PASS (3 assertions). Iterate the mock wiring (not the production code) until the `detectClose`-returns-null setup holds and the assertions pass.

- [ ] **Step 5: Run the existing cron tests to confirm no regression**

Run: `cd dashboard && npx vitest run tests/api/cron-d11-settlement-backstop.test.ts tests/api/cron-assignment-detect.test.ts tests/api/cron-assignment-drain.test.ts --pool=forks`
Expected: PASS — the unscoped path is byte-identical, so existing cron tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add dashboard/api/cron/[job].ts dashboard/tests/api/cron-account-scope.test.ts
git commit -m "feat(dashboard): runGradeOpenTrades can scope the sweep to one account"
```

---

## Task 2: Forward `account` through the refresh endpoint

**Files:**
- Modify: `dashboard/api/trades/[action].ts` (the `refresh` function, ~lines 200–224)
- Test: `dashboard/tests/api/trades-refresh.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append two cases inside the `describe('POST /api/trades/refresh', …)` block in `dashboard/tests/api/trades-refresh.test.ts`:

```ts
  it('forwards ?account to runGradeOpenTrades (non-drain scoped refresh)', async () => {
    runGradeOpenTradesMock.mockResolvedValueOnce({
      graded: 0, synced: 1, remaining_open: 2, assignments_spawned: 0, assignments_skipped: 0,
    });
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ account: 'manual_paper' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(runGradeOpenTradesMock).toHaveBeenCalledWith({ account: 'manual_paper' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, remaining_open: 2 }));
  });

  it('combines mode=drain with ?account', async () => {
    runGradeOpenTradesMock.mockResolvedValueOnce({
      graded: 3, synced: 0, remaining_open: 0, assignments_spawned: 0, assignments_skipped: 0,
    });
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ mode: 'drain', account: 'sm500_paper' }), res);

    expect(runGradeOpenTradesMock).toHaveBeenCalledWith(expect.objectContaining({
      sweepBudget: Number.MAX_SAFE_INTEGER, gradeBudget: 0, timeBudgetMs: 45_000, account: 'sm500_paper',
    }));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/trades-refresh.test.ts --pool=forks`
Expected: FAIL — the endpoint currently ignores `account`, so `runGradeOpenTrades` is called with `()` / no account.

- [ ] **Step 3: Implement the pass-through**

Replace the `refresh` function body in `dashboard/api/trades/[action].ts`. Find:

```ts
  const drain = String((req.query?.mode ?? '')) === 'drain';
  try {
    const result = drain
      ? await runGradeOpenTrades({
          sweepBudget: Number.MAX_SAFE_INTEGER,
          gradeBudget: 0,
          timeBudgetMs: 45_000,
        })
      : await runGradeOpenTrades();
    return res.status(200).json({ ok: true, drain, ...result });
```

Replace with:

```ts
  const drain = String((req.query?.mode ?? '')) === 'drain';
  // Optional account scope: a /trades refresh of a single account passes the
  // page's selected account so the sweep + the "N still open" count cover only
  // that account. Absent (the [any] filter, or the scheduled cron) → global.
  const account = req.query?.account ? String(req.query.account) : undefined;
  const opts: { sweepBudget?: number; gradeBudget?: number; timeBudgetMs?: number; account?: string } = {};
  if (drain) { opts.sweepBudget = Number.MAX_SAFE_INTEGER; opts.gradeBudget = 0; opts.timeBudgetMs = 45_000; }
  if (account) opts.account = account;
  try {
    // Preserve the no-arg call when neither drain nor account is set so the
    // scheduled-cron call path stays byte-identical.
    const result = Object.keys(opts).length
      ? await runGradeOpenTrades(opts)
      : await runGradeOpenTrades();
    return res.status(200).json({ ok: true, drain, ...result });
```

(Leave the `catch` block unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/trades-refresh.test.ts --pool=forks`
Expected: PASS — all cases incl. the two new ones AND the original "called with no args" default case (unchanged when neither drain nor account).

- [ ] **Step 5: Commit**

```bash
git add "dashboard/api/trades/[action].ts" dashboard/tests/api/trades-refresh.test.ts
git commit -m "feat(dashboard): refresh endpoint forwards ?account to the scoped sweep"
```

---

## Task 3: Make RefreshButton account-aware + wire Trades page

**Files:**
- Modify: `dashboard/src/components/trades/RefreshButton.tsx`
- Modify: `dashboard/src/routes/Trades.tsx` (pass the prop)
- Test: `dashboard/tests/components/RefreshButton.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/components/RefreshButton.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RefreshButton from '../../src/components/trades/RefreshButton';

const apiMock = vi.fn();
vi.mock('../../src/lib/api', () => ({ api: (...a: any[]) => apiMock(...a) }));

function renderБtn(account?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RefreshButton account={account} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({
    ok: true, graded: 0, synced: 0, remaining_open: 2,
    assignments_spawned: 0, assignments_skipped: 0,
  });
});

describe('RefreshButton account scope', () => {
  it('sends ?account when an account is selected and labels the count', async () => {
    renderБtn('manual_paper');
    fireEvent.click(screen.getByText('[↻ refresh]'));
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith('/api/trades/refresh?account=manual_paper', { method: 'POST' });
    await waitFor(() => expect(screen.getByText(/· manual/)).toBeTruthy());
  });

  it('omits ?account when no account is selected (global)', async () => {
    renderБtn(undefined);
    fireEvent.click(screen.getByText('[↻ refresh]'));
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith('/api/trades/refresh', { method: 'POST' });
  });

  it('scopes the drain button too', async () => {
    renderБtn('sm500_paper');
    fireEvent.click(screen.getByText('[drain backlog]'));
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith('/api/trades/refresh?mode=drain&account=sm500_paper', { method: 'POST' });
  });
});
```

(Rename the `renderБtn` helper to `renderBtn` — avoid the stray non-ASCII character; it's only there to be obviously replaced.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard && npx vitest run tests/components/RefreshButton.test.tsx --pool=forks`
Expected: FAIL — `RefreshButton` takes no props yet and always calls `/api/trades/refresh` (no account), and renders no `· manual` label.

- [ ] **Step 3: Implement the account-aware button**

In `dashboard/src/components/trades/RefreshButton.tsx`:

Change the component signature and the `run` callback to thread an `account` prop into the request path:

```tsx
export default function RefreshButton({ account }: { account?: string }) {
```

Replace the `run` callback's path construction. Find:

```tsx
      const path = drain ? '/api/trades/refresh?mode=drain' : '/api/trades/refresh';
      const data = await api<RefreshResult>(path, { method: 'POST' });
```

with:

```tsx
      const params = new URLSearchParams();
      if (drain) params.set('mode', 'drain');
      if (account) params.set('account', account);
      const qs = params.toString();
      const path = `/api/trades/refresh${qs ? `?${qs}` : ''}`;
      const data = await api<RefreshResult>(path, { method: 'POST' });
```

Add `account` to the `useCallback` dependency array (find `}, [loading, cooldownLeft, qc]);` and change it to `}, [loading, cooldownLeft, qc, account]);`).

Pass `account` to the result strip. Find:

```tsx
      {!error && lastResult && (
        <ResultSummary result={lastResult} />
      )}
```

replace with:

```tsx
      {!error && lastResult && (
        <ResultSummary result={lastResult} account={account} />
      )}
```

Update `ResultSummary` to render the account label. Replace the whole function:

```tsx
function ResultSummary({ result }: { result: RefreshResult }) {
  const parts: string[] = [];
  if (result.synced > 0) parts.push(`${result.synced} synced`);
  if (result.graded > 0) parts.push(`${result.graded} closed`);
  if (result.assignments_spawned > 0) parts.push(`${result.assignments_spawned} assigned`);

  if (parts.length === 0) {
    return (
      <span className="text-dim text-[10px]">
        nothing to update · {result.remaining_open} open
      </span>
    );
  }

  return (
    <span className="text-mid text-[10px]">
      {parts.join(' · ')} · {result.remaining_open} still open
    </span>
  );
}
```

with:

```tsx
// 'manual_paper' → 'manual', 'sm500_paper' → 'sm500', 'live' → 'live'.
function accountLabel(account: string): string {
  return account === 'live' ? 'live' : account.replace(/_paper$/, '');
}

function ResultSummary({ result, account }: { result: RefreshResult; account?: string }) {
  const scope = account ? ` · ${accountLabel(account)}` : '';
  const parts: string[] = [];
  if (result.synced > 0) parts.push(`${result.synced} synced`);
  if (result.graded > 0) parts.push(`${result.graded} closed`);
  if (result.assignments_spawned > 0) parts.push(`${result.assignments_spawned} assigned`);

  if (parts.length === 0) {
    return (
      <span className="text-dim text-[10px]">
        nothing to update · {result.remaining_open} open{scope}
      </span>
    );
  }

  return (
    <span className="text-mid text-[10px]">
      {parts.join(' · ')} · {result.remaining_open} still open{scope}
    </span>
  );
}
```

- [ ] **Step 4: Wire the Trades page**

In `dashboard/src/routes/Trades.tsx`, find:

```tsx
        <RefreshButton />
```

replace with:

```tsx
        <RefreshButton account={filters.account} />
```

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `cd dashboard && npx vitest run tests/components/RefreshButton.test.tsx --pool=forks`
Expected: PASS — 3 tests.

Run: `cd dashboard && npx tsc -b`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/trades/RefreshButton.tsx dashboard/src/routes/Trades.tsx dashboard/tests/components/RefreshButton.test.tsx
git commit -m "feat(dashboard): /trades refresh + drain scope to the selected account"
```

---

## Task 4: Changelog + full verification

**Files:**
- Modify: `dashboard/src/data/changelog.ts`

- [ ] **Step 1: Add the changelog entry**

Prepend at the TOP of the `CHANGELOG` array in `dashboard/src/data/changelog.ts`:

```ts
  {
    date: '2026-06-23',
    category: 'feature',
    title: 'Refresh / drain on /trades now scope to the account you\'re viewing',
    details:
      'The [↻ refresh] and [drain backlog] buttons used to sync every open trade across all seven '
      + 'accounts and report a global "N still open" count — confusing when you\'re focused on one '
      + 'account. They now respect the page\'s account filter: clicking refresh while viewing manual '
      + 'syncs only manual\'s open trades and reports manual\'s open count (e.g. "12 still open · manual"). '
      + 'Select [any] for the old global behavior. The scheduled 5-min background cron is unchanged and '
      + 'still sweeps every account, so nothing falls through the cracks — the buttons are just an '
      + 'on-demand "catch this account up now."',
  },
```

- [ ] **Step 2: Full suite**

Run: `cd dashboard && npx vitest run --pool=forks`
Expected: PASS — all files green (prior 790 + ~8 new = ~798).

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/data/changelog.ts
git commit -m "docs(dashboard): changelog — account-scoped refresh/drain"
```

---

## Ship (orchestrator, after review)

Not a subagent task: `npm run bump` (dashboard digit), commit, rebase onto latest `origin/main`, push, `npx vercel --prod --yes` (link first if needed).

---

## Self-Review

**Spec coverage:** scope source = `filters.account` (Task 3 wires it); scope work + count = Task 1 (filter + remaining_open) ; cron untouched = Task 1 (`if (!accountFilter)` guards keep the no-account path byte-identical, asserted by Task 1 Step 5 + the regression assertion); endpoint forwarding = Task 2; UI label = Task 3.

**Placeholder scan:** none — production code is complete; the only modeling-by-reference is the cron test's `detectClose`-returns-null mock wiring (Task 1 Step 1), which mirrors the cited `cron-d11` test and is verified by `--pool=forks`.

**Type consistency:** `runGradeOpenTrades` opts gains `account?: string` (Task 1) and is called with `{ account }` (Task 2); `RefreshButton` prop `account?: string` matches `filters.account` (`string | undefined`) in `Trades.tsx`; response shape `{ ok, drain, ...result }` is unchanged so the existing endpoint test's exact-shape assertion still holds.
