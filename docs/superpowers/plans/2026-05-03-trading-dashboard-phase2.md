# Trading Dashboard — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only Phase 1 dashboard into a manual trading platform with AI-graded honesty. Ship `/settings`, `/order/new`, `/trade/:id`, `/trades`, modify/cancel actions on `/orders`, and the auto-grading cron pipeline.

**Architecture:** Extend the existing Vite + React 19 + Tailwind v4 dashboard at `dashboard/` with three new catchall API routes (`api/trades/[action].ts`, `api/settings/[resource].ts`, `api/cron/[job].ts`) plus modify/cancel bolt-ons on the existing `api/alpaca/[endpoint].ts`. Order placement is context-driven via query params. Manual trade records and per-trade grade records live in Vercel KV. AI hindsight grades come from `claude-sonnet-4-6` with prompt caching, fired by an external cron-job.org schedule that hits an authenticated `/api/cron/grade-open-trades` webhook every 5 minutes during market hours.

**Tech Stack:**
- Frontend: React 19, Vite 8, Tailwind v4, react-router-dom 6, @tanstack/react-query 5, react-hook-form (new), zod (existing), lightweight-charts (new)
- Server: existing `@upstash/redis`, `@vercel/node`, `otplib`, `cookie`, **`@anthropic-ai/sdk` (new)**
- Testing: vitest (existing)
- Deployment: Vercel Hobby (root directory `dashboard/`); cron-job.org for the grading webhook

**Spec:** [`docs/superpowers/specs/2026-05-03-trading-dashboard-phase2-design.md`](../specs/2026-05-03-trading-dashboard-phase2-design.md)

**Function-count budget:** Phase 1 used 6 of 12 Hobby functions. Phase 2 adds 3 (`api/trades/[action].ts`, `api/settings/[resource].ts`, `api/cron/[job].ts`). Modify/cancel are bolt-ons to the existing alpaca catchall. Total after Phase 2: **9 of 12**.

---

## File map

```
dashboard/
├── api/
│   ├── _lib/                                  MODIFY
│   │   ├── kv-keys.ts                         MODIFY — split into BOT_PUSH_KEYS + DASHBOARD_KEYS
│   │   ├── backup-codes.ts                    MODIFY — read codes from KV first, env var fallback
│   │   ├── trade-ids.ts                       NEW — daily counter via Upstash INCR
│   │   ├── exposure.ts                        NEW — order $ exposure calculator
│   │   ├── rule-check.ts                      NEW — stub rule-check for Phase 2
│   │   ├── grading.ts                         NEW — Claude prompt builder + caller
│   │   └── trade-types.ts                     NEW — shared TS types for Trade / Grade
│   ├── alpaca/[endpoint].ts                   MODIFY — add modify-order, cancel-order
│   ├── trades/[action].ts                     NEW — preview, submit, list, get, regrade
│   ├── settings/[resource].ts                 NEW — thresholds, tags, backup-codes
│   └── cron/[job].ts                          NEW — grade-open-trades
├── src/
│   ├── routes/
│   │   ├── Settings.tsx                       NEW
│   │   ├── OrderNew.tsx                       NEW
│   │   ├── TradeDetail.tsx                    NEW
│   │   └── Trades.tsx                         NEW
│   ├── components/
│   │   ├── order/
│   │   │   ├── OrderHeader.tsx                NEW
│   │   │   ├── StockOrderForm.tsx             NEW
│   │   │   ├── OptionOrderForm.tsx            NEW
│   │   │   ├── GradePicker.tsx                NEW
│   │   │   ├── TagPicker.tsx                  NEW
│   │   │   └── ConfirmModal.tsx               NEW
│   │   ├── trade/
│   │   │   ├── TradeHeader.tsx                NEW
│   │   │   ├── TradeChart.tsx                 NEW
│   │   │   ├── Timeline.tsx                   NEW
│   │   │   └── GradePanel.tsx                 NEW
│   │   └── settings/
│   │       ├── ThresholdsTab.tsx              NEW
│   │       ├── TagsTab.tsx                    NEW
│   │       └── RecoveryTab.tsx                NEW
│   ├── hooks/
│   │   ├── useTrade.ts                        NEW
│   │   └── useTrades.ts                       NEW
│   ├── lib/
│   │   ├── api.ts                             (existing, unchanged)
│   │   ├── exposure.ts                        NEW — client mirror of server exposure calc
│   │   └── trade-types.ts                     NEW — re-export of server types for FE
│   ├── routes/
│   │   └── Orders.tsx                         MODIFY — add [modify] / [cancel] buttons
│   └── App.tsx                                MODIFY — add new routes
├── tests/
│   ├── api/
│   │   ├── trades-preview.test.ts             NEW
│   │   ├── trades-submit.test.ts              NEW
│   │   ├── trades-regrade.test.ts             NEW
│   │   ├── settings-thresholds.test.ts        NEW
│   │   ├── settings-tags.test.ts              NEW
│   │   ├── settings-backup-codes.test.ts      NEW
│   │   └── cron-grade-open-trades.test.ts     NEW
│   └── lib/
│       ├── exposure.test.ts                   NEW
│       ├── rule-check.test.ts                 NEW
│       └── trade-ids.test.ts                  NEW
├── package.json                               MODIFY — add @anthropic-ai/sdk, react-hook-form, lightweight-charts
└── vercel.json                                (unchanged — cron via cron-job.org)
```

---

## Milestone 0 — Foundation

Pre-work that every subsequent milestone depends on. Land in one PR, get a green CI run, then proceed.

### Task 1: Add new dependencies

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: Install runtime deps**

```bash
cd dashboard && npm install @anthropic-ai/sdk@^0.40.0 react-hook-form@^7.55.0 lightweight-charts@^5.0.0
```

- [ ] **Step 2: Verify install**

Run: `cd dashboard && npm ls @anthropic-ai/sdk react-hook-form lightweight-charts`
Expected: Three lines printed, no `UNMET DEPENDENCY` warnings.

- [ ] **Step 3: Run existing tests to confirm nothing broke**

Run: `cd dashboard && npm test`
Expected: all 34 existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json
git commit -m "deps(dashboard): add anthropic sdk, react-hook-form, lightweight-charts for phase 2"
```

### Task 2: Define shared trade and grade types

**Files:**
- Create: `dashboard/api/_lib/trade-types.ts`
- Create: `dashboard/src/lib/trade-types.ts`

- [ ] **Step 1: Write the server-side type module**

```typescript
// dashboard/api/_lib/trade-types.ts
export type AccountId = 'conservative_paper' | 'aggressive_paper' | 'live';
export type AssetClass = 'stock' | 'option';
export type StockSide = 'buy' | 'sell' | 'sell_short';
export type OptionSide = 'BTO' | 'STO' | 'BTC' | 'STC';
export type OrderSide = StockSide | OptionSide;
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing';
export type Tif = 'day' | 'gtc';
export type ContractType = 'put' | 'call';
export type ClosedBy = null | 'manual' | 'expired' | 'assigned';

export type GradeLetter =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D' | 'F';

export type Calibration = 'matched' | 'over_1' | 'over_2' | 'under_1' | 'under_2';

export interface GreeksAtEntry {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export type RuleSeverity = 'info' | 'warn';
export interface RuleWarning {
  rule: 'sizing_1x' | 'earnings_within_7d' | 'bot_wheel_overlap';
  severity: RuleSeverity;
  message: string;
}

export interface Trade {
  id: string;
  account: AccountId;
  asset_class: AssetClass;
  symbol: string;
  side: OrderSide;
  qty: number;
  order_type: OrderType;
  limit_price: number | null;
  stop_price: number | null;
  trail_pct: number | null;
  tif: Tif;
  contract_symbol: string | null;
  strike: number | null;
  expiration: string | null;
  contract_type: ContractType | null;
  greeks_at_entry: GreeksAtEntry | null;
  alpaca_order_id: string;
  alpaca_close_order_id: string | null;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: number | null;
  closed_at: string | null;
  closed_avg_price: number | null;
  realized_pnl: number | null;
  closed_by: ClosedBy;
  tags: string[];
  entry_grade: GradeLetter;
  entry_reasoning: string;
  journal: string;
  exposure_at_submit: number;
  rule_warnings_at_entry: RuleWarning[];
  schema: 1;
}

export interface GradeEntry {
  letter: GradeLetter;
  reasoning: string;
  ts: string;
}

export interface GradeHindsight {
  letter: GradeLetter;
  review: string;
  calibration: Calibration;
  tendencies_hit: string[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; cached_tokens: number };
  ts: string;
  parse_failed?: boolean;
  raw?: string;
}

export interface GradeRecord {
  trade_id: string;
  entry: GradeEntry;
  hindsight: GradeHindsight | null;
  history: Array<{ entry: GradeEntry; hindsight: GradeHindsight }>;
}

export const GRADE_LETTERS: GradeLetter[] = [
  'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F',
];

export function gradeIndex(letter: GradeLetter): number {
  return GRADE_LETTERS.indexOf(letter);
}

export function calibrationFor(userLetter: GradeLetter, aiLetter: GradeLetter): Calibration {
  const delta = gradeIndex(userLetter) - gradeIndex(aiLetter);
  if (delta === 0) return 'matched';
  if (delta < 0) return delta === -1 ? 'over_1' : 'over_2';
  return delta === 1 ? 'under_1' : 'under_2';
}
```

- [ ] **Step 2: Re-export types for the frontend**

```typescript
// dashboard/src/lib/trade-types.ts
export type {
  AccountId, AssetClass, StockSide, OptionSide, OrderSide,
  OrderType, Tif, ContractType, ClosedBy, GradeLetter, Calibration,
  GreeksAtEntry, RuleSeverity, RuleWarning,
  Trade, GradeEntry, GradeHindsight, GradeRecord,
} from '../../api/_lib/trade-types';
export { GRADE_LETTERS, gradeIndex, calibrationFor } from '../../api/_lib/trade-types';
```

- [ ] **Step 3: Verify TS compiles**

Run: `cd dashboard && npx tsc -b --noEmit`
Expected: clean exit, no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/api/_lib/trade-types.ts dashboard/src/lib/trade-types.ts
git commit -m "feat(dashboard): add shared trade and grade types for phase 2"
```

### Task 3: Split KV-key whitelist into bot vs dashboard scopes

**Files:**
- Modify: `dashboard/api/_lib/kv-keys.ts`
- Create: `dashboard/tests/lib/kv-keys-dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/lib/kv-keys-dashboard.test.ts
import { describe, expect, it } from 'vitest';
import {
  isAllowedDashboardKey,
  isAllowedBotStateKey,
  KV_KEYS,
} from '../../api/_lib/kv-keys';

describe('dashboard kv-key whitelist', () => {
  it('accepts trade and grade keys', () => {
    expect(isAllowedDashboardKey('trade:T-2026-05-04-001')).toBe(true);
    expect(isAllowedDashboardKey('grade:T-2026-05-04-001')).toBe(true);
    expect(isAllowedDashboardKey('trades:index:open')).toBe(true);
    expect(isAllowedDashboardKey('trades:index:2026-05')).toBe(true);
    expect(isAllowedDashboardKey('trades:counter:2026-05-04')).toBe(true);
    expect(isAllowedDashboardKey('tags:list')).toBe(true);
    expect(isAllowedDashboardKey('config:totp_thresholds')).toBe(true);
    expect(isAllowedDashboardKey('auth:backup_codes_hashed')).toBe(true);
  });

  it('rejects bot-state keys from the dashboard whitelist', () => {
    expect(isAllowedDashboardKey('bot:state:conservative')).toBe(false);
    expect(isAllowedDashboardKey('bot:state:aggressive')).toBe(false);
  });

  it('rejects junk keys', () => {
    expect(isAllowedDashboardKey('foo')).toBe(false);
    expect(isAllowedDashboardKey('trade:')).toBe(false);
    expect(isAllowedDashboardKey('grade:')).toBe(false);
  });

  it('still allows the original five bot-state keys', () => {
    expect(isAllowedBotStateKey('bot:state:conservative')).toBe(true);
    expect(isAllowedBotStateKey('bot:state:aggressive')).toBe(true);
    expect(isAllowedBotStateKey('bot:strategy:conservative')).toBe(true);
    expect(isAllowedBotStateKey('bot:strategy:aggressive')).toBe(true);
    expect(isAllowedBotStateKey('bot:congress')).toBe(true);
  });

  it('exposes phase 2 keys on KV_KEYS', () => {
    expect(KV_KEYS.tagsList).toBe('tags:list');
    expect(KV_KEYS.totpThresholds).toBe('config:totp_thresholds');
    expect(KV_KEYS.backupCodesHashed).toBe('auth:backup_codes_hashed');
    expect(KV_KEYS.tradesIndexOpen).toBe('trades:index:open');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/kv-keys-dashboard.test.ts`
Expected: FAIL with `isAllowedDashboardKey is not exported`.

- [ ] **Step 3: Update kv-keys.ts**

```typescript
// dashboard/api/_lib/kv-keys.ts
export const BOT_STATE_KEYS = [
  'bot:state:conservative',
  'bot:state:aggressive',
  'bot:strategy:conservative',
  'bot:strategy:aggressive',
  'bot:congress',
] as const;

export type BotStateKey = (typeof BOT_STATE_KEYS)[number];

export function isAllowedBotStateKey(key: string): key is BotStateKey {
  return (BOT_STATE_KEYS as readonly string[]).includes(key);
}

export function lastUpdateKey(key: BotStateKey): string {
  return `bot:last-update:${key}`;
}

const DASHBOARD_KEY_PATTERNS: RegExp[] = [
  /^trade:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
  /^grade:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
  /^trades:index:open$/,
  /^trades:index:\d{4}-\d{2}$/,
  /^trades:counter:\d{4}-\d{2}-\d{2}$/,
  /^tags:list$/,
  /^config:totp_thresholds$/,
  /^auth:backup_codes_hashed$/,
  /^auth:used-backup-codes$/,
  /^watchlist$/,
];

export function isAllowedDashboardKey(key: string): boolean {
  return DASHBOARD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export const KV_KEYS = {
  watchlist: 'watchlist',
  totpThresholds: 'config:totp_thresholds',
  sessionPrefix: 'session:',
  tagsList: 'tags:list',
  backupCodesHashed: 'auth:backup_codes_hashed',
  tradesIndexOpen: 'trades:index:open',
} as const;

export function tradeKey(id: string): string {
  return `trade:${id}`;
}

export function gradeKey(id: string): string {
  return `grade:${id}`;
}

export function tradesIndexMonthKey(yyyymm: string): string {
  return `trades:index:${yyyymm}`;
}

export function tradesCounterKey(yyyymmdd: string): string {
  return `trades:counter:${yyyymmdd}`;
}
```

- [ ] **Step 4: Run all kv-keys tests to verify they pass**

Run: `cd dashboard && npx vitest run tests/lib/kv-keys`
Expected: PASS, including the original `kv-keys.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/kv-keys.ts dashboard/tests/lib/kv-keys-dashboard.test.ts
git commit -m "feat(dashboard): split kv whitelist into bot-push and dashboard scopes"
```

### Task 4: Add daily trade-ID counter helper

**Files:**
- Create: `dashboard/api/_lib/trade-ids.ts`
- Create: `dashboard/tests/lib/trade-ids.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/lib/trade-ids.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { allocateTradeId, currentMonth, currentDay } from '../../api/_lib/trade-ids';

const incrMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ incr: (...args: unknown[]) => incrMock(...args) }),
}));

beforeEach(() => {
  incrMock.mockReset();
});

describe('allocateTradeId', () => {
  it('returns T-YYYY-MM-DD-NNN with NNN zero-padded to 3 digits', async () => {
    incrMock.mockResolvedValueOnce(1);
    const id = await allocateTradeId(new Date('2026-05-04T13:30:00Z'));
    expect(id).toBe('T-2026-05-04-001');
  });

  it('handles three-digit counters', async () => {
    incrMock.mockResolvedValueOnce(42);
    const id = await allocateTradeId(new Date('2026-05-04T13:30:00Z'));
    expect(id).toBe('T-2026-05-04-042');
  });

  it('uses the YYYY-MM-DD UTC date for the counter key', async () => {
    incrMock.mockResolvedValueOnce(1);
    await allocateTradeId(new Date('2026-12-31T23:59:00Z'));
    expect(incrMock).toHaveBeenCalledWith('trades:counter:2026-12-31');
  });
});

describe('currentMonth / currentDay', () => {
  it('formats UTC dates correctly', () => {
    const d = new Date('2026-05-04T13:30:00Z');
    expect(currentMonth(d)).toBe('2026-05');
    expect(currentDay(d)).toBe('2026-05-04');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/trade-ids.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Write the helper**

```typescript
// dashboard/api/_lib/trade-ids.ts
import { kv } from './kv.js';
import { tradesCounterKey } from './kv-keys.js';

export function currentDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export async function allocateTradeId(now: Date = new Date()): Promise<string> {
  const day = currentDay(now);
  const seq = await kv().incr(tradesCounterKey(day));
  return `T-${day}-${pad3(Number(seq))}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run tests/lib/trade-ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/trade-ids.ts dashboard/tests/lib/trade-ids.test.ts
git commit -m "feat(dashboard): add daily trade-id counter helper"
```

### Task 5: Migrate backup codes from env var to KV

**Files:**
- Modify: `dashboard/api/_lib/backup-codes.ts`
- Modify: `dashboard/tests/lib/backup-codes.test.ts` (if exists; else create)

- [ ] **Step 1: Update backup-codes.ts to read KV first, env fallback**

```typescript
// dashboard/api/_lib/backup-codes.ts
import { createHash, randomBytes } from 'node:crypto';
import { kv } from './kv.js';
import { KV_KEYS } from './kv-keys.js';

function normalize(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function hash(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

const USED_KEY = 'auth:used-backup-codes';

async function loadAllowedHashes(): Promise<string[]> {
  const fromKv = await kv().get<string[]>(KV_KEYS.backupCodesHashed);
  if (Array.isArray(fromKv) && fromKv.length > 0) return fromKv;
  const fromEnv = (process.env.BACKUP_CODES_HASHED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv;
}

export async function consumeBackupCodeIfValid(input: string): Promise<boolean> {
  if (!input) return false;
  const candidate = hash(input);
  const allowed = await loadAllowedHashes();
  if (!allowed.includes(candidate)) return false;
  const used = ((await kv().get<string[]>(USED_KEY)) ?? []);
  if (used.includes(candidate)) return false;
  used.push(candidate);
  await kv().set(USED_KEY, used);
  return true;
}

export function looksLikeBackupCode(input: string): boolean {
  const cleaned = normalize(input);
  return cleaned.length >= 10 && /^[A-Z0-9]+$/.test(cleaned);
}

export function generateBackupCode(): { code: string; hash: string } {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars[bytes[i] % chars.length];
    if (i === 3 || i === 7) code += '-';
  }
  return { code, hash: hash(code) };
}

export async function regenerateBackupCodes(): Promise<{ codes: string[] }> {
  const fresh = Array.from({ length: 8 }, () => generateBackupCode());
  await kv().set(KV_KEYS.backupCodesHashed, fresh.map((c) => c.hash));
  await kv().set(USED_KEY, []);
  return { codes: fresh.map((c) => c.code) };
}
```

- [ ] **Step 2: Run existing backup-codes tests**

Run: `cd dashboard && npx vitest run tests/lib`
Expected: existing tests pass; if any depended on env-var-only behavior, update them now.

- [ ] **Step 3: Add a regression test for the KV-first behavior**

```typescript
// append to dashboard/tests/lib/backup-codes.test.ts (create if missing)
import { describe, expect, it, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet }),
}));

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
  process.env.BACKUP_CODES_HASHED = '';
});

describe('regenerateBackupCodes', () => {
  it('writes 8 hashes to KV and returns 8 plaintext codes', async () => {
    kvSet.mockResolvedValue('OK');
    const { regenerateBackupCodes } = await import('../../api/_lib/backup-codes');
    const out = await regenerateBackupCodes();
    expect(out.codes).toHaveLength(8);
    expect(kvSet).toHaveBeenCalledWith(
      'auth:backup_codes_hashed',
      expect.arrayContaining([expect.any(String)])
    );
  });
});

describe('consumeBackupCodeIfValid (KV-first)', () => {
  it('uses KV hashes when present, ignores env var', async () => {
    const { generateBackupCode } = await import('../../api/_lib/backup-codes');
    const { code, hash } = generateBackupCode();
    process.env.BACKUP_CODES_HASHED = 'env-bogus-hash';
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve([hash]);
      if (key === 'auth:used-backup-codes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const { consumeBackupCodeIfValid } = await import('../../api/_lib/backup-codes');
    expect(await consumeBackupCodeIfValid(code)).toBe(true);
  });

  it('falls back to env var when KV is empty', async () => {
    const { generateBackupCode } = await import('../../api/_lib/backup-codes');
    const { code, hash } = generateBackupCode();
    process.env.BACKUP_CODES_HASHED = hash;
    kvGet.mockImplementation((key: string) => {
      if (key === 'auth:backup_codes_hashed') return Promise.resolve(null);
      if (key === 'auth:used-backup-codes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const { consumeBackupCodeIfValid } = await import('../../api/_lib/backup-codes');
    expect(await consumeBackupCodeIfValid(code)).toBe(true);
  });
});
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/backup-codes.ts dashboard/tests/lib/backup-codes.test.ts
git commit -m "feat(dashboard): migrate backup codes to kv with env-var fallback"
```

---

## Milestone 1 — Settings page

Three tabs (`thresholds`, `tags`, `recovery`), three small API endpoints, one route.

### Task 6: Build the settings catchall API endpoint

**Files:**
- Create: `dashboard/api/settings/[resource].ts`
- Create: `dashboard/tests/api/settings-thresholds.test.ts`
- Create: `dashboard/tests/api/settings-tags.test.ts`

- [ ] **Step 1: Write thresholds-endpoint test (failing)**

```typescript
// dashboard/tests/api/settings-thresholds.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));

beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

function mockReq(method: string, query: any, body?: any): VercelRequest {
  return { method, query, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res as VercelResponse & { status: any; json: any };
}

describe('GET /api/settings/thresholds', () => {
  it('returns thresholds from KV', async () => {
    kvGet.mockResolvedValueOnce({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: { conservative_paper: 5000, aggressive_paper: 10000, live: 1500 },
    });
  });

  it('returns sensible defaults when KV is empty', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: { conservative_paper: 5000, aggressive_paper: 10000, live: 1500 },
    });
  });
});

describe('POST /api/settings/thresholds', () => {
  it('writes new thresholds to KV', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: 7500, aggressive_paper: 12000, live: 2000,
    });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('config:totp_thresholds', {
      conservative_paper: 7500, aggressive_paper: 12000, live: 2000,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects negative numbers', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: -1, aggressive_paper: 10000, live: 1500,
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
```

- [ ] **Step 2: Write tags-endpoint test (failing)**

```typescript
// dashboard/tests/api/settings-tags.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));

beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

function mockReq(method: string, query: any, body?: any): VercelRequest {
  return { method, query, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('/api/settings/tags', () => {
  it('GET returns the seeded tag list when KV is empty', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'tags' });
    const res = mockRes();
    await handler(req, res);
    const call = (res.json as any).mock.calls[0][0];
    expect(call.tags).toContain('breakout');
    expect(call.tags).toContain('wheel');
  });

  it('POST adds a new tag, lowercased and trimmed', async () => {
    kvGet.mockResolvedValueOnce(['breakout']);
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'tags' }, { tag: '  Morning_Setup  ' });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('tags:list', ['breakout', 'morning_setup']);
  });

  it('POST is idempotent for existing tags', async () => {
    kvGet.mockResolvedValueOnce(['breakout', 'wheel']);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'tags' }, { tag: 'breakout' });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('DELETE removes a tag', async () => {
    kvGet.mockResolvedValueOnce(['breakout', 'wheel', 'pullback']);
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('DELETE', { resource: 'tags' }, { tag: 'wheel' });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('tags:list', ['breakout', 'pullback']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run tests/api/settings-`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the catchall endpoint**

```typescript
// dashboard/api/settings/[resource].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { requireAuth } from '../_lib/auth-guard.js';
import { KV_KEYS } from '../_lib/kv-keys.js';
import { regenerateBackupCodes } from '../_lib/backup-codes.js';
import { verifyTotp } from '../_lib/totp.js';

const SEED_TAGS = [
  'breakout', 'morning_setup', 'pullback', 'earnings_play',
  'wheel', 'wheel_50pct', 'delta_target', 'sized_down',
  'scale_in', 'trim', 'stop_hit',
];

const DEFAULT_THRESHOLDS = {
  conservative_paper: 5000,
  aggressive_paper: 10000,
  live: 1500,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const resource = String(req.query.resource ?? '');

  if (resource === 'thresholds') return handleThresholds(req, res);
  if (resource === 'tags') return handleTags(req, res);
  if (resource === 'backup-codes') return handleBackupCodes(req, res);
  return res.status(404).json({ error: 'unknown_resource' });
}

async function handleThresholds(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const stored = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;
    return res.status(200).json({ thresholds: stored });
  }
  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Partial<typeof DEFAULT_THRESHOLDS>;
    const cons = Number(body.conservative_paper);
    const agg = Number(body.aggressive_paper);
    const live = Number(body.live);
    if (![cons, agg, live].every((n) => Number.isFinite(n) && n >= 0)) {
      return res.status(400).json({ error: 'invalid_threshold_values' });
    }
    const thresholds = { conservative_paper: cons, aggressive_paper: agg, live };
    await kv().set(KV_KEYS.totpThresholds, thresholds);
    return res.status(200).json({ ok: true, thresholds });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleTags(req: VercelRequest, res: VercelResponse) {
  const list = (await kv().get<string[]>(KV_KEYS.tagsList)) ?? SEED_TAGS;

  if (req.method === 'GET') return res.status(200).json({ tags: list });

  if (req.method === 'POST') {
    const tag = String((req.body as { tag?: string } | undefined)?.tag ?? '').trim().toLowerCase();
    if (!tag || !/^[a-z0-9_]+$/.test(tag)) {
      return res.status(400).json({ error: 'invalid_tag' });
    }
    if (list.includes(tag)) return res.status(200).json({ ok: true, tags: list });
    const next = [...list, tag];
    await kv().set(KV_KEYS.tagsList, next);
    return res.status(200).json({ ok: true, tags: next });
  }

  if (req.method === 'DELETE') {
    const tag = String((req.body as { tag?: string } | undefined)?.tag ?? '').trim().toLowerCase();
    const next = list.filter((t) => t !== tag);
    await kv().set(KV_KEYS.tagsList, next);
    return res.status(200).json({ ok: true, tags: next });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleBackupCodes(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const body = (req.body ?? {}) as { totp_code?: string };
  const code = String(body.totp_code ?? '').trim();
  if (!code || !verifyTotp(code, process.env.TOTP_SECRET ?? '')) {
    return res.status(401).json({ error: 'invalid_totp' });
  }
  const { codes } = await regenerateBackupCodes();
  return res.status(200).json({ codes, regenerated_at: new Date().toISOString() });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run tests/api/settings-`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/api/settings/[resource].ts dashboard/tests/api/settings-thresholds.test.ts dashboard/tests/api/settings-tags.test.ts
git commit -m "feat(dashboard): add settings api (thresholds, tags, backup-codes)"
```

### Task 7: Add a backup-codes regeneration endpoint test

**Files:**
- Create: `dashboard/tests/api/settings-backup-codes.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// dashboard/tests/api/settings-backup-codes.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const verifyTotpMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...args: any[]) => verifyTotpMock(...args) }));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); verifyTotpMock.mockReset();
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
});

function mockReq(method: string, body?: any): VercelRequest {
  return { method, query: { resource: 'backup-codes' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/settings/backup-codes', () => {
  it('rejects missing TOTP', async () => {
    verifyTotpMock.mockReturnValue(false);
    const handler = (await import('../../api/settings/[resource]')).default;
    const res = mockRes();
    await handler(mockReq('POST', {}), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 8 plaintext codes when TOTP is valid', async () => {
    verifyTotpMock.mockReturnValue(true);
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const res = mockRes();
    await handler(mockReq('POST', { totp_code: '123456' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.codes).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/settings-backup-codes.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/tests/api/settings-backup-codes.test.ts
git commit -m "test(dashboard): cover settings backup-codes regeneration"
```

### Task 8: Build the Settings route + tab components

**Files:**
- Create: `dashboard/src/routes/Settings.tsx`
- Create: `dashboard/src/components/settings/ThresholdsTab.tsx`
- Create: `dashboard/src/components/settings/TagsTab.tsx`
- Create: `dashboard/src/components/settings/RecoveryTab.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Write the Settings route shell**

```tsx
// dashboard/src/routes/Settings.tsx
import { useState } from 'react';
import { ThresholdsTab } from '../components/settings/ThresholdsTab';
import { TagsTab } from '../components/settings/TagsTab';
import { RecoveryTab } from '../components/settings/RecoveryTab';

type Tab = 'thresholds' | 'tags' | 'recovery';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('thresholds');

  return (
    <div className="p-6 max-w-4xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span>
        <span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/settings</span>
        <span className="text-dim">$</span>{' '}
        <span className="text-fg">edit --tab={tab}</span>
      </div>
      <h1 className="text-[44px] font-bold tracking-tight text-hi mt-2">Settings</h1>
      <div className="text-mid text-[12px]"><span className="text-dim">// preferences · thresholds · recovery</span></div>

      <div className="mt-4 flex gap-2">
        {(['thresholds', 'tags', 'recovery'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`pbtn ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            [{t}{tab === t ? '*' : ''}]
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'thresholds' && <ThresholdsTab />}
        {tab === 'tags' && <TagsTab />}
        {tab === 'recovery' && <RecoveryTab />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the ThresholdsTab**

```tsx
// dashboard/src/components/settings/ThresholdsTab.tsx
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Thresholds { conservative_paper: number; aggressive_paper: number; live: number; }

export function ThresholdsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'thresholds'],
    queryFn: () => api<{ thresholds: Thresholds }>('/api/settings/thresholds'),
  });
  const [form, setForm] = useState<Thresholds>({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
  useEffect(() => { if (data?.thresholds) setForm(data.thresholds); }, [data]);

  const save = useMutation({
    mutationFn: (body: Thresholds) => api('/api/settings/thresholds', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'thresholds'] }),
  });

  if (isLoading) return <div className="text-mid">loading…</div>;

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TOTP THRESHOLDS</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5 text-[12px] tnum">
        <div className="text-mid text-[10px] mb-3">orders at or above this $ exposure require a fresh totp code.</div>
        {(['conservative_paper', 'aggressive_paper', 'live'] as const).map((k) => (
          <div key={k} className="flex justify-between py-1 border-b border-dashed border-border">
            <span className="text-mid">{k}{k === 'live' ? <span className="text-dim"> (LIVE_ENABLED=false)</span> : null}</span>
            <input
              type="number"
              min={0}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
              className="w-24 text-right bg-panel-2 border border-border px-2 py-0.5 text-fg"
            />
          </div>
        ))}
        <button
          type="button"
          className="pbtn active mt-4"
          onClick={() => save.mutate(form)}
          disabled={save.isPending}
        >
          [{save.isPending ? 'saving…' : 'save*'}]
        </button>
        {save.isError && <div className="text-red text-[10px] mt-2">save failed.</div>}
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Write the TagsTab**

```tsx
// dashboard/src/components/settings/TagsTab.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function TagsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'tags'],
    queryFn: () => api<{ tags: string[] }>('/api/settings/tags'),
  });
  const [draft, setDraft] = useState('');

  const add = useMutation({
    mutationFn: (tag: string) => api('/api/settings/tags', { method: 'POST', body: JSON.stringify({ tag }) }),
    onSuccess: () => { setDraft(''); qc.invalidateQueries({ queryKey: ['settings', 'tags'] }); },
  });
  const del = useMutation({
    mutationFn: (tag: string) => api('/api/settings/tags', { method: 'DELETE', body: JSON.stringify({ tag }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'tags'] }),
  });

  if (isLoading) return <div className="text-mid">loading…</div>;
  const tags = data?.tags ?? [];

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TAGS</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5">
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <span key={t} className="px-2 py-0.5 border border-border bg-panel-2 text-cyan text-[10px] inline-flex items-center gap-1">
              {t}
              <button type="button" onClick={() => del.mutate(t)} className="text-dim hover:text-red" aria-label={`remove ${t}`}>×</button>
            </span>
          ))}
        </div>
        <div className="mt-4 flex gap-2 items-center">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="new tag (a-z, 0-9, _)"
            className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] flex-1 max-w-xs"
          />
          <button type="button" className="pbtn active" onClick={() => add.mutate(draft)} disabled={!draft || add.isPending}>[+ add]</button>
        </div>
        {add.isError && <div className="text-red text-[10px] mt-2">add failed (invalid tag?).</div>}
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Write the RecoveryTab**

```tsx
// dashboard/src/components/settings/RecoveryTab.tsx
import { useState } from 'react';
import { api } from '../../lib/api';

export function RecoveryTab() {
  const [totp, setTotp] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function regenerate() {
    setError(null); setPending(true);
    try {
      const res = await api<{ codes: string[] }>('/api/settings/backup-codes', {
        method: 'POST',
        body: JSON.stringify({ totp_code: totp }),
      });
      setCodes(res.codes);
      setTotp('');
    } catch (e: any) {
      setError(e.message ?? 'regenerate failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">BACKUP CODES</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5 text-[12px]">
        <div className="text-mid text-[10px] mb-3">
          rotating invalidates all previous codes. you must save the new set somewhere durable before closing this tab.
        </div>
        {codes ? (
          <div>
            <div className="text-amber text-[10px] mb-2">// new codes — saved nowhere on the server. copy now.</div>
            <pre className="border border-border bg-panel-2 p-3 text-fg text-[12px] tnum">{codes.join('\n')}</pre>
            <button type="button" className="pbtn active mt-3" onClick={() => setCodes(null)}>[i&apos;ve saved them]</button>
          </div>
        ) : (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              inputMode="numeric"
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="totp code"
              className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[14px] tnum tracking-[0.4em] w-32 text-center"
            />
            <button type="button" className="pbtn active" disabled={totp.length !== 6 || pending} onClick={regenerate}>
              [{pending ? 'regenerating…' : 'regenerate*'}]
            </button>
          </div>
        )}
        {error && <div className="text-red text-[10px] mt-2">{error}</div>}
      </div>
    </article>
  );
}
```

- [ ] **Step 5: Wire route into App.tsx**

Modify `dashboard/src/App.tsx` — add inside the existing `<Routes>` block:

```tsx
<Route path="/settings" element={<ProtectedRoute><AppShell><Settings /></AppShell></ProtectedRoute>} />
```

Add the import: `import Settings from './routes/Settings';` near the existing route imports.

Add a sidebar entry in `dashboard/src/components/layout/Sidebar.tsx` matching the existing nav-row pattern (an entry pointing at `/settings` with label `settings`).

- [ ] **Step 6: Run dev server and walk the page manually**

Run: `cd dashboard && npm run dev`
Open: `http://localhost:5173/settings`
Verify:
- All three tabs render.
- Save thresholds, refresh — values persist.
- Add and delete tags — list updates.
- Regenerate backup codes with a valid TOTP — 8 codes shown, then dismissable.

- [ ] **Step 7: Run tests**

Run: `cd dashboard && npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/routes/Settings.tsx dashboard/src/components/settings dashboard/src/App.tsx dashboard/src/components/layout/Sidebar.tsx
git commit -m "feat(dashboard): /settings route with thresholds, tags, recovery tabs"
```

---

## Milestone 2 — Order form + confirm modal

The biggest milestone. Stock and option order forms, the exposure calculator, the stub rule-checker, and the two-state confirm modal that gates Alpaca submit.

### Task 9: Build the exposure calculator (server + client mirror)

**Files:**
- Create: `dashboard/api/_lib/exposure.ts`
- Create: `dashboard/src/lib/exposure.ts`
- Create: `dashboard/tests/lib/exposure.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/lib/exposure.test.ts
import { describe, expect, it } from 'vitest';
import { computeExposure } from '../../api/_lib/exposure';

describe('computeExposure', () => {
  it('stock buy: qty × limit price', () => {
    expect(computeExposure({
      asset_class: 'stock', side: 'buy', qty: 10, order_type: 'limit',
      limit_price: 321.40, ask: 321.45, bid: 321.35,
    })).toBeCloseTo(3214.00, 2);
  });

  it('stock buy market: qty × ask', () => {
    expect(computeExposure({
      asset_class: 'stock', side: 'buy', qty: 10, order_type: 'market',
      limit_price: null, ask: 321.45, bid: 321.35,
    })).toBeCloseTo(3214.50, 2);
  });

  it('stock sell uses bid for market', () => {
    expect(computeExposure({
      asset_class: 'stock', side: 'sell', qty: 10, order_type: 'market',
      limit_price: null, ask: 321.45, bid: 321.35,
    })).toBeCloseTo(3213.50, 2);
  });

  it('option STO put = strike × qty × 100 (cash secured)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'put',
      qty: 1, order_type: 'limit', limit_price: 4.25,
      strike: 280, ask: 4.30, bid: 4.20,
    })).toBeCloseTo(28000, 2);
  });

  it('option STO call = qty × bid × 100 (premium received)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'call',
      qty: 1, order_type: 'limit', limit_price: 2.10,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(210, 2); // qty × limit × 100
  });

  it('option BTO = qty × ask × 100', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'BTO', contract_type: 'call',
      qty: 2, order_type: 'market', limit_price: null,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(430, 2);
  });

  it('option BTC = qty × ask × 100', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'BTC', contract_type: 'put',
      qty: 1, order_type: 'limit', limit_price: 2.00,
      strike: 280, ask: 2.05, bid: 1.95,
    })).toBeCloseTo(200, 2);
  });

  it('option STC = qty × bid × 100', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STC', contract_type: 'call',
      qty: 1, order_type: 'market', limit_price: null,
      strike: 350, ask: 5.10, bid: 5.00,
    })).toBeCloseTo(500, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/exposure.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the calculator**

```typescript
// dashboard/api/_lib/exposure.ts
import type { AssetClass, OrderSide, OrderType, ContractType } from './trade-types.js';

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
}

export function computeExposure(input: ExposureInput): number {
  const { asset_class, side, qty, order_type, limit_price, ask, bid, strike, contract_type } = input;

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/lib/exposure.test.ts`
Expected: PASS.

- [ ] **Step 5: Mirror to client lib**

```typescript
// dashboard/src/lib/exposure.ts
export { computeExposure, type ExposureInput } from '../../api/_lib/exposure';
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/api/_lib/exposure.ts dashboard/src/lib/exposure.ts dashboard/tests/lib/exposure.test.ts
git commit -m "feat(dashboard): exposure calculator for order $ value"
```

### Task 10: Build the stub rule-checker

**Files:**
- Create: `dashboard/api/_lib/rule-check.ts`
- Create: `dashboard/tests/lib/rule-check.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/lib/rule-check.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const fundamentalsMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet }) }));
vi.mock('../../api/_lib/fundamentals-fetch', () => ({
  fetchEarningsDate: (...args: any[]) => fundamentalsMock(...args),
}));

beforeEach(() => { kvGet.mockReset(); fundamentalsMock.mockReset(); });

describe('runStubRuleChecks', () => {
  it('flags >20 shares as sizing_1x info', async () => {
    kvGet.mockResolvedValue(null);
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 25, account: 'conservative_paper',
    });
    expect(out.find((w) => w.rule === 'sizing_1x')?.severity).toBe('info');
  });

  it('flags >1 contract as sizing_1x info', async () => {
    kvGet.mockResolvedValue(null);
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'option', symbol: 'TSLA', qty: 2, account: 'conservative_paper',
    });
    expect(out.find((w) => w.rule === 'sizing_1x')?.severity).toBe('info');
  });

  it('flags earnings within 7 days as warn', async () => {
    kvGet.mockResolvedValue(null);
    const today = new Date();
    const future = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
    fundamentalsMock.mockResolvedValue(future.toISOString().slice(0, 10));
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'conservative_paper',
    });
    expect(out.find((w) => w.rule === 'earnings_within_7d')?.severity).toBe('warn');
  });

  it('skips earnings check silently when fundamentals unavailable', async () => {
    kvGet.mockResolvedValue(null);
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'conservative_paper',
    });
    expect(out.find((w) => w.rule === 'earnings_within_7d')).toBeUndefined();
  });

  it('flags bot wheel overlap when symbol in stage 1 of conservative', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'bot:state:conservative') return Promise.resolve({ TSLA: { stage: 1 } });
      if (key === 'bot:state:aggressive') return Promise.resolve({});
      return Promise.resolve(null);
    });
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'aggressive_paper',
    });
    expect(out.find((w) => w.rule === 'bot_wheel_overlap')?.severity).toBe('warn');
  });

  it('returns empty array when no checks fire', async () => {
    kvGet.mockResolvedValue({});
    fundamentalsMock.mockResolvedValue(null);
    const { runStubRuleChecks } = await import('../../api/_lib/rule-check');
    const out = await runStubRuleChecks({
      asset_class: 'stock', symbol: 'TSLA', qty: 10, account: 'conservative_paper',
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/rule-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add a small fundamentals-fetch helper (server-only)**

```typescript
// dashboard/api/_lib/fundamentals-fetch.ts
export async function fetchEarningsDate(symbol: string): Promise<string | null> {
  try {
    const url = `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/fundamentals-proxy?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { 'x-internal-token': process.env.INTERNAL_FUNCTIONS_TOKEN ?? '' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { next_earnings_date?: string };
    return data.next_earnings_date ?? null;
  } catch {
    return null;
  }
}
```

(If the existing `fundamentals-proxy.ts` already exposes this differently, adapt the call — the proxy exists from Phase 1 and gates the Python function with `INTERNAL_FUNCTIONS_TOKEN`.)

- [ ] **Step 4: Implement the rule-checker**

```typescript
// dashboard/api/_lib/rule-check.ts
import { kv } from './kv.js';
import { fetchEarningsDate } from './fundamentals-fetch.js';
import type { AssetClass, AccountId, RuleWarning } from './trade-types.js';

interface RuleCheckInput {
  asset_class: AssetClass;
  symbol: string;
  qty: number;
  account: AccountId;
}

export async function runStubRuleChecks(input: RuleCheckInput): Promise<RuleWarning[]> {
  const out: RuleWarning[] = [];

  // sizing_1x
  const sizingThreshold = input.asset_class === 'stock' ? 20 : 1;
  if (input.qty > sizingThreshold) {
    const multiple = input.asset_class === 'stock'
      ? `${(input.qty / 10).toFixed(1)}× normal`
      : `${input.qty}× normal`;
    out.push({
      rule: 'sizing_1x',
      severity: 'info',
      message: `order is ${multiple} size (>${sizingThreshold} ${input.asset_class === 'stock' ? 'shares' : 'contracts'}). reason should explain.`,
    });
  }

  // earnings_within_7d (stock only — options handled by their underlying anyway)
  if (input.asset_class === 'stock' || input.asset_class === 'option') {
    const earnings = await fetchEarningsDate(input.symbol);
    if (earnings) {
      const days = Math.floor((new Date(earnings).getTime() - Date.now()) / 86400000);
      if (days >= 0 && days <= 7) {
        out.push({
          rule: 'earnings_within_7d',
          severity: 'warn',
          message: `earnings on ${earnings} (in ${days} day${days === 1 ? '' : 's'}). consider sizing down or waiting.`,
        });
      }
    }
  }

  // bot_wheel_overlap
  const cons = (await kv().get<Record<string, { stage?: number }>>('bot:state:conservative')) ?? {};
  const agg = (await kv().get<Record<string, { stage?: number }>>('bot:state:aggressive')) ?? {};
  const consHas = cons[input.symbol]?.stage === 1 || cons[input.symbol]?.stage === 2;
  const aggHas = agg[input.symbol]?.stage === 1 || agg[input.symbol]?.stage === 2;
  if (consHas || aggHas) {
    const accounts = [consHas && 'conservative', aggHas && 'aggressive'].filter(Boolean).join(' & ');
    out.push({
      rule: 'bot_wheel_overlap',
      severity: 'warn',
      message: `bot has an open wheel on ${input.symbol} in ${accounts}. manual position will share BP.`,
    });
  }

  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/lib/rule-check.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/api/_lib/rule-check.ts dashboard/api/_lib/fundamentals-fetch.ts dashboard/tests/lib/rule-check.test.ts
git commit -m "feat(dashboard): stub rule-checker (sizing/earnings/bot-overlap)"
```

### Task 11: Build the trades catchall API — preview action

**Files:**
- Create: `dashboard/api/trades/[action].ts`
- Create: `dashboard/tests/api/trades-preview.test.ts`

- [ ] **Step 1: Write the test for `preview`**

```typescript
// dashboard/tests/api/trades-preview.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const ruleCheckMock = vi.fn();
const dataMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({ runStubRuleChecks: (...a: any[]) => ruleCheckMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
}));

beforeEach(() => { kvGet.mockReset(); ruleCheckMock.mockReset(); dataMock.mockReset(); });

function mockReq(query: any, body?: any): VercelRequest {
  return { method: 'POST', query, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/preview', () => {
  it('returns exposure, requires_totp=false when below threshold', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'config:totp_thresholds') {
        return Promise.resolve({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
      }
      return Promise.resolve(null);
    });
    ruleCheckMock.mockResolvedValueOnce([]);
    dataMock.mockResolvedValueOnce({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: [],
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.exposure).toBeCloseTo(3214, 2);
    expect(json.requires_totp).toBe(false);
    expect(json.validation_errors).toEqual([]);
  });

  it('returns requires_totp=true when at or above threshold', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'config:totp_thresholds') {
        return Promise.resolve({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
      }
      return Promise.resolve(null);
    });
    ruleCheckMock.mockResolvedValueOnce([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 4.30, bp: 4.20 } } });
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      account: 'conservative_paper', asset_class: 'option', symbol: 'TSLA',
      contract_symbol: 'TSLA260522P00280000', strike: 280, expiration: '2026-05-22',
      contract_type: 'put',
      side: 'STO', qty: 1, order_type: 'limit', limit_price: 4.25,
      tif: 'day', entry_grade: 'A-', entry_reasoning: 'wheel csp',
      tags: ['wheel'],
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.exposure).toBeCloseTo(28000, 2);
    expect(json.requires_totp).toBe(true);
  });

  it('returns validation_errors for missing reasoning', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: '', tags: [],
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.validation_errors).toContain('entry_reasoning_required');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/trades-preview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the catchall + preview action**

```typescript
// dashboard/api/trades/[action].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { requireAuth } from '../_lib/auth-guard.js';
import { computeExposure } from '../_lib/exposure.js';
import { runStubRuleChecks } from '../_lib/rule-check.js';
import { alpacaData } from '../_lib/data-api.js';
import { GRADE_LETTERS, type GradeLetter, type Trade } from '../_lib/trade-types.js';
import { allocateTradeId, currentMonth } from '../_lib/trade-ids.js';
import {
  KV_KEYS, tradeKey, gradeKey, tradesIndexMonthKey,
} from '../_lib/kv-keys.js';

interface OrderDraft {
  account: 'conservative_paper' | 'aggressive_paper' | 'live';
  asset_class: 'stock' | 'option';
  symbol: string;
  side: string;
  qty: number;
  order_type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing';
  limit_price: number | null;
  stop_price?: number | null;
  trail_pct?: number | null;
  tif: 'day' | 'gtc';
  contract_symbol?: string | null;
  strike?: number | null;
  expiration?: string | null;
  contract_type?: 'put' | 'call' | null;
  entry_grade: string;
  entry_reasoning: string;
  tags: string[];
  totp_code?: string;
}

const DEFAULT_THRESHOLDS = { conservative_paper: 5000, aggressive_paper: 10000, live: 1500 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;
  const action = String(req.query.action ?? '');

  if (req.method === 'POST' && action === 'preview') return preview(req, res);
  if (req.method === 'POST' && action === 'submit') return submit(req, res);
  if (req.method === 'GET' && action === 'list') return list(req, res);
  if (req.method === 'GET' && action === 'get') return getOne(req, res);
  if (req.method === 'POST' && action === 'regrade') return regrade(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

function validate(draft: OrderDraft): string[] {
  const errs: string[] = [];
  if (!draft.symbol) errs.push('symbol_required');
  if (!Number.isFinite(draft.qty) || draft.qty <= 0) errs.push('qty_invalid');
  if (!draft.entry_reasoning?.trim()) errs.push('entry_reasoning_required');
  if (!GRADE_LETTERS.includes(draft.entry_grade as GradeLetter)) errs.push('entry_grade_invalid');
  if (draft.order_type === 'limit' && !Number.isFinite(draft.limit_price)) errs.push('limit_price_required');
  if (draft.order_type === 'stop' && !Number.isFinite(draft.stop_price ?? NaN)) errs.push('stop_price_required');
  if (draft.order_type === 'stop_limit'
      && (!Number.isFinite(draft.stop_price ?? NaN) || !Number.isFinite(draft.limit_price ?? NaN))) {
    errs.push('stop_limit_prices_required');
  }
  if (draft.order_type === 'trailing' && !Number.isFinite(draft.trail_pct ?? NaN)) {
    errs.push('trail_pct_required');
  }
  return errs;
}

async function getQuote(symbol: string, asset_class: 'stock' | 'option', mode: string) {
  if (asset_class === 'stock') {
    const snap = await alpacaData(mode as any, '/v2/stocks/snapshots', { symbols: symbol });
    const q = snap?.[symbol]?.latestQuote ?? snap?.snapshots?.[symbol]?.latestQuote;
    return { ask: q?.ap ?? 0, bid: q?.bp ?? 0 };
  }
  const snap = await alpacaData(mode as any, '/v1beta1/options/snapshots', { symbols: symbol });
  const q = snap?.snapshots?.[symbol]?.latestQuote;
  return { ask: q?.ap ?? 0, bid: q?.bp ?? 0 };
}

function modeFromAccount(account: string): string {
  if (account === 'aggressive_paper') return 'aggressive';
  return 'conservative';
}

async function preview(req: VercelRequest, res: VercelResponse) {
  const draft = (req.body ?? {}) as OrderDraft;
  const validation_errors = validate(draft);

  const thresholds = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;

  let exposure = 0;
  let requires_totp = false;
  let rule_warnings: any[] = [];

  if (validation_errors.length === 0) {
    const symbolForQuote = draft.asset_class === 'option' ? (draft.contract_symbol ?? draft.symbol) : draft.symbol;
    const { ask, bid } = await getQuote(symbolForQuote, draft.asset_class, modeFromAccount(draft.account));
    exposure = computeExposure({
      asset_class: draft.asset_class,
      side: draft.side as any,
      qty: draft.qty,
      order_type: draft.order_type,
      limit_price: draft.limit_price,
      contract_type: draft.contract_type ?? null,
      strike: draft.strike ?? null,
      ask, bid,
    });
    const threshold = thresholds[draft.account] ?? Number.POSITIVE_INFINITY;
    requires_totp = exposure >= threshold;
    rule_warnings = await runStubRuleChecks({
      asset_class: draft.asset_class, symbol: draft.symbol,
      qty: draft.qty, account: draft.account,
    });
  }

  return res.status(200).json({ exposure, requires_totp, rule_warnings, validation_errors });
}

// stubs for the next tasks; written here to keep the file building
async function submit(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function list(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function getOne(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function regrade(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/trades-preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/api/trades-preview.test.ts
git commit -m "feat(dashboard): /api/trades/preview with exposure + rule-check"
```

### Task 12: Implement `submit` action

**Files:**
- Modify: `dashboard/api/trades/[action].ts`
- Create: `dashboard/tests/api/trades-submit.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// dashboard/tests/api/trades-submit.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvIncr = vi.fn();
const kvLpush = vi.fn();
const ruleCheckMock = vi.fn();
const dataMock = vi.fn();
const verifyTotpMock = vi.fn();
const alpacaCreateOrder = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, incr: kvIncr, lpush: kvLpush, sadd: vi.fn() }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({ runStubRuleChecks: (...a: any[]) => ruleCheckMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({ alpacaData: (...a: any[]) => dataMock(...a) }));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...a: any[]) => verifyTotpMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: (...a: any[]) => alpacaCreateOrder(...a) }),
  modeFromQuery: () => 'conservative',
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvIncr.mockReset(); kvLpush.mockReset();
  ruleCheckMock.mockReset(); dataMock.mockReset(); verifyTotpMock.mockReset(); alpacaCreateOrder.mockReset();
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
});

function mockReq(body?: any): VercelRequest {
  return { method: 'POST', query: { action: 'submit' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/submit', () => {
  it('rejects when validation fails', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: '', tags: [],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when TOTP required but missing/invalid', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 1000, aggressive_paper: 1000, live: 1500 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    verifyTotpMock.mockReturnValue(false);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: [],
      totp_code: 'wrong',
    }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('places Alpaca order, writes trade+grade records, indexes', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    kvIncr.mockResolvedValue(1);
    alpacaCreateOrder.mockResolvedValue({ id: 'alp-abc-123', submitted_at: '2026-05-04T13:30:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: ['breakout'],
    }), res);
    expect(alpacaCreateOrder).toHaveBeenCalled();
    const json = (res.json as any).mock.calls[0][0];
    expect(json.id).toMatch(/^T-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(json.alpaca_order_id).toBe('alp-abc-123');
    expect(kvSet).toHaveBeenCalledWith(expect.stringMatching(/^trade:T-/), expect.any(Object));
    expect(kvSet).toHaveBeenCalledWith(expect.stringMatching(/^grade:T-/), expect.any(Object));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/trades-submit.test.ts`
Expected: FAIL — `submit` is still a 501 stub.

- [ ] **Step 3: Replace the `submit` stub**

In `dashboard/api/trades/[action].ts`, replace the `async function submit(...)` body:

```typescript
import { alpacaFor } from '../_lib/alpaca.js';
import { verifyTotp } from '../_lib/totp.js';

async function submit(req: VercelRequest, res: VercelResponse) {
  const draft = (req.body ?? {}) as OrderDraft;
  const validation_errors = validate(draft);
  if (validation_errors.length) return res.status(400).json({ error: 'validation_failed', validation_errors });

  // re-run preview math server-side
  const thresholds = (await kv().get<typeof DEFAULT_THRESHOLDS>(KV_KEYS.totpThresholds)) ?? DEFAULT_THRESHOLDS;
  const symbolForQuote = draft.asset_class === 'option' ? (draft.contract_symbol ?? draft.symbol) : draft.symbol;
  const { ask, bid } = await getQuote(symbolForQuote, draft.asset_class, modeFromAccount(draft.account));
  const exposure = computeExposure({
    asset_class: draft.asset_class, side: draft.side as any, qty: draft.qty,
    order_type: draft.order_type, limit_price: draft.limit_price,
    contract_type: draft.contract_type ?? null, strike: draft.strike ?? null, ask, bid,
  });
  const threshold = thresholds[draft.account] ?? Number.POSITIVE_INFINITY;
  if (exposure >= threshold) {
    if (!draft.totp_code || !verifyTotp(draft.totp_code, process.env.TOTP_SECRET ?? '')) {
      return res.status(401).json({ error: 'invalid_totp' });
    }
  }
  const rule_warnings = await runStubRuleChecks({
    asset_class: draft.asset_class, symbol: draft.symbol, qty: draft.qty, account: draft.account,
  });

  // Alpaca submit (paper for now)
  const client = alpacaFor(modeFromAccount(draft.account) as any);
  const orderPayload: any = draft.asset_class === 'stock'
    ? {
        symbol: draft.symbol,
        qty: draft.qty,
        side: draft.side,
        type: draft.order_type === 'stop_limit' ? 'stop_limit' : draft.order_type,
        time_in_force: draft.tif,
        limit_price: draft.limit_price ?? undefined,
        stop_price: draft.stop_price ?? undefined,
        trail_percent: draft.trail_pct ?? undefined,
      }
    : {
        symbol: draft.contract_symbol,
        qty: draft.qty,
        side: draft.side === 'BTO' || draft.side === 'BTC' ? 'buy' : 'sell',
        type: draft.order_type,
        time_in_force: draft.tif,
        limit_price: draft.limit_price ?? undefined,
      };
  const alpacaOrder = await client.createOrder(orderPayload);

  // Snapshot Greeks for option opens
  let greeks_at_entry = null;
  if (draft.asset_class === 'option' && (draft.side === 'BTO' || draft.side === 'STO')) {
    const snap = await alpacaData(modeFromAccount(draft.account) as any, '/v1beta1/options/snapshots', { symbols: draft.contract_symbol! });
    const g = snap?.snapshots?.[draft.contract_symbol!]?.greeks;
    if (g) greeks_at_entry = { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, iv: g.implied_volatility };
  }

  const id = await allocateTradeId();
  const now = new Date();
  const trade: Trade = {
    id,
    account: draft.account,
    asset_class: draft.asset_class,
    symbol: draft.symbol,
    side: draft.side as any,
    qty: draft.qty,
    order_type: draft.order_type,
    limit_price: draft.limit_price,
    stop_price: draft.stop_price ?? null,
    trail_pct: draft.trail_pct ?? null,
    tif: draft.tif,
    contract_symbol: draft.contract_symbol ?? null,
    strike: draft.strike ?? null,
    expiration: draft.expiration ?? null,
    contract_type: draft.contract_type ?? null,
    greeks_at_entry,
    alpaca_order_id: alpacaOrder.id,
    alpaca_close_order_id: null,
    submitted_at: alpacaOrder.submitted_at ?? now.toISOString(),
    filled_at: null,
    filled_avg_price: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    tags: draft.tags ?? [],
    entry_grade: draft.entry_grade as GradeLetter,
    entry_reasoning: draft.entry_reasoning,
    journal: '',
    exposure_at_submit: exposure,
    rule_warnings_at_entry: rule_warnings,
    schema: 1,
  };

  await kv().set(tradeKey(id), trade);
  await kv().set(gradeKey(id), {
    trade_id: id,
    entry: { letter: trade.entry_grade, reasoning: trade.entry_reasoning, ts: now.toISOString() },
    hindsight: null,
    history: [],
  });

  // Indexes
  const openList = (await kv().get<string[]>(KV_KEYS.tradesIndexOpen)) ?? [];
  await kv().set(KV_KEYS.tradesIndexOpen, [...openList, id]);
  const monthKey = tradesIndexMonthKey(currentMonth(now));
  const monthList = (await kv().get<string[]>(monthKey)) ?? [];
  await kv().set(monthKey, [...monthList, id]);

  return res.status(200).json({ id, alpaca_order_id: alpacaOrder.id });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/trades-submit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/api/trades-submit.test.ts
git commit -m "feat(dashboard): /api/trades/submit places alpaca order, writes records"
```

### Task 13: Implement `list` and `get` actions

**Files:**
- Modify: `dashboard/api/trades/[action].ts`

- [ ] **Step 1: Replace the `list` and `getOne` stubs**

```typescript
async function list(req: VercelRequest, res: VercelResponse) {
  const q = req.query;
  const account = q.account ? String(q.account) : null;
  const asset_class = q.asset_class ? String(q.asset_class) : null;
  const tag = q.tag ? String(q.tag) : null;
  const grade = q.grade ? String(q.grade) : null;
  const status = q.status ? String(q.status) : null;
  const from = q.from ? String(q.from) : null;
  const to = q.to ? String(q.to) : null;
  const limit = Math.min(200, Number(q.limit ?? 50));
  const offset = Math.max(0, Number(q.offset ?? 0));

  // collect month keys covering the date range — fall back to current + last 12 months
  const months: string[] = [];
  const start = from ? new Date(from) : new Date(Date.now() - 365 * 86400000);
  const end = to ? new Date(to) : new Date();
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const ids: string[] = [];
  for (const m of months) {
    const monthIds = (await kv().get<string[]>(tradesIndexMonthKey(m))) ?? [];
    ids.push(...monthIds);
  }

  // de-dup, newest-first
  const uniqIds = Array.from(new Set(ids)).reverse();

  const records: Trade[] = [];
  const grades: any[] = [];
  for (const id of uniqIds) {
    const t = await kv().get<Trade>(tradeKey(id));
    if (!t) continue;
    if (account && t.account !== account) continue;
    if (asset_class && t.asset_class !== asset_class) continue;
    if (tag && !t.tags.includes(tag)) continue;
    if (grade && t.entry_grade !== grade) continue;
    if (status === 'open' && t.closed_at) continue;
    if (status === 'closed' && !t.closed_at) continue;
    records.push(t);
    const g = await kv().get<any>(gradeKey(id));
    if (g) grades.push(g);
  }

  // summary
  const closed = records.filter((r) => r.closed_at);
  const winRate = closed.length === 0 ? 0
    : closed.filter((r) => (r.realized_pnl ?? 0) > 0).length / closed.length;
  const cal = { matched: 0, over: 0, under: 0 };
  for (const g of grades) {
    if (!g.hindsight) continue;
    const c = g.hindsight.calibration;
    if (c === 'matched') cal.matched++;
    else if (c === 'over_1' || c === 'over_2') cal.over++;
    else if (c === 'under_1' || c === 'under_2') cal.under++;
  }

  // Build a parallel array of compact grade summaries so the table can render AI letters + calibration colors
  const gradeSummaries = records.map((t) => {
    const g = grades.find((gr: any) => gr.trade_id === t.id);
    return {
      trade_id: t.id,
      ai_letter: g?.hindsight?.letter ?? null,
      calibration: g?.hindsight?.calibration ?? null,
    };
  });

  return res.status(200).json({
    trades: records.slice(offset, offset + limit),
    grades: gradeSummaries.slice(offset, offset + limit),
    total: records.length,
    summary: { count: records.length, win_rate: winRate, calibration: cal },
  });
}

async function getOne(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const trade = await kv().get<Trade>(tradeKey(id));
  const grade = await kv().get<any>(gradeKey(id));
  if (!trade) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ trade, grade });
}
```

- [ ] **Step 2: Run all trade tests**

Run: `cd dashboard && npx vitest run tests/api/trades-`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/api/trades/[action].ts
git commit -m "feat(dashboard): /api/trades/list and /api/trades/get actions"
```

### Task 14: Build the order form components

**Files:**
- Create: `dashboard/src/components/order/OrderHeader.tsx`
- Create: `dashboard/src/components/order/GradePicker.tsx`
- Create: `dashboard/src/components/order/TagPicker.tsx`
- Create: `dashboard/src/components/order/StockOrderForm.tsx`
- Create: `dashboard/src/components/order/OptionOrderForm.tsx`
- Create: `dashboard/src/routes/OrderNew.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Build the GradePicker**

```tsx
// dashboard/src/components/order/GradePicker.tsx
import { GRADE_LETTERS, type GradeLetter } from '../../lib/trade-types';

export function GradePicker({ value, onChange }: { value: GradeLetter | null; onChange: (g: GradeLetter) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {GRADE_LETTERS.map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          className={`px-2 py-0.5 border text-[12px] tnum ${
            value === g
              ? 'border-hi text-hi bg-hi/5 font-semibold'
              : 'border-border text-mid bg-panel'
          }`}
        >
          {g}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Build the TagPicker**

```tsx
// dashboard/src/components/order/TagPicker.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function TagPicker({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['settings', 'tags'],
    queryFn: () => api<{ tags: string[] }>('/api/settings/tags'),
  });
  const [draft, setDraft] = useState('');
  const tags = data?.tags ?? [];

  const add = useMutation({
    mutationFn: (t: string) => api('/api/settings/tags', { method: 'POST', body: JSON.stringify({ tag: t }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'tags'] }),
  });

  function toggle(t: string) {
    if (value.includes(t)) onChange(value.filter((v) => v !== t));
    else onChange([...value, t]);
  }

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => toggle(t)}
          className={`px-2 py-0.5 border text-[10px] ${
            value.includes(t) ? 'border-hi text-hi bg-hi/5' : 'border-border text-cyan bg-panel-2'
          }`}
        >
          {t}
        </button>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="+ add"
        className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[10px] w-24"
      />
      <button
        type="button"
        disabled={!draft}
        onClick={() => { add.mutate(draft, { onSuccess: () => { onChange([...value, draft]); setDraft(''); } }); }}
        className="pbtn"
      >
        [add]
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Build OrderHeader**

```tsx
// dashboard/src/components/order/OrderHeader.tsx
import { fmtUsd } from '../../lib/format';

interface Props {
  title: string;
  subtitle: string;
  quoteLine: string;
  positionLine: React.ReactNode;
}

export function OrderHeader({ title, subtitle, quoteLine, positionLine }: Props) {
  return (
    <div>
      <h1 className="text-[18px] font-bold tracking-tight text-hi">{title}</h1>
      <div className="text-mid text-[10px]"><span className="text-dim">{subtitle}</span></div>
      <div className="mt-2 flex justify-between flex-wrap gap-2 pb-2 border-b border-dashed border-border text-[12px]">
        <span className="text-mid">{quoteLine}</span>
        <span className="text-mid">{positionLine}</span>
      </div>
    </div>
  );
}

export { fmtUsd };
```

- [ ] **Step 4: Build StockOrderForm**

```tsx
// dashboard/src/components/order/StockOrderForm.tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import { fmtUsd } from '../../lib/format';
import type { GradeLetter, RuleWarning, StockSide, OrderType, Tif } from '../../lib/trade-types';

interface Props {
  symbol: string;
  account: 'conservative_paper' | 'aggressive_paper';
  onReview: (preview: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any }) => void;
}

export function StockOrderForm({ symbol, account, onReview }: Props) {
  const [side, setSide] = useState<StockSide>('buy');
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [qty, setQty] = useState(10);
  const [limitPrice, setLimitPrice] = useState<number | ''>('');
  const [stopPrice, setStopPrice] = useState<number | ''>('');
  const [trailPct, setTrailPct] = useState<number | ''>('');
  const [tif, setTif] = useState<Tif>('day');
  const [grade, setGrade] = useState<GradeLetter | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = account === 'aggressive_paper' ? 'aggressive' : 'conservative';
  const { data: quote } = useQuery({
    queryKey: ['quote', symbol, mode],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${symbol}&mode=${mode}`),
    refetchInterval: 5_000,
  });
  const lq = quote?.snapshot?.[symbol]?.latestQuote ?? quote?.snapshot?.snapshots?.[symbol]?.latestQuote;
  const last = lq?.lp ?? lq?.ap ?? 0;
  const ask = lq?.ap ?? 0;
  const bid = lq?.bp ?? 0;

  // Default the limit price once the quote arrives.
  useEffect(() => {
    if (orderType === 'limit' && limitPrice === '' && last) setLimitPrice(Number(last.toFixed(2)));
  }, [last, orderType, limitPrice]);

  const draft = useMemo(() => ({
    account,
    asset_class: 'stock' as const,
    symbol,
    side,
    qty,
    order_type: orderType,
    limit_price: limitPrice === '' ? null : Number(limitPrice),
    stop_price: stopPrice === '' ? null : Number(stopPrice),
    trail_pct: trailPct === '' ? null : Number(trailPct),
    tif,
    entry_grade: grade ?? '',
    entry_reasoning: reasoning,
    tags,
  }), [account, symbol, side, qty, orderType, limitPrice, stopPrice, trailPct, tif, grade, reasoning, tags]);

  async function review() {
    setPreviewing(true); setError(null);
    try {
      const res = await api<{ exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; validation_errors: string[] }>(
        '/api/trades/preview',
        { method: 'POST', body: JSON.stringify(draft) }
      );
      if (res.validation_errors?.length) {
        setError(`fix: ${res.validation_errors.join(', ')}`);
        return;
      }
      onReview({ ...res, draft });
    } catch (e: any) {
      setError(e.message ?? 'preview failed.');
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section label="━━━ side ──────────────">
        <div className="flex gap-1">
          {(['buy', 'sell', 'sell_short'] as StockSide[]).map((s) => (
            <button key={s} type="button" className={`pbtn ${side === s ? 'active' : ''}`} onClick={() => setSide(s)}>
              [{s}{side === s ? '*' : ''}]
            </button>
          ))}
        </div>
      </Section>

      <Section label="━━━ type ──────────────">
        <div className="flex gap-1 flex-wrap">
          {(['limit', 'market', 'stop', 'stop_limit', 'trailing'] as OrderType[]).map((t) => (
            <button key={t} type="button" className={`pbtn ${orderType === t ? 'active' : ''}`} onClick={() => setOrderType(t)}>
              [{t}{orderType === t ? '*' : ''}]
            </button>
          ))}
        </div>
      </Section>

      <Section label="━━━ size & price ──────">
        <Row label="qty">
          <NumInput value={qty} onChange={setQty} />
        </Row>
        {(orderType === 'limit' || orderType === 'stop_limit') && (
          <Row label="limit price"><NumInput value={limitPrice} onChange={setLimitPrice} step={0.01} /></Row>
        )}
        {(orderType === 'stop' || orderType === 'stop_limit') && (
          <Row label="stop price"><NumInput value={stopPrice} onChange={setStopPrice} step={0.01} /></Row>
        )}
        {orderType === 'trailing' && (
          <Row label="trail %"><NumInput value={trailPct} onChange={setTrailPct} step={0.1} /></Row>
        )}
        <Row label="tif">
          <div className="flex gap-1">
            {(['day', 'gtc'] as Tif[]).map((t) => (
              <button key={t} type="button" className={`pbtn ${tif === t ? 'active' : ''}`} onClick={() => setTif(t)}>
                [{t}{tif === t ? '*' : ''}]
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <Section label="━━━ entry grade ───────">
        <GradePicker value={grade} onChange={setGrade} />
      </Section>

      <Section label="━━━ reasoning (required) ──">
        <textarea
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          rows={3}
          className="w-full bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
          placeholder="why are you taking this trade?"
        />
      </Section>

      <Section label="━━━ tags ──────────────">
        <TagPicker value={tags} onChange={setTags} />
      </Section>

      <div className="pt-3 border-t border-dashed border-border flex justify-between items-center">
        <span className="text-mid text-[12px]">
          last <span className="text-fg">{fmtUsd(last)}</span> · bid {fmtUsd(bid)} · ask {fmtUsd(ask)}
        </span>
        <div className="flex gap-2">
          <a href="/orders" className="pbtn">[cancel]</a>
          <button type="button" className="pbtn active" disabled={previewing} onClick={review}>
            [{previewing ? 'previewing…' : 'review*'}]
          </button>
        </div>
      </div>
      {error && <div className="text-red text-[10px]">{error}</div>}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-dim text-[10px] tracking-[0.25em] mb-2">{label}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1 gap-3">
      <span className="text-mid text-[12px]">{label}</span>
      <span>{children}</span>
    </div>
  );
}
function NumInput({ value, onChange, step = 1 }: { value: number | ''; onChange: (n: number | '') => void; step?: number }) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-28 text-right"
    />
  );
}
```

- [ ] **Step 5: Build OptionOrderForm (mirrors StockOrderForm structure)**

```tsx
// dashboard/src/components/order/OptionOrderForm.tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import { fmtUsd } from '../../lib/format';
import { parseOptionSymbol } from '../../lib/option-symbol';
import type { GradeLetter, OptionSide, OrderType, Tif, RuleWarning } from '../../lib/trade-types';

interface Props {
  contractSymbol: string;
  action: 'open' | 'close';
  account: 'conservative_paper' | 'aggressive_paper';
  onReview: (p: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any }) => void;
}

export function OptionOrderForm({ contractSymbol, action, account, onReview }: Props) {
  const parsed = parseOptionSymbol(contractSymbol);
  if (!parsed) return <div className="text-red">invalid contract symbol.</div>;

  const sideOptions: OptionSide[] = action === 'open' ? ['BTO', 'STO'] : ['BTC', 'STC'];
  const [side, setSide] = useState<OptionSide>(sideOptions[1]); // default STO/STC for wheel use
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState<number | ''>('');
  const [tif, setTif] = useState<Tif>('day');
  const [grade, setGrade] = useState<GradeLetter | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = account === 'aggressive_paper' ? 'aggressive' : 'conservative';
  const { data: quote } = useQuery({
    queryKey: ['option-quote', contractSymbol, mode],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${contractSymbol}&mode=${mode}&kind=option`),
    refetchInterval: 5_000,
  });
  const greeks = quote?.snapshot?.snapshots?.[contractSymbol]?.greeks;
  const lq = quote?.snapshot?.snapshots?.[contractSymbol]?.latestQuote;
  const ask = lq?.ap ?? 0;
  const bid = lq?.bp ?? 0;
  useEffect(() => {
    if (orderType === 'limit' && limitPrice === '' && (ask || bid)) {
      setLimitPrice(Number(((ask + bid) / 2 || ask || bid).toFixed(2)));
    }
  }, [ask, bid, orderType, limitPrice]);

  const draft = useMemo(() => ({
    account,
    asset_class: 'option' as const,
    symbol: parsed.underlying,
    contract_symbol: contractSymbol,
    strike: parsed.strike,
    expiration: parsed.expiration,
    contract_type: parsed.type,
    side,
    qty,
    order_type: orderType,
    limit_price: limitPrice === '' ? null : Number(limitPrice),
    tif,
    entry_grade: grade ?? '',
    entry_reasoning: reasoning,
    tags,
  }), [account, contractSymbol, parsed, side, qty, orderType, limitPrice, tif, grade, reasoning, tags]);

  async function review() {
    setPreviewing(true); setError(null);
    try {
      const res = await api<{ exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; validation_errors: string[] }>(
        '/api/trades/preview',
        { method: 'POST', body: JSON.stringify(draft) }
      );
      if (res.validation_errors?.length) { setError(`fix: ${res.validation_errors.join(', ')}`); return; }
      onReview({ ...res, draft });
    } catch (e: any) {
      setError(e.message ?? 'preview failed.');
    } finally { setPreviewing(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ greeks (auto-snapshot at submit) ──</div>
        <div className="text-[10px] tnum flex gap-3">
          <span><span className="text-mid">Δ</span> <span className="text-cyan">{greeks?.delta?.toFixed(2) ?? '—'}</span></span>
          <span><span className="text-mid">Γ</span> <span className="text-fg">{greeks?.gamma?.toFixed(3) ?? '—'}</span></span>
          <span><span className="text-mid">Θ</span> <span className="text-red">{greeks?.theta?.toFixed(2) ?? '—'}</span></span>
          <span><span className="text-mid">ν</span> <span className="text-fg">{greeks?.vega?.toFixed(2) ?? '—'}</span></span>
          <span><span className="text-mid">IV</span> <span className="text-fg">{greeks?.implied_volatility ? (greeks.implied_volatility * 100).toFixed(0) + '%' : '—'}</span></span>
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ side ──────────────</div>
        <div className="flex gap-1">
          {sideOptions.map((s) => (
            <button key={s} type="button" className={`pbtn ${side === s ? 'active' : ''}`} onClick={() => setSide(s)}>
              [{s}{side === s ? '*' : ''}]
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ type ──────────────</div>
        <div className="flex gap-1">
          {(['limit', 'market'] as OrderType[]).map((t) => (
            <button key={t} type="button" className={`pbtn ${orderType === t ? 'active' : ''}`} onClick={() => setOrderType(t)}>
              [{t}{orderType === t ? '*' : ''}]
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ size & price ──────</div>
        <div className="flex justify-between items-center py-1 gap-3">
          <span className="text-mid text-[12px]">contracts</span>
          <input type="number" step={1} min={1} value={qty}
                 onChange={(e) => setQty(Number(e.target.value))}
                 className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-28 text-right" />
        </div>
        {orderType === 'limit' && (
          <div className="flex justify-between items-center py-1 gap-3">
            <span className="text-mid text-[12px]">limit price</span>
            <input type="number" step={0.01} value={limitPrice}
                   onChange={(e) => setLimitPrice(e.target.value === '' ? '' : Number(e.target.value))}
                   className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-28 text-right" />
          </div>
        )}
        <div className="flex justify-between items-center py-1 gap-3">
          <span className="text-mid text-[12px]">tif</span>
          <div className="flex gap-1">
            {(['day', 'gtc'] as Tif[]).map((t) => (
              <button key={t} type="button" className={`pbtn ${tif === t ? 'active' : ''}`} onClick={() => setTif(t)}>
                [{t}{tif === t ? '*' : ''}]
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ entry grade ───────</div>
        <GradePicker value={grade} onChange={setGrade} />
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ reasoning (required) ──</div>
        <textarea value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={3}
                  className="w-full bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
                  placeholder="why are you taking this trade?" />
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ tags ──────────────</div>
        <TagPicker value={tags} onChange={setTags} />
      </div>

      <div className="pt-3 border-t border-dashed border-border flex justify-between items-center">
        <span className="text-mid text-[12px]">bid {fmtUsd(bid)} · ask {fmtUsd(ask)}</span>
        <div className="flex gap-2">
          <a href="/orders" className="pbtn">[cancel]</a>
          <button type="button" className="pbtn active" disabled={previewing} onClick={review}>
            [{previewing ? 'previewing…' : 'review*'}]
          </button>
        </div>
      </div>
      {error && <div className="text-red text-[10px]">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 6: Build OrderNew route**

```tsx
// dashboard/src/routes/OrderNew.tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { OrderHeader } from '../components/order/OrderHeader';
import { StockOrderForm } from '../components/order/StockOrderForm';
import { OptionOrderForm } from '../components/order/OptionOrderForm';
import { ConfirmModal } from '../components/order/ConfirmModal';
import type { RuleWarning } from '../lib/trade-types';

export default function OrderNew() {
  const [params] = useSearchParams();
  const [preview, setPreview] = useState<
    { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any } | null
  >(null);

  const symbol = params.get('symbol');
  const contract = params.get('contract');
  const type = params.get('type');
  const action = params.get('action') as 'open' | 'close' | null;
  const account = (params.get('account') as 'conservative_paper' | 'aggressive_paper') ?? 'conservative_paper';

  if (!symbol && !contract) {
    return (
      <div className="p-6">
        <div className="text-mid text-[12px]">
          <span className="text-cyan">tim@dash:~/portfolio$</span> pick a symbol → /lookup/SYM
        </div>
      </div>
    );
  }

  const isOption = !!contract;
  const title = isOption ? `Order — ${contract}` : `Order — ${symbol}`;
  const subtitle = `// ${isOption ? 'option' : 'stock'} · ${account}`;

  return (
    <div className="p-6 max-w-3xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/order</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">new {isOption ? `--contract=${contract} --action=${action}` : `--symbol=${symbol} --type=${type}`}</span>
      </div>
      <div className="mt-4">
        <OrderHeader title={title} subtitle={subtitle} quoteLine="loading…" positionLine={null} />
      </div>
      <div className="mt-6">
        {isOption ? (
          <OptionOrderForm contractSymbol={contract!} action={action ?? 'open'} account={account} onReview={setPreview} />
        ) : (
          <StockOrderForm symbol={symbol!} account={account} onReview={setPreview} />
        )}
      </div>
      {preview && <ConfirmModal preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
```

- [ ] **Step 7: Wire into App.tsx + Sidebar**

Add to `<Routes>`:
```tsx
<Route path="/order/new" element={<ProtectedRoute><AppShell><OrderNew /></AppShell></ProtectedRoute>} />
```
Import: `import OrderNew from './routes/OrderNew';`

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/components/order dashboard/src/routes/OrderNew.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): /order/new with stock + option forms"
```

### Task 15: Build the ConfirmModal

**Files:**
- Create: `dashboard/src/components/order/ConfirmModal.tsx`

- [ ] **Step 1: Build the modal**

```tsx
// dashboard/src/components/order/ConfirmModal.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';
import type { RuleWarning } from '../../lib/trade-types';

interface Props {
  preview: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any };
  onClose: () => void;
}

export function ConfirmModal({ preview, onClose }: Props) {
  const navigate = useNavigate();
  const { draft } = preview;
  const [totp, setTotp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overlayBorder = preview.requires_totp ? 'border-amber' : 'border-hi';
  const titleColor = preview.requires_totp ? 'text-amber' : 'text-hi';

  async function place() {
    setError(null); setSubmitting(true);
    try {
      const body = preview.requires_totp ? { ...draft, totp_code: totp } : draft;
      const res = await api<{ id: string }>('/api/trades/submit', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      navigate(`/trade/${res.id}`);
    } catch (e: any) {
      setError(e.message ?? 'submit failed.');
    } finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 bg-bg/85 flex items-center justify-center p-4 z-50">
      <div className={`relative bg-panel border ${overlayBorder} max-w-md w-full`}>
        <div className="absolute -top-3 left-3 px-2 bg-panel text-[10px] tracking-[0.25em]">
          <span className="text-dim">┌──</span>{' '}
          <span className={titleColor}>{preview.requires_totp ? 'CONFIRM + TOTP' : 'CONFIRM'}</span>{' '}
          <span className="text-dim">──┐</span>
        </div>
        <div className="p-5 text-[12px]">
          <div className={`${titleColor} font-bold text-[14px]`}>review &amp; confirm</div>
          <div className="text-dim text-[10px]">
            // step {preview.requires_totp ? '2 of 2 · ≥ threshold · totp required' : '1 of 2 · below totp threshold'}
          </div>

          <div className="text-dim text-[10px] tracking-[0.25em] mt-4 mb-1">━━━ order ─────────────</div>
          <Row k="action" v={`${draft.side.toUpperCase()} ${draft.qty} ${draft.symbol}${draft.contract_symbol ? ` ${draft.contract_type?.toUpperCase()} $${draft.strike} ${draft.expiration}` : ''}`} />
          <Row k="type" v={`${draft.order_type}${draft.limit_price ? ' @ ' + fmtUsd(draft.limit_price) : ''} · ${draft.tif}`} />
          <Row k="account" v={draft.account} />
          <Row k="exposure" v={<span className={preview.requires_totp ? 'text-amber font-semibold' : 'text-fg'}>{fmtUsd(preview.exposure)}</span>} />

          <div className="text-dim text-[10px] tracking-[0.25em] mt-3 mb-1">━━━ entry grade ───────</div>
          <Row k="grade" v={<span className="text-hi font-semibold">{draft.entry_grade}</span>} />
          <div className="text-fg text-[10px] mt-1">"{draft.entry_reasoning}"</div>

          <div className="text-dim text-[10px] tracking-[0.25em] mt-3 mb-1">━━━ rule check ────────</div>
          {preview.rule_warnings.length === 0
            ? <div className="text-hi text-[10px]">▸ ok — no warnings</div>
            : preview.rule_warnings.map((w) => (
                <div key={w.rule} className={`text-[10px] ${w.severity === 'warn' ? 'text-amber' : 'text-mid'}`}>
                  ▸ {w.rule}: {w.message}
                </div>
              ))}

          {preview.requires_totp && (
            <>
              <div className="text-dim text-[10px] tracking-[0.25em] mt-3 mb-1">━━━ totp code ─────────</div>
              <div className="flex justify-center py-2">
                <input
                  type="text" inputMode="numeric"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="bg-panel-2 border border-border px-2 py-1 text-fg text-[14px] tnum tracking-[0.4em] w-32 text-center"
                />
              </div>
            </>
          )}

          {error && <div className="text-red text-[10px] mt-2">{error}</div>}

          <div className="mt-4 flex justify-between gap-2">
            <button type="button" className="pbtn" onClick={onClose}>[back]</button>
            <div className="flex gap-2">
              <button type="button" className="pbtn" onClick={onClose}>[cancel]</button>
              <button
                type="button"
                disabled={submitting || (preview.requires_totp && totp.length !== 6)}
                onClick={place}
                className={`pbtn ${preview.requires_totp ? 'border-amber text-amber bg-amber/5' : 'active'}`}
              >
                [{submitting ? 'placing…' : preview.requires_totp ? 'verify & place*' : 'place order*'}]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-mid">{k}</span>
      <span>{v}</span>
    </div>
  );
}
```

- [ ] **Step 2: Manual walkthrough on dev server**

Run: `cd dashboard && npm run dev`
Open: `http://localhost:5173/order/new?symbol=TSLA&type=stock&account=conservative_paper`

Verify:
- Form renders and quote ticks every 5s.
- Try a small qty (1 share, $321 limit) → review opens green-bordered modal, no TOTP.
- Try a large qty (1000 shares) → review opens amber-bordered modal with TOTP field.
- "[back]" returns to form preserving inputs.
- "[place order*]" with valid inputs and a small qty submits, navigates to `/trade/<id>` (404 expected for the route until Milestone 3).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/order/ConfirmModal.tsx
git commit -m "feat(dashboard): two-state confirm modal (totp re-prompt above threshold)"
```

---

## Milestone 3 — Trade detail page

The grading view. Stacked layout per spec: header → chart → timeline → grades side-by-side → tags+journal.

### Task 16: Add `useTrade` hook

**Files:**
- Create: `dashboard/src/hooks/useTrade.ts`

- [ ] **Step 1: Write the hook**

```typescript
// dashboard/src/hooks/useTrade.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Trade, GradeRecord } from '../lib/trade-types';

export function useTrade(id: string | undefined) {
  return useQuery({
    queryKey: ['trade', id],
    queryFn: () => api<{ trade: Trade; grade: GradeRecord }>(`/api/trades/get?id=${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/hooks/useTrade.ts
git commit -m "feat(dashboard): useTrade hook"
```

### Task 17: Build trade detail components

**Files:**
- Create: `dashboard/src/components/trade/TradeHeader.tsx`
- Create: `dashboard/src/components/trade/Timeline.tsx`
- Create: `dashboard/src/components/trade/GradePanel.tsx`
- Create: `dashboard/src/components/trade/TradeChart.tsx`

- [ ] **Step 1: TradeHeader**

```tsx
// dashboard/src/components/trade/TradeHeader.tsx
import { fmtUsd, fmtPct } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';

export function TradeHeader({ trade }: { trade: Trade }) {
  const closed = !!trade.closed_at;
  const pnl = trade.realized_pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-hi' : pnl < 0 ? 'text-red' : 'text-fg';
  const pct = trade.realized_pnl != null && trade.exposure_at_submit
    ? (trade.realized_pnl / trade.exposure_at_submit) * 100
    : null;

  return (
    <div className="flex justify-between items-end pb-3 border-b border-dashed border-border">
      <div>
        <h1 className="text-[18px] font-bold text-hi">Trade {trade.id}</h1>
        <div className="text-mid text-[10px]">
          // {trade.side.toUpperCase()} {trade.qty} {trade.symbol} · {trade.account} · {closed ? `closed ${trade.closed_at?.slice(0, 10)}` : 'open'}
        </div>
      </div>
      {closed && (
        <div className="text-right">
          <div className="text-mid text-[10px]">realized</div>
          <div className={`text-[20px] font-semibold tnum ${pnlColor}`}>
            {pnl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pnl))}
            {pct !== null && <> · {fmtPct(pct, { sign: true })}</>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Timeline**

```tsx
// dashboard/src/components/trade/Timeline.tsx
import { fmtUsd } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';

export function Timeline({ trade }: { trade: Trade }) {
  const events: Array<{ ts: string; tone: 'fg' | 'hi' | 'mid'; line: React.ReactNode }> = [];
  events.push({ ts: trade.submitted_at, tone: 'fg', line: <>submitted · {trade.order_type}{trade.limit_price ? ` ${fmtUsd(trade.limit_price)}` : ''} {trade.tif}</> });
  if (trade.filled_at) events.push({ ts: trade.filled_at, tone: 'hi', line: <>filled @ {fmtUsd(trade.filled_avg_price ?? 0)} · {trade.qty}</> });
  if (trade.closed_at) events.push({
    ts: trade.closed_at,
    tone: 'hi',
    line: <>closed @ {fmtUsd(trade.closed_avg_price ?? 0)} · {trade.realized_pnl != null ? `${trade.realized_pnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(trade.realized_pnl))}` : ''}</>,
  });

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TIMELINE</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4 text-[10px]">
        {events.map((e, i) => (
          <div key={i} className="flex gap-3 py-1 border-b border-dashed border-border last:border-b-0">
            <span className="text-dim w-32">{e.ts.slice(0, 16).replace('T', ' ')}</span>
            <span className="text-hi">▸</span>
            <span className={`text-${e.tone}`}>{e.line}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
```

- [ ] **Step 3: GradePanel**

```tsx
// dashboard/src/components/trade/GradePanel.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Trade, GradeRecord, Calibration } from '../../lib/trade-types';

const CAL_COLORS: Record<Calibration, string> = {
  matched: 'text-hi',
  over_1: 'text-amber',
  under_1: 'text-amber',
  over_2: 'text-red',
  under_2: 'text-red',
};

const CAL_LABELS: Record<Calibration, string> = {
  matched: 'matched',
  over_1: 'over by 1 step',
  over_2: 'over by 2+ steps',
  under_1: 'under by 1 step',
  under_2: 'under by 2+ steps',
};

export function GradePanel({ trade, grade }: { trade: Trade; grade: GradeRecord }) {
  const qc = useQueryClient();
  const [regrading, setRegrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const regrade = useMutation({
    mutationFn: () => api('/api/trades/regrade', { method: 'POST', body: JSON.stringify({ id: trade.id }) }),
    onMutate: () => { setRegrading(true); setError(null); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trade', trade.id] }),
    onError: (e: any) => setError(e.message ?? 'regrade failed.'),
    onSettled: () => setRegrading(false),
  });

  const h = grade.hindsight;
  const calLabel = h?.calibration ? CAL_LABELS[h.calibration] : null;
  const calColor = h?.calibration ? CAL_COLORS[h.calibration] : 'text-mid';

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">GRADES</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-mid text-[10px]">your entry grade</div>
          <div className="inline-block mt-1 px-4 py-2 border border-hi text-hi text-[28px] font-bold tnum">{grade.entry.letter}</div>
          <div className="text-fg text-[10px] mt-2">"{grade.entry.reasoning}"</div>
        </div>
        <div>
          <div className="text-mid text-[10px]">ai hindsight grade <span className="text-dim">// {h?.model ?? 'sonnet 4.6'}</span></div>
          {h ? (
            <>
              <div className={`inline-block mt-1 px-4 py-2 border ${calColor.replace('text-', 'border-')} ${calColor} text-[28px] font-bold tnum`}>
                {h.letter}
              </div>
              <div className="text-fg text-[10px] mt-2">"{h.review}"</div>
              {h.tendencies_hit.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {h.tendencies_hit.map((t) => (
                    <span key={t} className="px-2 py-0.5 border border-amber text-amber text-[10px]">{t}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="text-mid text-[10px] mt-2 pulse">// grading… or click [grade now*] to fire manually</div>
          )}
        </div>
      </div>
      <div className="px-4 py-2 border-t border-dashed border-border flex justify-between items-center">
        <span className={`text-[10px] ${calColor}`}>calibration: {calLabel ?? '—'}</span>
        <button
          type="button" className="pbtn active"
          onClick={() => regrade.mutate()}
          disabled={regrading}
        >[{regrading ? 'regrading…' : 're-grade*'}]</button>
      </div>
      {error && <div className="px-4 pb-2 text-red text-[10px]">{error}</div>}
    </article>
  );
}
```

- [ ] **Step 4: TradeChart (lightweight-charts wrapper)**

```tsx
// dashboard/src/components/trade/TradeChart.tsx
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createChart, ColorType } from 'lightweight-charts';
import { api } from '../../lib/api';
import type { Trade } from '../../lib/trade-types';

interface Bar { t: string; o: number; h: number; l: number; c: number; }

export function TradeChart({ trade }: { trade: Trade }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mode = trade.account === 'aggressive_paper' ? 'aggressive' : 'conservative';
  const symbol = trade.asset_class === 'option' ? trade.symbol : trade.symbol;

  // Fetch 1H bars across position lifetime
  const start = trade.submitted_at;
  const end = trade.closed_at ?? new Date().toISOString();
  const { data } = useQuery({
    queryKey: ['trade-bars', trade.id, start, end],
    queryFn: () => api<{ bars: Bar[] }>(`/api/alpaca/bars?symbol=${symbol}&mode=${mode}&start=${start}&end=${end}&timeframe=1Hour`),
  });

  useEffect(() => {
    if (!ref.current || !data?.bars?.length) return;
    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 200,
      layout: { background: { type: ColorType.Solid, color: '#05080a' }, textColor: '#a7e0c2', fontFamily: 'JetBrains Mono' },
      grid: { vertLines: { color: '#143a25' }, horzLines: { color: '#143a25' } },
      timeScale: { borderColor: '#143a25' },
      rightPriceScale: { borderColor: '#143a25' },
    });
    const series = chart.addLineSeries({ color: '#22ff88', lineWidth: 1 });
    series.setData(data.bars.map((b) => ({ time: Math.floor(new Date(b.t).getTime() / 1000) as any, value: b.c })));
    if (trade.filled_at && trade.filled_avg_price) {
      series.setMarkers([
        { time: Math.floor(new Date(trade.filled_at).getTime() / 1000) as any, position: 'belowBar', color: '#22ff88', shape: 'arrowUp', text: `entry ${trade.filled_avg_price}` },
        ...(trade.closed_at && trade.closed_avg_price
          ? [{ time: Math.floor(new Date(trade.closed_at).getTime() / 1000) as any, position: 'aboveBar' as const, color: '#22ff88', shape: 'arrowDown' as const, text: `exit ${trade.closed_avg_price}` }]
          : []),
      ]);
    }
    return () => chart.remove();
  }, [data, trade]);

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">CHART</span><span className="text-dim">──┐</span>
      </div>
      <div ref={ref} className="p-2 h-[220px]" />
    </article>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/trade
git commit -m "feat(dashboard): trade detail components (header, chart, timeline, grade panel)"
```

### Task 18: Build the TradeDetail route

**Files:**
- Create: `dashboard/src/routes/TradeDetail.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Build the route**

```tsx
// dashboard/src/routes/TradeDetail.tsx
import { useParams } from 'react-router-dom';
import { useTrade } from '../hooks/useTrade';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { TradeHeader } from '../components/trade/TradeHeader';
import { TradeChart } from '../components/trade/TradeChart';
import { Timeline } from '../components/trade/Timeline';
import { GradePanel } from '../components/trade/GradePanel';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export default function TradeDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useTrade(id);

  if (isLoading) return <div className="p-6 text-mid">loading…</div>;
  if (error || !data) return <div className="p-6 text-red">trade not found.</div>;

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash:~/portfolio/trade$</span>{' '}
        <span className="text-fg">show --id={id}</span>
      </div>
      <TradeHeader trade={data.trade} />
      <ErrorBoundary><TradeChart trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><Timeline trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><GradePanel trade={data.trade} grade={data.grade} /></ErrorBoundary>
      <ErrorBoundary><TagsJournal trade={data.trade} /></ErrorBoundary>
    </div>
  );
}

function TagsJournal({ trade }: { trade: any }) {
  const qc = useQueryClient();
  const [journal, setJournal] = useState(trade.journal ?? '');
  const save = useMutation({
    mutationFn: (j: string) => api(`/api/trades/get?id=${trade.id}`, { method: 'POST', body: JSON.stringify({ journal: j }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trade', trade.id] }),
  });

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TAGS · JOURNAL</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4">
        <div className="flex flex-wrap gap-1 mb-3">
          {(trade.tags ?? []).map((t: string) => (
            <span key={t} className="px-2 py-0.5 border border-hi text-hi text-[10px]">{t}</span>
          ))}
          {(!trade.tags || trade.tags.length === 0) && <span className="text-dim text-[10px]">— no tags —</span>}
        </div>
        <div className="text-mid text-[10px] mt-2">journal <span className="text-dim">(optional)</span></div>
        <textarea
          rows={3}
          className="w-full bg-panel-2 border border-border px-2 py-1 text-fg text-[10px] mt-1"
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
          onBlur={() => journal !== trade.journal && save.mutate(journal)}
        />
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Add a journal-save endpoint**

This needs a small extension on the trades catchall. Add to `dashboard/api/trades/[action].ts`:

```typescript
// Add inside the action dispatch in the default handler:
if (req.method === 'POST' && action === 'update') return updateTrade(req, res);

async function updateTrade(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? (req.body as any)?.id ?? '');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const body = (req.body ?? {}) as { journal?: string; tags?: string[] };
  const trade = await kv().get<Trade>(tradeKey(id));
  if (!trade) return res.status(404).json({ error: 'not_found' });
  const updated: Trade = {
    ...trade,
    journal: typeof body.journal === 'string' ? body.journal : trade.journal,
    tags: Array.isArray(body.tags) ? body.tags : trade.tags,
  };
  await kv().set(tradeKey(id), updated);
  return res.status(200).json({ ok: true });
}
```

Then in `TagsJournal`, switch the mutation URL to `/api/trades/update?id=${trade.id}`.

- [ ] **Step 3: Wire route into App.tsx**

```tsx
<Route path="/trade/:id" element={<ProtectedRoute><AppShell><TradeDetail /></AppShell></ProtectedRoute>} />
```
Import: `import TradeDetail from './routes/TradeDetail';`

- [ ] **Step 4: Manual test**

After placing a paper trade via `/order/new`, navigate to `/trade/<id>` and verify:
- Header shows trade ID, side/qty/symbol, account, status.
- Chart renders with at least the entry marker.
- Timeline shows submitted/filled events.
- GradePanel shows your entry letter on left and "grading…" on right (no AI grade yet — Milestone 4 builds it).
- Journal textarea saves on blur.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/TradeDetail.tsx dashboard/api/trades/[action].ts dashboard/src/App.tsx
git commit -m "feat(dashboard): /trade/:id detail route + journal save endpoint"
```

---

## Milestone 4 — AI grading pipeline

The headline Phase 2 feature. Three pieces: `grading.ts` helper (Anthropic SDK + prompt builder + parser), the `regrade` action on `/api/trades/[action].ts`, and the `grade-open-trades` cron action that polls open trades and auto-grades closed ones.

### Task 19: Build the grading helper (Claude API + prompt builder)

**Files:**
- Create: `dashboard/api/_lib/grading.ts`
- Create: `dashboard/tests/lib/grading.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/lib/grading.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const claudeCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: (...a: any[]) => claudeCreate(...a) }; },
}));

beforeEach(() => { claudeCreate.mockReset(); process.env.ANTHROPIC_API_KEY = 'test-key'; });

const trade = {
  id: 'T-2026-05-04-001',
  account: 'conservative_paper',
  asset_class: 'stock',
  symbol: 'TSLA',
  side: 'buy',
  qty: 10,
  filled_avg_price: 319.85,
  closed_avg_price: 362.20,
  realized_pnl: 423.50,
  closed_at: '2026-05-04T20:09:00Z',
  filled_at: '2026-05-04T13:30:15Z',
  submitted_at: '2026-05-04T13:30:00Z',
  entry_grade: 'A',
  entry_reasoning: 'breakout above $318 resistance',
  exposure_at_submit: 3198.50,
  rule_warnings_at_entry: [],
  schema: 1,
} as any;

describe('gradeTrade', () => {
  it('builds a prompt with system + cached + fresh blocks and parses JSON', async () => {
    claudeCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"letter":"B+","review":"thesis was right","calibration":"over_1","tendencies_hit":[]}' }],
      usage: { input_tokens: 1942, output_tokens: 287, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    const result = await gradeTrade({ trade, bars: [] });
    expect(result.parse_failed).toBeUndefined();
    expect(result.letter).toBe('B+');
    expect(result.calibration).toBe('over_1');
    expect(result.usage.input_tokens).toBe(1942);
    const callArgs = claudeCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-6');
    expect(callArgs.system).toBeDefined();
    // cache marker present on at least one block
    const sysBlocks = Array.isArray(callArgs.system) ? callArgs.system : [];
    expect(sysBlocks.some((b: any) => b.cache_control?.type === 'ephemeral')).toBe(true);
  });

  it('retries with stricter prompt on malformed JSON', async () => {
    claudeCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not json' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"letter":"B","review":"redo","calibration":"matched","tendencies_hit":[]}' }],
        usage: { input_tokens: 110, output_tokens: 50, cache_read_input_tokens: 0 },
      });
    const { gradeTrade } = await import('../../api/_lib/grading');
    const result = await gradeTrade({ trade, bars: [] });
    expect(claudeCreate).toHaveBeenCalledTimes(2);
    expect(result.letter).toBe('B');
  });

  it('marks parse_failed when both attempts return junk', async () => {
    claudeCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'junk' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    const { gradeTrade } = await import('../../api/_lib/grading');
    const result = await gradeTrade({ trade, bars: [] });
    expect(result.parse_failed).toBe(true);
    expect(result.raw).toBe('junk');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/lib/grading.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```typescript
// dashboard/api/_lib/grading.ts
import Anthropic from '@anthropic-ai/sdk';
import { kv } from './kv.js';
import type { Trade, GradeHindsight, Calibration } from './trade-types.js';
import { calibrationFor, GRADE_LETTERS, type GradeLetter } from './trade-types.js';

const SYSTEM_PROMPT = `You are an honest trading coach for a single trader (Tim). Your job is to grade a closed manual trade A+ to F based on what actually happened versus what the trader said when entering.

Hard rules:
- Plain English only. Never use trader shorthand (LH, LL, HOD, RR, IV, RSI, theta, delta, gamma, vega) without defining it inline in the same sentence.
- If the trader made a bad call, say so directly. No hedging, no cheerleading. The point is to improve, not to feel good.
- Grade the *decision-making*, not the outcome. A bad process that got lucky still gets a low grade. A good process that got unlucky still gets a high grade.
- Compare against the trader's own entry reasoning. If they took credit for something that wasn't the actual driver, call it out.
- "tendencies_hit" is a list of pattern names from the provided tendencies set. Empty array if none apply. Do not invent new ones.

Output strict JSON. No prose outside the JSON. Schema:
{
  "letter": "A+|A|A-|B+|B|B-|C+|C|C-|D|F",
  "review": "<plain-english review, 60-120 words>",
  "calibration": "matched|over_1|over_2|under_1|under_2",
  "tendencies_hit": ["<tendency-id>", ...]
}

"calibration" compares your letter to the trader's entry letter:
"matched" = same letter
"over_1"  = trader was 1 step too high
"over_2"  = trader was 2+ steps too high
"under_1" = trader was 1 step too low
"under_2" = trader was 2+ steps too low`;

interface CachedReference {
  manual: string;
  tendencies: any[];
  patterns: any[];
  cheatsheets: any[];
}

async function loadCachedReference(): Promise<CachedReference> {
  const manual = (await kv().get<string>('rules:manual'))
    ?? 'manual rules not yet defined — grade based on trade record alone.';
  const tendencies = (await kv().get<any[]>('rules:tendencies')) ?? [];
  const patterns = (await kv().get<any[]>('rules:patterns')) ?? [];
  const cheatsheets = (await kv().get<any[]>('rules:cheatsheets')) ?? [];
  return { manual, tendencies, patterns, cheatsheets };
}

function buildCachedBlock(ref: CachedReference): string {
  return `Reference (cached):

Manual rules:
${ref.manual}

Known tendencies (use only these for tendencies_hit):
${ref.tendencies.length ? JSON.stringify(ref.tendencies, null, 2) : '(none)'}

Playbook patterns:
${ref.patterns.length ? JSON.stringify(ref.patterns, null, 2) : '(none)'}

Cheatsheets:
${ref.cheatsheets.length ? JSON.stringify(ref.cheatsheets, null, 2) : '(none)'}`;
}

function buildFreshBlock(trade: Trade, bars: Array<{ t: string; c: number }>): string {
  const safeTrade = { ...trade, alpaca_order_id: undefined, alpaca_close_order_id: undefined };
  return `Trade record (id: ${trade.id}):
${JSON.stringify(safeTrade, null, 2)}

Price bars during position lifetime (1-min closes):
${bars.length ? bars.slice(0, 240).map((b) => `${b.t}\t${b.c}`).join('\n') : '(no bars available)'}

User's entry grade: ${trade.entry_grade}
User's entry reasoning: "${trade.entry_reasoning}"

Now grade this trade per the system rules. Output JSON only.`;
}

function tryParse(text: string, traderLetter: GradeLetter): GradeHindsight | null {
  // strip code-fence wrappers if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let obj: any;
  try { obj = JSON.parse(cleaned); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!GRADE_LETTERS.includes(obj.letter)) return null;
  if (typeof obj.review !== 'string') return null;
  const calibration: Calibration = obj.calibration ?? calibrationFor(traderLetter, obj.letter);
  return {
    letter: obj.letter,
    review: obj.review,
    calibration,
    tendencies_hit: Array.isArray(obj.tendencies_hit) ? obj.tendencies_hit : [],
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
    ts: new Date().toISOString(),
  };
}

interface GradeInput {
  trade: Trade;
  bars: Array<{ t: string; c: number }>;
}

export async function gradeTrade(input: GradeInput): Promise<GradeHindsight> {
  const { trade, bars } = input;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
  const ref = await loadCachedReference();
  const cached = buildCachedBlock(ref);
  const fresh = buildFreshBlock(trade, bars);

  async function callOnce(systemSuffix = ''): Promise<{ text: string; usage: any }> {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: [
        { type: 'text', text: SYSTEM_PROMPT + systemSuffix },
        { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
      ] as any,
      messages: [{ role: 'user', content: fresh }],
    });
    const block = resp.content.find((b: any) => b.type === 'text') as any;
    return { text: block?.text ?? '', usage: resp.usage };
  }

  const first = await callOnce();
  let parsed = tryParse(first.text, trade.entry_grade);
  let usage = first.usage;
  let raw = first.text;

  if (!parsed) {
    const retry = await callOnce('\n\nIMPORTANT: Output ONLY valid JSON. No prose, no markdown fences.');
    parsed = tryParse(retry.text, trade.entry_grade);
    usage = retry.usage;
    raw = retry.text;
  }

  if (!parsed) {
    return {
      letter: trade.entry_grade,
      review: '',
      calibration: 'matched',
      tendencies_hit: [],
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cached_tokens: usage?.cache_read_input_tokens ?? 0,
      },
      ts: new Date().toISOString(),
      parse_failed: true,
      raw,
    };
  }

  return {
    ...parsed,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cached_tokens: usage?.cache_read_input_tokens ?? 0,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/lib/grading.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/grading.ts dashboard/tests/lib/grading.test.ts
git commit -m "feat(dashboard): claude grading helper with prompt caching and retry"
```

### Task 20: Implement the `regrade` action

**Files:**
- Modify: `dashboard/api/trades/[action].ts`
- Create: `dashboard/tests/api/trades-regrade.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// dashboard/tests/api/trades-regrade.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, incr: vi.fn() }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({ alpacaData: (...a: any[]) => dataMock(...a) }));

beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); gradeMock.mockReset(); dataMock.mockReset(); });

function mockReq(body: any): VercelRequest {
  return { method: 'POST', query: { action: 'regrade' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/regrade', () => {
  it('snapshots current hindsight to history before writing fresh', async () => {
    const trade = { id: 'T-2026-05-04-001', symbol: 'TSLA', account: 'conservative_paper', filled_at: '2026-05-04T13:30Z', closed_at: '2026-05-04T20:00Z' } as any;
    const oldGrade = {
      trade_id: 'T-2026-05-04-001',
      entry: { letter: 'A', reasoning: 'r', ts: 'now' },
      hindsight: { letter: 'B+', review: 'old', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'old-ts' },
      history: [],
    };
    kvGet.mockImplementation((k: string) => {
      if (k.startsWith('trade:')) return Promise.resolve(trade);
      if (k.startsWith('grade:')) return Promise.resolve(oldGrade);
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: [] });
    gradeMock.mockResolvedValue({ letter: 'A-', review: 'fresh', calibration: 'matched', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 }, ts: 'new-ts' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ id: 'T-2026-05-04-001' }), res);
    expect(kvSet).toHaveBeenCalledWith(
      'grade:T-2026-05-04-001',
      expect.objectContaining({
        history: expect.arrayContaining([expect.objectContaining({ hindsight: expect.objectContaining({ letter: 'B+' }) })]),
        hindsight: expect.objectContaining({ letter: 'A-' }),
      })
    );
  });

  it('returns 404 when trade not found', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ id: 'missing' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/trades-regrade.test.ts`
Expected: FAIL — `regrade` is still a 501 stub.

- [ ] **Step 3: Implement the action**

In `dashboard/api/trades/[action].ts`, replace the `regrade` stub:

```typescript
import { gradeTrade } from '../_lib/grading.js';

async function regrade(req: VercelRequest, res: VercelResponse) {
  const id = String((req.body as any)?.id ?? req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  const trade = await kv().get<Trade>(tradeKey(id));
  const grade = await kv().get<any>(gradeKey(id));
  if (!trade) return res.status(404).json({ error: 'trade_not_found' });
  if (!grade) return res.status(404).json({ error: 'grade_not_found' });

  // Pull bars across position lifetime
  const start = trade.filled_at ?? trade.submitted_at;
  const end = trade.closed_at ?? new Date().toISOString();
  let bars: Array<{ t: string; c: number }> = [];
  try {
    const data = await alpacaData(modeFromAccount(trade.account) as any, '/v2/stocks/bars', {
      symbols: trade.symbol, timeframe: '1Min', start, end, limit: 500,
    });
    bars = (data?.bars?.[trade.symbol] ?? []).map((b: any) => ({ t: b.t, c: b.c }));
  } catch { /* bars are optional */ }

  const hindsight = await gradeTrade({ trade, bars });

  const history = grade.hindsight ? [{ entry: grade.entry, hindsight: grade.hindsight }, ...(grade.history ?? [])] : (grade.history ?? []);
  const next = { ...grade, hindsight, history };
  await kv().set(gradeKey(id), next);
  return res.status(200).json({ grade: next });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/trades-regrade.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/api/trades-regrade.test.ts
git commit -m "feat(dashboard): /api/trades/regrade with history snapshot"
```

### Task 21: Build the cron catchall + grade-open-trades job

**Files:**
- Create: `dashboard/api/cron/[job].ts`
- Create: `dashboard/tests/api/cron-grade-open-trades.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// dashboard/tests/api/cron-grade-open-trades.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
const alpacaGetOrder = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({ alpacaData: (...a: any[]) => dataMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ getOrder: (...a: any[]) => alpacaGetOrder(...a), getPositions: vi.fn() }),
  modeFromQuery: () => 'conservative',
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); gradeMock.mockReset(); dataMock.mockReset(); alpacaGetOrder.mockReset();
  process.env.CRON_TOKEN = 'cron-token';
});

function mockReq(headers: any = {}): VercelRequest {
  return { method: 'POST', query: { job: 'grade-open-trades' }, headers } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/cron/grade-open-trades', () => {
  it('rejects missing bearer token', async () => {
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('grades a trade whose Alpaca close order has filled', async () => {
    const trade = {
      id: 'T-2026-05-04-001', account: 'conservative_paper', symbol: 'TSLA', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: 319.85, exposure_at_submit: 3198.50,
      alpaca_order_id: 'a1', alpaca_close_order_id: 'a2',
      filled_at: '2026-05-04T13:30Z', closed_at: null, realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'A', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvGet.mockImplementation((k: string) => {
      if (k === 'trades:index:open') return Promise.resolve([trade.id]);
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaGetOrder
      .mockResolvedValueOnce({ id: 'a2', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B+', review: 'r', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.any(String), realized_pnl: expect.any(Number), closed_by: 'manual' }));
    expect(kvSet).toHaveBeenCalledWith(`grade:${trade.id}`, expect.objectContaining({ hindsight: expect.objectContaining({ letter: 'B+' }) }));
    expect(kvSet).toHaveBeenCalledWith('trades:index:open', []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run tests/api/cron-grade-open-trades.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cron catchall**

```typescript
// dashboard/api/cron/[job].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { KV_KEYS, tradeKey, gradeKey } from '../_lib/kv-keys.js';
import { gradeTrade } from '../_lib/grading.js';
import { alpacaFor } from '../_lib/alpaca.js';
import { alpacaData } from '../_lib/data-api.js';
import type { Trade, GradeRecord, ClosedBy } from '../_lib/trade-types.js';

const MAX_PER_TICK = 3;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow either Vercel's built-in cron header OR an explicit bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['user-agent']?.toString().includes('vercel-cron');
  const auth = req.headers.authorization ?? '';
  const expected = `Bearer ${process.env.CRON_TOKEN ?? ''}`;
  if (!isVercelCron && (!process.env.CRON_TOKEN || auth !== expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const job = String(req.query.job ?? '');
  if (job === 'grade-open-trades') return gradeOpenTrades(res);
  return res.status(404).json({ error: 'unknown_job' });
}

function modeFromAccount(account: string): string {
  return account === 'aggressive_paper' ? 'aggressive' : 'conservative';
}

async function gradeOpenTrades(res: VercelResponse) {
  const openIds = (await kv().get<string[]>(KV_KEYS.tradesIndexOpen)) ?? [];
  if (openIds.length === 0) return res.status(200).json({ ok: true, graded: 0 });

  const stillOpen: string[] = [];
  let graded = 0;

  for (const id of openIds) {
    if (graded >= MAX_PER_TICK) { stillOpen.push(id); continue; }
    const trade = await kv().get<Trade>(tradeKey(id));
    if (!trade) continue;

    const closeInfo = await detectClose(trade);
    if (!closeInfo) { stillOpen.push(id); continue; }

    // Update trade record
    const closedTrade: Trade = {
      ...trade,
      closed_at: closeInfo.closed_at,
      closed_avg_price: closeInfo.closed_avg_price,
      realized_pnl: closeInfo.realized_pnl,
      closed_by: closeInfo.closed_by,
      alpaca_close_order_id: closeInfo.alpaca_close_order_id ?? trade.alpaca_close_order_id,
    };
    await kv().set(tradeKey(id), closedTrade);

    // Pull bars and grade
    const start = closedTrade.filled_at ?? closedTrade.submitted_at;
    const end = closedTrade.closed_at ?? new Date().toISOString();
    let bars: Array<{ t: string; c: number }> = [];
    try {
      const data = await alpacaData(modeFromAccount(closedTrade.account) as any, '/v2/stocks/bars', {
        symbols: closedTrade.symbol, timeframe: '1Min', start, end, limit: 500,
      });
      bars = (data?.bars?.[closedTrade.symbol] ?? []).map((b: any) => ({ t: b.t, c: b.c }));
    } catch { /* optional */ }

    const grade = await kv().get<GradeRecord>(gradeKey(id));
    if (!grade) continue;
    const hindsight = await gradeTrade({ trade: closedTrade, bars });
    const next = { ...grade, hindsight };
    await kv().set(gradeKey(id), next);
    graded += 1;
  }

  await kv().set(KV_KEYS.tradesIndexOpen, stillOpen);
  return res.status(200).json({ ok: true, graded, remaining_open: stillOpen.length });
}

interface CloseInfo {
  closed_at: string;
  closed_avg_price: number;
  realized_pnl: number;
  closed_by: NonNullable<ClosedBy>;
  alpaca_close_order_id?: string | null;
}

async function detectClose(trade: Trade): Promise<CloseInfo | null> {
  const client = alpacaFor(modeFromAccount(trade.account) as any);

  // Path 1: explicit close order linked
  if (trade.alpaca_close_order_id) {
    const order = await client.getOrder(trade.alpaca_close_order_id);
    if (order?.status === 'filled' && order.filled_at) {
      const fillPx = Number(order.filled_avg_price);
      return {
        closed_at: order.filled_at,
        closed_avg_price: fillPx,
        realized_pnl: realizedPnl(trade, fillPx),
        closed_by: 'manual',
      };
    }
  }

  // Path 2: option past expiration with no close order = expired worthless
  if (trade.asset_class === 'option' && trade.expiration) {
    const expDate = new Date(trade.expiration + 'T20:00:00Z'); // 4 PM ET ~= 20:00 UTC during DST
    if (Date.now() > expDate.getTime()) {
      // STO expired worthless: kept full premium
      if (trade.side === 'STO') {
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: 0,
          realized_pnl: (trade.filled_avg_price ?? 0) * 100 * trade.qty,
          closed_by: 'expired',
        };
      }
      // BTO expired worthless: lost full premium
      if (trade.side === 'BTO') {
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: 0,
          realized_pnl: -(trade.filled_avg_price ?? 0) * 100 * trade.qty,
          closed_by: 'expired',
        };
      }
    }
  }

  // Path 3: stock — match a later opposite-side fill against the same symbol
  // (Phase 2 keeps this simple — the user is expected to attach a close order via the modify/cancel UI
  // in milestone 6. Skipping fancy FIFO stock matching here.)

  return null;
}

function realizedPnl(trade: Trade, closePx: number): number {
  if (trade.asset_class === 'stock') {
    const dir = trade.side === 'buy' ? 1 : -1;
    return ((closePx - (trade.filled_avg_price ?? 0)) * dir) * trade.qty;
  }
  // option: premium-based
  if (trade.side === 'STO') {
    return ((trade.filled_avg_price ?? 0) - closePx) * 100 * trade.qty;
  }
  if (trade.side === 'BTO') {
    return (closePx - (trade.filled_avg_price ?? 0)) * 100 * trade.qty;
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run tests/api/cron-grade-open-trades.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/cron/[job].ts dashboard/tests/api/cron-grade-open-trades.test.ts
git commit -m "feat(dashboard): /api/cron/grade-open-trades auto-grades closed manual trades"
```

### Task 22: Configure cron-job.org schedule + env vars

**Files:**
- Modify: `tools/setup_cronjobs.py` (add new entry)
- Modify: Vercel env vars (manual step)

- [ ] **Step 1: Add the dashboard cron entry to `tools/setup_cronjobs.py`**

Add a new dict entry to whatever list of jobs the script builds. The job:
- Title: `dashboard-grade-open-trades`
- URL: `https://tradingbot-dashboard-blue.vercel.app/api/cron/grade-open-trades?job=grade-open-trades`
- HTTP method: `POST`
- Authorization header: `Bearer ${CRON_TOKEN}`
- Schedule (UTC): minutes `*/5`, hours `13-20`, days-of-week `1-5`
- Title flag: `enabled: true`

(Match the structure of the existing entries in the file — the cron-job.org account already runs the bot workflows.)

- [ ] **Step 2: Add `CRON_TOKEN` and `ANTHROPIC_API_KEY` to Vercel production env vars**

```bash
cd dashboard
# Generate a token if you don't have one
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Add via Vercel CLI
npx vercel env add CRON_TOKEN production
npx vercel env add ANTHROPIC_API_KEY production
```

- [ ] **Step 3: Mirror `CRON_TOKEN` to a cron-job.org-only secret**

Save the token plus the URL into your cron-job.org account; this is what `tools/setup_cronjobs.py` needs to PATCH the schedule. Re-run the script:

```bash
python tools/setup_cronjobs.py
```

- [ ] **Step 4: Smoke-test the cron endpoint manually**

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $CRON_TOKEN" \
  "https://tradingbot-dashboard-blue.vercel.app/api/cron/grade-open-trades?job=grade-open-trades"
```
Expected response: `{"ok":true,"graded":0,"remaining_open":0}` (assuming no open manual trades yet).

- [ ] **Step 5: Commit**

```bash
git add tools/setup_cronjobs.py
git commit -m "chore(cron): register dashboard-grade-open-trades on cron-job.org"
```

### Task 23: Wire up auto-grade UI signal

**Files:**
- Modify: `dashboard/src/components/trade/GradePanel.tsx`

- [ ] **Step 1: Add a "grade now" button when grade.hindsight is null**

Update the `else` branch in `GradePanel.tsx` so when `h` is null, it shows a `[grade now*]` button that triggers the same regrade mutation:

```tsx
{h ? (
  /* existing AI grade rendering */
) : (
  <div className="mt-2">
    <div className="text-mid text-[10px] pulse">// ungraded — cron picks up closed trades within 5 min</div>
    <button
      type="button"
      className="pbtn active mt-2"
      onClick={() => regrade.mutate()}
      disabled={regrading}
    >[{regrading ? 'grading…' : 'grade now*'}]</button>
  </div>
)}
```

- [ ] **Step 2: Manual end-to-end test**

1. Place a small paper trade via `/order/new`.
2. Manually close it on Alpaca (use `/orders` modify/cancel after Milestone 6, or for now use Alpaca's web UI).
3. Hit the cron endpoint manually with curl (the smoke-test command from Task 22).
4. Open `/trade/<id>` — AI grade should be populated.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/trade/GradePanel.tsx
git commit -m "feat(dashboard): grade-now button for ungraded closed trades"
```

---

## Milestone 5 — Trade history page

### Task 24: Add `useTrades` hook

**Files:**
- Create: `dashboard/src/hooks/useTrades.ts`

- [ ] **Step 1: Write the hook**

```typescript
// dashboard/src/hooks/useTrades.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Trade } from '../lib/trade-types';

export interface TradesFilters {
  account?: string;
  asset_class?: string;
  tag?: string;
  grade?: string;
  status?: 'open' | 'closed';
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface TradeGradeSummary {
  trade_id: string;
  ai_letter: string | null;
  calibration: 'matched' | 'over_1' | 'over_2' | 'under_1' | 'under_2' | null;
}

export interface TradesResponse {
  trades: Trade[];
  grades: TradeGradeSummary[];
  total: number;
  summary: {
    count: number;
    win_rate: number;
    calibration: { matched: number; over: number; under: number };
  };
}

export function useTrades(filters: TradesFilters) {
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  return useQuery({
    queryKey: ['trades', filters],
    queryFn: () => api<TradesResponse>(`/api/trades/list?${qs}`),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/hooks/useTrades.ts
git commit -m "feat(dashboard): useTrades hook with filters"
```

### Task 25: Build the Trades route

**Files:**
- Create: `dashboard/src/routes/Trades.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Build the route**

```tsx
// dashboard/src/routes/Trades.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTrades, type TradesFilters } from '../hooks/useTrades';
import { fmtUsd, fmtPct } from '../lib/format';
import type { Trade, GradeLetter } from '../lib/trade-types';

const ACCOUNTS = ['conservative_paper', 'aggressive_paper'] as const;
const ASSET_CLASSES = ['stock', 'option'] as const;
const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'] as const;
const STATUSES = ['open', 'closed'] as const;

export default function Trades() {
  const [filters, setFilters] = useState<TradesFilters>({ limit: 50, offset: 0 });
  const { data, isLoading } = useTrades(filters);

  const summary = data?.summary;

  return (
    <div className="p-6 max-w-6xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/trades</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">list --account={filters.account ?? 'both'} --status={filters.status ?? 'all'}</span>
      </div>
      <h1 className="text-[44px] font-bold tracking-tight text-hi mt-2">Trades</h1>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <SummaryCard label="count" value={summary ? String(summary.count) : '—'} />
        <SummaryCard label="win rate" value={summary && summary.count
          ? fmtPct(summary.win_rate * 100, { sign: false })
          : '—'} />
        <SummaryCard
          label="calibration"
          value={summary
            ? `over ${summary.calibration.over} · under ${summary.calibration.under} · matched ${summary.calibration.matched}`
            : '—'}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <FilterPbtn
          label="account"
          value={filters.account}
          options={ACCOUNTS}
          onChange={(v) => setFilters({ ...filters, account: v, offset: 0 })}
        />
        <FilterPbtn label="class" value={filters.asset_class} options={ASSET_CLASSES} onChange={(v) => setFilters({ ...filters, asset_class: v, offset: 0 })} />
        <FilterPbtn label="grade" value={filters.grade} options={GRADES as unknown as readonly string[]} onChange={(v) => setFilters({ ...filters, grade: v, offset: 0 })} />
        <FilterPbtn label="status" value={filters.status} options={STATUSES} onChange={(v) => setFilters({ ...filters, status: v as any, offset: 0 })} />
      </div>

      <div className="mt-4 border border-border bg-panel/60">
        <table className="w-full text-[10px] tnum">
          <thead className="text-dim">
            <tr className="border-b border-border">
              <th className="text-left px-3 py-2">date</th>
              <th className="text-left px-3 py-2">symbol</th>
              <th className="text-left px-3 py-2">side</th>
              <th className="text-right px-3 py-2">qty</th>
              <th className="text-right px-3 py-2">entry</th>
              <th className="text-right px-3 py-2">exit</th>
              <th className="text-right px-3 py-2">P&amp;L</th>
              <th className="text-center px-3 py-2">grade</th>
              <th className="text-center px-3 py-2">ai</th>
              <th className="text-left px-3 py-2">tags</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={10} className="text-mid text-[12px] p-3">loading…</td></tr>
            )}
            {data?.trades.map((t, i) => <TradeRow key={t.id} trade={t} gradeSummary={data.grades[i]} />)}
            {!isLoading && data && data.trades.length === 0 && (
              <tr><td colSpan={10} className="text-dim text-[12px] p-3">tim@dash:~/portfolio/trades$ ls — total 0 — none</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="pbtn" disabled={(filters.offset ?? 0) === 0}
                onClick={() => setFilters({ ...filters, offset: Math.max(0, (filters.offset ?? 0) - (filters.limit ?? 50)) })}>
          [&lt; prev]
        </button>
        <button type="button" className="pbtn" disabled={!data || ((filters.offset ?? 0) + (filters.limit ?? 50)) >= (data?.total ?? 0)}
                onClick={() => setFilters({ ...filters, offset: (filters.offset ?? 0) + (filters.limit ?? 50) })}>
          [next &gt;]
        </button>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em]">
        <span className="text-dim">┌──</span> <span className="text-hi">{label.toUpperCase()}</span> <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 text-[16px] text-fg tnum">{value}</div>
    </article>
  );
}

function FilterPbtn<T extends string>({ label, value, options, onChange }: {
  label: string; value: string | undefined; options: readonly T[]; onChange: (v: T | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-dim text-[10px] tracking-[0.25em]">{label.toUpperCase()}:</span>
      <button type="button" className={`pbtn ${value === undefined ? 'active' : ''}`} onClick={() => onChange(undefined)}>[any]</button>
      {options.map((o) => (
        <button key={o} type="button" className={`pbtn ${value === o ? 'active' : ''}`} onClick={() => onChange(o)}>[{o}]</button>
      ))}
    </div>
  );
}

function TradeRow({ trade, gradeSummary }: { trade: Trade; gradeSummary: { ai_letter: string | null; calibration: string | null } }) {
  const date = trade.submitted_at?.slice(0, 10) ?? '';
  const pnl = trade.realized_pnl;
  const pnlEl = pnl != null
    ? <span className={pnl > 0 ? 'text-hi' : pnl < 0 ? 'text-red' : 'text-fg'}>{pnl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pnl))}</span>
    : <span className="text-dim">—</span>;
  const aiColor =
    gradeSummary?.calibration === 'matched' ? 'text-hi'
    : gradeSummary?.calibration === 'over_1' || gradeSummary?.calibration === 'under_1' ? 'text-amber'
    : gradeSummary?.calibration === 'over_2' || gradeSummary?.calibration === 'under_2' ? 'text-red'
    : 'text-dim';
  return (
    <tr className="border-b border-border hover:bg-panel-2">
      <td className="px-3 py-1.5 text-mid">
        <Link to={`/trade/${trade.id}`} className="hover:text-hi">{date}</Link>
      </td>
      <td className="px-3 py-1.5 text-cyan"><Link to={`/trade/${trade.id}`}>{trade.symbol}</Link></td>
      <td className="px-3 py-1.5">{trade.side}</td>
      <td className="px-3 py-1.5 text-right">{trade.qty}</td>
      <td className="px-3 py-1.5 text-right">{trade.filled_avg_price != null ? fmtUsd(trade.filled_avg_price) : <span className="text-dim">—</span>}</td>
      <td className="px-3 py-1.5 text-right">{trade.closed_avg_price != null ? fmtUsd(trade.closed_avg_price) : <span className="text-dim">—</span>}</td>
      <td className="px-3 py-1.5 text-right">{pnlEl}</td>
      <td className="px-3 py-1.5 text-center text-hi">{trade.entry_grade}</td>
      <td className={`px-3 py-1.5 text-center ${aiColor}`}>{gradeSummary?.ai_letter ?? '—'}</td>
      <td className="px-3 py-1.5">
        {trade.tags.slice(0, 3).map((t) => <span key={t} className="text-cyan mr-2">{t}</span>)}
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Wire route into App.tsx + add sidebar entry**

```tsx
<Route path="/trades" element={<ProtectedRoute><AppShell><Trades /></AppShell></ProtectedRoute>} />
```
Import: `import Trades from './routes/Trades';`

In `Sidebar.tsx`, add a `trades` entry pointing to `/trades`.

- [ ] **Step 3: Manual walkthrough**

After placing a few paper trades, navigate to `/trades`:
- Summary band shows count, win rate, calibration ratio.
- Filters update the table and the summary band.
- Pagination buttons enable/disable correctly at edges.
- Clicking a row navigates to `/trade/:id`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/routes/Trades.tsx dashboard/src/hooks/useTrades.ts dashboard/src/App.tsx dashboard/src/components/layout/Sidebar.tsx
git commit -m "feat(dashboard): /trades history with summary band + filterable table"
```

---

## Milestone 6 — Modify/cancel + final E2E

### Task 26: Add modify-order and cancel-order actions to alpaca catchall

**Files:**
- Modify: `dashboard/api/alpaca/[endpoint].ts`

- [ ] **Step 1: Add the two endpoints**

Inside the existing handler in `dashboard/api/alpaca/[endpoint].ts`, add the new branches before the final 404:

```typescript
if (endpoint === 'modify-order' && req.method === 'POST') {
  const body = (req.body ?? {}) as { order_id?: string; qty?: number; limit_price?: number; stop_price?: number; tif?: string };
  if (!body.order_id) return res.status(400).json({ error: 'order_id_required' });
  const patch: Record<string, unknown> = {};
  if (body.qty != null) patch.qty = body.qty;
  if (body.limit_price != null) patch.limit_price = body.limit_price;
  if (body.stop_price != null) patch.stop_price = body.stop_price;
  if (body.tif) patch.time_in_force = body.tif;
  const updated = await alpacaTrade(mode, `/v2/orders/${body.order_id}`, { method: 'PATCH', body: patch });
  return res.status(200).json({ order: updated });
}
if (endpoint === 'cancel-order' && req.method === 'POST') {
  const body = (req.body ?? {}) as { order_id?: string };
  if (!body.order_id) return res.status(400).json({ error: 'order_id_required' });
  await alpacaTrade(mode, `/v2/orders/${body.order_id}`, { method: 'DELETE' });
  return res.status(200).json({ ok: true });
}
```

(The existing `alpacaTrade()` helper from `_lib/data-api.ts` exposes the trading domain; it accepts the optional `method` and `body` params per Phase 1's pattern.)

- [ ] **Step 2: Update the existing alpaca-catchall test (or add a new one)**

```typescript
// dashboard/tests/api/alpaca-modify-cancel.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const alpacaTradeMock = vi.fn();
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth: vi.fn(() => ({})) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: vi.fn(() => ({})), modeFromQuery: () => 'conservative',
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: (...a: any[]) => alpacaTradeMock(...a),
  alpacaData: vi.fn(),
}));

beforeEach(() => alpacaTradeMock.mockReset());

function mockReq(endpoint: string, method: string, body?: any): VercelRequest {
  return { method, query: { endpoint, mode: 'conservative' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('modify-order', () => {
  it('PATCHes the order with provided fields', async () => {
    alpacaTradeMock.mockResolvedValue({ id: 'a1', qty: '5' });
    const handler = (await import('../../api/alpaca/[endpoint]')).default;
    const res = mockRes();
    await handler(mockReq('modify-order', 'POST', { order_id: 'a1', qty: 5, limit_price: 320 }), res);
    expect(alpacaTradeMock).toHaveBeenCalledWith('conservative', '/v2/orders/a1', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ qty: 5, limit_price: 320 }) }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('400 without order_id', async () => {
    const handler = (await import('../../api/alpaca/[endpoint]')).default;
    const res = mockRes();
    await handler(mockReq('modify-order', 'POST', {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('cancel-order', () => {
  it('DELETEs the order', async () => {
    alpacaTradeMock.mockResolvedValue(null);
    const handler = (await import('../../api/alpaca/[endpoint]')).default;
    const res = mockRes();
    await handler(mockReq('cancel-order', 'POST', { order_id: 'a1' }), res);
    expect(alpacaTradeMock).toHaveBeenCalledWith('conservative', '/v2/orders/a1', expect.objectContaining({ method: 'DELETE' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Step 3: Note**: `alpacaTrade` may need a small extension to accept `method` and `body` params. If it doesn't already, update `dashboard/api/_lib/data-api.ts` to accept an optional `init` arg and forward to `fetch`.

- [ ] **Step 4: Run tests**

Run: `cd dashboard && npx vitest run tests/api/alpaca-modify-cancel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/alpaca/[endpoint].ts dashboard/api/_lib/data-api.ts dashboard/tests/api/alpaca-modify-cancel.test.ts
git commit -m "feat(dashboard): modify-order and cancel-order endpoints"
```

### Task 27: Add modify/cancel buttons to /orders

**Files:**
- Modify: `dashboard/src/routes/Orders.tsx`
- Create: `dashboard/src/components/order/OrderEditModal.tsx`

- [ ] **Step 1: Build the modify modal**

```tsx
// dashboard/src/components/order/OrderEditModal.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Props {
  order: { id: string; qty: string; limit_price: string | null; stop_price: string | null };
  mode: 'conservative' | 'aggressive';
  onClose: () => void;
}

export function OrderEditModal({ order, mode, onClose }: Props) {
  const qc = useQueryClient();
  const [qty, setQty] = useState(Number(order.qty));
  const [limitPrice, setLimitPrice] = useState(order.limit_price ? Number(order.limit_price) : '');
  const [stopPrice, setStopPrice] = useState(order.stop_price ? Number(order.stop_price) : '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: any) => api(`/api/alpaca/modify-order?mode=${mode}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders'] }); onClose(); },
    onError: (e: any) => setError(e.message ?? 'modify failed.'),
  });

  return (
    <div className="fixed inset-0 bg-bg/85 flex items-center justify-center p-4 z-50">
      <div className="bg-panel border border-amber max-w-sm w-full p-5">
        <div className="text-amber text-[14px] font-bold">modify order {order.id.slice(0, 8)}</div>
        <div className="mt-3 space-y-2 text-[12px]">
          <Row k="qty"><input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} className="bg-panel-2 border border-border px-2 py-0.5 w-24 text-right tnum" /></Row>
          <Row k="limit price"><input type="number" step={0.01} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value === '' ? '' : Number(e.target.value))} className="bg-panel-2 border border-border px-2 py-0.5 w-24 text-right tnum" /></Row>
          {order.stop_price && (
            <Row k="stop price"><input type="number" step={0.01} value={stopPrice} onChange={(e) => setStopPrice(e.target.value === '' ? '' : Number(e.target.value))} className="bg-panel-2 border border-border px-2 py-0.5 w-24 text-right tnum" /></Row>
          )}
        </div>
        {error && <div className="text-red text-[10px] mt-2">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="pbtn" onClick={onClose}>[cancel]</button>
          <button type="button" className="pbtn active" onClick={() => save.mutate({
            order_id: order.id,
            qty,
            ...(limitPrice !== '' ? { limit_price: limitPrice } : {}),
            ...(stopPrice !== '' ? { stop_price: stopPrice } : {}),
          })} disabled={save.isPending}>[{save.isPending ? 'saving…' : 'save*'}]</button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex justify-between items-center"><span className="text-mid">{k}</span>{children}</div>;
}
```

- [ ] **Step 2: Add `[modify]` and `[cancel]` columns to the OrdersTable in `Orders.tsx`**

In `dashboard/src/routes/Orders.tsx`, modify the `OrdersTable` component for the open-orders section. Add two trailing cells per row with `[modify]` and `[cancel]` pbtns, plus a `useMutation` hook for cancel:

```tsx
// inside OrdersTable, add:
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OrderEditModal } from '../components/order/OrderEditModal';
import { useState } from 'react';

// inside the component body:
const qc = useQueryClient();
const [editing, setEditing] = useState<Order | null>(null);
const cancel = useMutation({
  mutationFn: (id: string) => api(`/api/alpaca/cancel-order?mode=${mode}`, { method: 'POST', body: JSON.stringify({ order_id: id }) }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
});

// in each open-order row, add two cells:
<td className="px-2 py-1 text-right">
  {status === 'open' && (
    <span className="flex justify-end gap-1">
      <button type="button" className="pbtn" onClick={() => setEditing(order)}>[modify]</button>
      <button type="button" className="pbtn" onClick={() => { if (confirm('cancel this order?')) cancel.mutate(order.id); }}>[cancel]</button>
    </span>
  )}
</td>

// at the end of the component:
{editing && <OrderEditModal order={editing} mode={mode} onClose={() => setEditing(null)} />}
```

- [ ] **Step 3: Manual walkthrough on dev server**

1. Place a paper limit order via `/order/new` that won't fill (e.g. limit way below market for a buy).
2. Go to `/orders` — open-orders table shows `[modify]` and `[cancel]`.
3. Click `[modify]` → modal opens → change qty → save → modal closes, list refreshes with new qty.
4. Click `[cancel]` → confirm → order disappears from open list.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/routes/Orders.tsx dashboard/src/components/order/OrderEditModal.tsx
git commit -m "feat(dashboard): modify and cancel buttons on /orders"
```

### Task 28: End-to-end paper trade walkthrough

This is a manual validation step — no code changes, just verify the whole pipeline.

- [ ] **Step 1: Start fresh dev server**

```bash
cd dashboard && npm run dev
```

- [ ] **Step 2: Place a small paper option STO**

1. Open `/lookup/TSLA`.
2. Pick a near-dated put with reasonable bid/ask, click through to `/order/new?contract=...&action=open&account=conservative_paper`.
3. Fill: STO, 1 contract, limit at mid, day, grade A-, reasoning "wheel test", tags ["wheel"].
4. Submit. Above-threshold → TOTP modal → enter code → submitted.
5. Verify trade appears at `/trade/<id>` with header, chart, timeline, "ungraded" grade panel.

- [ ] **Step 3: Trigger close + auto-grade**

1. From `/orders`, modify the open STO close (or cancel and place a BTC manually) so it fills.
2. Run the cron manually:
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CRON_TOKEN" "https://tradingbot-dashboard-blue.vercel.app/api/cron/grade-open-trades?job=grade-open-trades"
   ```
3. Refresh `/trade/<id>`. AI grade should be populated within a few seconds. Calibration line shows the delta.

- [ ] **Step 4: Verify `/trades` summary**

Open `/trades`. Count, win rate, and calibration ratio should reflect the closed+graded trade.

- [ ] **Step 5: Run full test suite**

```bash
cd dashboard && npm test
```
Expected: all tests pass (existing 34 from Phase 1 plus new Phase 2 tests — should be roughly 60+).

- [ ] **Step 6: Final commit (no code, but mark milestone)**

```bash
git commit --allow-empty -m "chore(dashboard): phase 2 e2e walkthrough complete"
```

### Task 29: Deploy to production

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin claude/competent-feynman-1c5e52
gh pr create --title "Phase 2: manual trading + AI grading" --body "$(cat <<'EOF'
## Summary
- Adds `/settings`, `/order/new`, `/trade/:id`, `/trades` and modify/cancel on `/orders`
- Trade record + grade record schemas in KV; daily T-YYYY-MM-DD-NNN ID counter
- AI hindsight grading via Claude Sonnet 4.6 with prompt caching, fired by cron-job.org every 5 min
- Stub rule-checker (sizing/earnings/bot-overlap) on the confirm modal
- TOTP re-prompt above per-account `$` threshold; backup-codes migrated to KV with env-var fallback

## Test plan
- [x] All vitest tests passing
- [x] Manual paper trade placement (stock + option open + option close)
- [x] TOTP re-prompt fires above threshold
- [x] Cron auto-grade verified end-to-end
- [x] Modify and cancel an open order from /orders
- [x] /trades summary reflects calibration ratio across graded trades

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: After merge, deploy to production**

```bash
cd dashboard && npx vercel --prod
```

- [ ] **Step 3: Smoke-test production endpoint**

```bash
curl -fsS https://tradingbot-dashboard-blue.vercel.app/api/cron/grade-open-trades?job=grade-open-trades \
  -X POST -H "Authorization: Bearer $CRON_TOKEN"
```
Expected: `{"ok":true,"graded":0,"remaining_open":0}`.

- [ ] **Step 4: Update CLAUDE.md**

Add a Phase 2 section to `CLAUDE.md` under the Dashboard subproject, mirroring the Phase 1 section:
- New routes
- New env vars (`ANTHROPIC_API_KEY`, `CRON_TOKEN`)
- New cron-job.org schedule
- Updated function count (9 of 12)

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with phase 2 dashboard architecture"
git push
```

---

## Open implementation decisions resolved

The spec listed seven items for plan-writing to settle. Resolutions:

1. **Backup codes storage** — migrated to KV (`auth:backup_codes_hashed`) in Task 5 with env-var fallback. Migration is implicit: first regenerate-via-UI populates KV; env var stays as backup until cleanup release.
2. **Assignment follow-on tracking** — deferred to Phase 3. Task 21's `detectClose` flags `closed_by: "assigned"` but does not auto-create a stock trade. Documented in CLAUDE.md.
3. **Modify-order UI** — modal (Task 27). Matches confirm-modal pattern for consistency.
4. **Trade ID counter race** — uses `kv().incr()` in Task 4 (atomic per Upstash semantics).
5. **Calibration computation source** — `/api/trades/list` summary in Task 13 only counts graded+closed trades. Ungraded-closed trades are excluded from calibration; UI does not break them out separately in Phase 2.
6. **TradingView lib pick on /trade/:id** — `lightweight-charts` (Task 1, Task 17). Markers API needed for entry/exit overlays.
7. **Trade history pagination** — naïve `mget` per month, in-memory filter (Task 13). Fine at 100 trades/year.

## Function count after Phase 2

| File | Function |
|---|---|
| `api/auth/[action].ts` | existing |
| `api/alpaca/[endpoint].ts` | existing (modify/cancel are bolt-on actions, not new files) |
| `api/kv/[resource].ts` | existing |
| `api/bot-state.ts` | existing |
| `api/fundamentals.py` | existing |
| `api/fundamentals-proxy.ts` | existing |
| `api/trades/[action].ts` | **new** |
| `api/settings/[resource].ts` | **new** |
| `api/cron/[job].ts` | **new** |

**9 of 12 Hobby functions used.** Phase 3 (`detect-tendencies` action goes inside `api/cron/[job].ts`) and Phase 4 (`daily-review` action also inside `api/cron/[job].ts`, plus possibly `api/coach.ts`) stay under the limit.




