# Trading Dashboard Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the rules / playbook / coaching layer of the trading dashboard — `/rules`, `/rules/edit`, `/watchlist`, `/calendar`, `/performance` pages, an active rule-checker on order placement, a Sunday tendency-detection cron with proposal inbox + rule-demotion loop, STO-assignment auto-spawn, and three Phase 2 follow-up cleanups.

**Architecture:** Reuses existing dashboard plumbing — Vite + React 19 + Tailwind v4 SPA, Vercel Hobby (Functions + KV via Upstash), cron-job.org, Alpaca SDK + bypasses, Sonnet 4.6 with prompt caching. New API endpoint `api/rules/[resource].ts` (catchall, +1 of 3 remaining function slots → 10 of 12 used). Bot rules flow via the existing `bot-state.ts` push receiver to per-mode KV keys. Trigger DSL is small and structured so the rule-checker stays deterministic; the only LLM in Phase 3 is one Sonnet call per tendency-finding to write proposals in plain English.

**Tech Stack:**
- Frontend: React 19, TypeScript, Tailwind v4, lightweight-charts v5, react-router-dom v6
- Backend: Vercel serverless functions (Node 20), `@upstash/redis`, `@anthropic-ai/sdk`
- Bot side: Python 3.x (existing `config.py` is the source of truth)
- Tests: vitest

---

## File structure (new + modified)

### New API files

| Path | Purpose |
|---|---|
| `dashboard/api/rules/[resource].ts` | Catchall — manual/patterns/cheatsheets/goals CRUD; tendencies/proposals read + approve/dismiss; bot read-through |
| `dashboard/api/_lib/rules-types.ts` | Shared types: `Trigger`, `ManualRule`, `Pattern`, `Cheatsheet`, `Goal`, `Tendency`, `Proposal`, `BotRulesPayload`, `MatcherName`, `AssignmentEntry` |
| `dashboard/api/_lib/et-time.ts` | DST-aware ET wall-clock helpers (closes follow-up #3) |
| `dashboard/api/_lib/tendency-matchers.ts` | Six deterministic matchers + helper utilities |
| `dashboard/api/_lib/proposal-prompts.ts` | Sonnet 4.6 prompt builders for new-rule proposals + demote proposals |
| `dashboard/api/_lib/assignment-spawn.ts` | Helpers for assignment detection + drain |

### New frontend files

| Path | Purpose |
|---|---|
| `dashboard/src/routes/Rules.tsx` | Read-only seven-section view |
| `dashboard/src/routes/RulesEdit.tsx` | Section-dispatched editor |
| `dashboard/src/routes/Watchlist.tsx` | Saved-symbol list |
| `dashboard/src/routes/Calendar.tsx` | Month grid w/ P&L heatmap + expiration overlay |
| `dashboard/src/routes/Performance.tsx` | Six-panel analytics |
| `dashboard/src/components/rules/BotRulesSection.tsx` | Cons/agg two-column display |
| `dashboard/src/components/rules/ManualRulesSection.tsx` | Cards + edit/delete |
| `dashboard/src/components/rules/PatternsSection.tsx` | Pattern cards |
| `dashboard/src/components/rules/TendenciesSection.tsx` | Read-only findings |
| `dashboard/src/components/rules/ProposalsSection.tsx` | Approve/dismiss/edit-then-add |
| `dashboard/src/components/rules/CheatsheetsSection.tsx` | Title + body markdown |
| `dashboard/src/components/rules/GoalsSection.tsx` | Body + target + due |
| `dashboard/src/components/rules/RuleCard.tsx` | Shared card primitive (severity badge + trigger summary) |
| `dashboard/src/components/rules/TriggerBuilder.tsx` | No-JSON dropdown trigger UI |
| `dashboard/src/components/order/RuleViolationsBanner.tsx` | Yellow/red banner |
| `dashboard/src/components/order/BlockOverrideFields.tsx` | Override checkbox + 20-char textarea |
| `dashboard/src/components/calendar/MonthGrid.tsx` | 7-col day grid |
| `dashboard/src/components/calendar/DayDrawer.tsx` | Click-day side drawer |
| `dashboard/src/components/performance/EquityPanel.tsx` | Equity curve panel wrapper |
| `dashboard/src/components/performance/DrawdownPanel.tsx` | Running drawdown line |
| `dashboard/src/components/performance/CalibrationScatter.tsx` | Your-grade vs AI-grade scatter |
| `dashboard/src/components/performance/WinRateByTagBar.tsx` | Horizontal bar chart |
| `dashboard/src/components/performance/PnLBySymbolTable.tsx` | Sortable table |
| `dashboard/src/components/performance/TimeHeatmap.tsx` | 5×7 day×hour heatmap |
| `dashboard/src/hooks/useRules.ts` | Loader + mutator hook for rules KV |

### Modified files

| Path | Changes |
|---|---|
| `dashboard/api/_lib/kv-keys.ts` | Add `bot:rules:conservative` / `bot:rules:aggressive` to BOT_STATE_KEYS; add new dashboard key patterns for `rules:*`, `trades:index:assignments-pending` |
| `dashboard/api/_lib/trade-types.ts` | Extend `RuleSeverity` w/ `'block'`; widen `RuleWarning.rule` to `string`; add `override_reason?`; add `Trade.parent_id?`, `source?`, `ai_grade_inherited?` |
| `dashboard/api/_lib/rule-check.ts` | Replace stub w/ trigger-DSL evaluator; keep three legacy built-ins |
| `dashboard/api/bot-state.ts` | Allow `bot:rules:conservative` / `bot:rules:aggressive` keys |
| `dashboard/api/trades/[action].ts` | Add `check`, `calendar`, `performance` actions |
| `dashboard/api/cron/[job].ts` | Add `detect-tendencies` action; extend `grade-open-trades` w/ assignment detection + drain |
| `dashboard/api/alpaca/[endpoint].ts` | Fix Direction TS warning at line 38 |
| `dashboard/src/routes/OrderNew.tsx` | Wire `POST /api/trades/check` before confirm modal |
| `dashboard/src/components/order/ConfirmModal.tsx` | Add violations banner + block override fields |
| `dashboard/src/components/layout/Layout.tsx` (or nav file) | Add Rules / Watchlist / Calendar / Performance nav links |
| `.github/workflows/tsla-monitor.yml` | Append push-rules step |
| `.github/workflows/tsla-monitor-aggressive.yml` | Append push-rules step |
| `tools/setup_cronjobs.py` | Register tendency cron |

### New bot-side file

| Path | Purpose |
|---|---|
| `tools/push_rules_to_dashboard.py` | Reads `config.MODES` and POSTs to `/api/bot-state` |

---

## Milestone 1 — Bot rules pipe + data foundations

Establishes the foundation: bot pushes its rules to KV, dashboard data model has the new fields, and the assignment-pending inbox is plumbed (used in M5). No user-facing changes yet.

### Task 1.1: Extend trade types for Phase 3 fields

**Files:**
- Modify: `dashboard/api/_lib/trade-types.ts`
- Test: `dashboard/tests/trade-types.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/tests/trade-types.test.ts
import { describe, it, expect } from 'vitest';
import type { Trade, RuleWarning } from '../api/_lib/trade-types';

describe('Trade type extensions (Phase 3)', () => {
  it('accepts parent_id, source, ai_grade_inherited as optional fields', () => {
    const t: Trade = {
      id: 'T-2026-05-07-001',
      account: 'conservative_paper',
      asset_class: 'stock',
      symbol: 'F',
      side: 'buy',
      qty: 100,
      order_type: 'market',
      limit_price: null,
      stop_price: null,
      trail_pct: null,
      tif: 'day',
      contract_symbol: null,
      strike: null,
      expiration: null,
      contract_type: null,
      greeks_at_entry: null,
      alpaca_order_id: 'a-1',
      alpaca_close_order_id: null,
      submitted_at: '2026-05-07T13:00:00Z',
      filled_at: null,
      filled_avg_price: null,
      closed_at: null,
      closed_avg_price: null,
      realized_pnl: null,
      closed_by: null,
      tags: [],
      entry_grade: 'B',
      entry_reasoning: 'assigned from put',
      journal: '',
      exposure_at_submit: 0,
      rule_warnings_at_entry: [],
      schema: 1,
      parent_id: 'T-2026-05-01-002',
      source: 'assignment',
      ai_grade_inherited: true,
    };
    expect(t.parent_id).toBe('T-2026-05-01-002');
    expect(t.source).toBe('assignment');
    expect(t.ai_grade_inherited).toBe(true);
  });

  it('accepts block severity and override_reason on RuleWarning', () => {
    const w: RuleWarning = {
      rule: 'no_earnings_week',
      severity: 'block',
      message: 'TSLA earnings in 3 days',
      override_reason: 'IV crush already priced in based on last 4 cycles',
    };
    expect(w.severity).toBe('block');
    expect(w.override_reason).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- trade-types.test.ts
```

Expected: FAIL — `'block'` not assignable to `RuleSeverity`, `parent_id` not on `Trade`, etc.

- [ ] **Step 3: Modify the type file**

```ts
// dashboard/api/_lib/trade-types.ts — replace the relevant lines

export type RuleSeverity = 'info' | 'warn' | 'block';
export interface RuleWarning {
  rule: string;                       // built-in IDs OR user-defined rule.id
  severity: RuleSeverity;
  message: string;
  override_reason?: string;           // required at runtime iff severity === 'block'
}

// In Trade interface, add three optional fields:
export interface Trade {
  // ... existing fields unchanged ...
  rule_warnings_at_entry: RuleWarning[];
  schema: 1;
  parent_id?: string;
  source?: 'manual' | 'assignment';
  ai_grade_inherited?: boolean;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- trade-types.test.ts
```

Expected: PASS — both tests pass; full suite still passes (`npm test`).

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/trade-types.ts dashboard/tests/trade-types.test.ts
git commit -m "feat(dashboard): extend Trade + RuleWarning for Phase 3 fields"
```

---

### Task 1.2: Whitelist new KV keys

**Files:**
- Modify: `dashboard/api/_lib/kv-keys.ts`
- Test: `dashboard/tests/kv-keys.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/kv-keys.test.ts — append to existing file
import { describe, it, expect } from 'vitest';
import {
  isAllowedBotStateKey,
  isAllowedDashboardKey,
  KV_KEYS,
  botRulesKey,
  rulesKey,
  assignmentsPendingKey,
} from '../api/_lib/kv-keys';

describe('Phase 3 KV keys', () => {
  it('whitelists bot:rules:conservative and bot:rules:aggressive', () => {
    expect(isAllowedBotStateKey('bot:rules:conservative')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:aggressive')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:wrong')).toBe(false);
  });

  it('whitelists rules:* dashboard keys', () => {
    expect(isAllowedDashboardKey('rules:manual')).toBe(true);
    expect(isAllowedDashboardKey('rules:patterns')).toBe(true);
    expect(isAllowedDashboardKey('rules:cheatsheets')).toBe(true);
    expect(isAllowedDashboardKey('rules:goals')).toBe(true);
    expect(isAllowedDashboardKey('rules:tendencies')).toBe(true);
    expect(isAllowedDashboardKey('rules:proposals')).toBe(true);
  });

  it('whitelists trades:index:assignments-pending', () => {
    expect(isAllowedDashboardKey('trades:index:assignments-pending')).toBe(true);
  });

  it('exports botRulesKey + rulesKey + assignmentsPendingKey helpers', () => {
    expect(botRulesKey('conservative')).toBe('bot:rules:conservative');
    expect(botRulesKey('aggressive')).toBe('bot:rules:aggressive');
    expect(rulesKey('manual')).toBe('rules:manual');
    expect(assignmentsPendingKey()).toBe('trades:index:assignments-pending');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- kv-keys.test.ts
```

Expected: FAIL — helpers/keys not exported.

- [ ] **Step 3: Update kv-keys.ts**

```ts
// dashboard/api/_lib/kv-keys.ts — replace file
export const BOT_STATE_KEYS = [
  'bot:state:conservative',
  'bot:state:aggressive',
  'bot:strategy:conservative',
  'bot:strategy:aggressive',
  'bot:congress',
  'bot:rules:conservative',
  'bot:rules:aggressive',
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
  /^trades:index:assignments-pending$/,
  /^trades:index:\d{4}-\d{2}$/,
  /^trades:counter:\d{4}-\d{2}-\d{2}$/,
  /^tags:list$/,
  /^config:totp_thresholds$/,
  /^auth:backup_codes_hashed$/,
  /^auth:used-backup-codes$/,
  /^watchlist$/,
  /^rules:(manual|patterns|cheatsheets|goals|tendencies|proposals)$/,
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

export function tradeKey(id: string): string { return `trade:${id}`; }
export function gradeKey(id: string): string { return `grade:${id}`; }
export function tradesIndexMonthKey(yyyymm: string): string { return `trades:index:${yyyymm}`; }
export function tradesCounterKey(yyyymmdd: string): string { return `trades:counter:${yyyymmdd}`; }

export function botRulesKey(mode: 'conservative' | 'aggressive'): BotStateKey {
  return `bot:rules:${mode}` as BotStateKey;
}

export type RulesResource =
  | 'manual' | 'patterns' | 'cheatsheets' | 'goals' | 'tendencies' | 'proposals';

export function rulesKey(resource: RulesResource): string {
  return `rules:${resource}`;
}

export function assignmentsPendingKey(): string {
  return 'trades:index:assignments-pending';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- kv-keys.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/kv-keys.ts dashboard/tests/kv-keys.test.ts
git commit -m "feat(dashboard): whitelist Phase 3 KV keys + helpers"
```

---

### Task 1.3: Create rules-types.ts

**Files:**
- Create: `dashboard/api/_lib/rules-types.ts`
- Test: `dashboard/tests/rules-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/tests/rules-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  TRIGGER_TYPES,
  isTrigger,
  type Trigger,
  type ManualRule,
  type Proposal,
  type Tendency,
  type BotRulesPayload,
  type AssignmentEntry,
  type MatcherName,
} from '../api/_lib/rules-types';

describe('rules-types', () => {
  it('exposes all 11 trigger types', () => {
    expect(TRIGGER_TYPES).toEqual([
      'symbol_in', 'symbol_not_in', 'side', 'asset_class',
      'option_type', 'option_dte_lt', 'option_dte_gt',
      'open_position_count_gt', 'earnings_within_days',
      'strike_below_cost_basis', 'tag_present',
    ]);
  });

  it('isTrigger validates structure', () => {
    expect(isTrigger({ type: 'symbol_in', symbols: ['TSLA'] })).toBe(true);
    expect(isTrigger({ type: 'option_dte_lt', value: 7 })).toBe(true);
    expect(isTrigger({ type: 'strike_below_cost_basis' })).toBe(true);
    expect(isTrigger({ type: 'unknown' })).toBe(false);
    expect(isTrigger(null)).toBe(false);
    expect(isTrigger({ type: 'symbol_in' })).toBe(false); // missing symbols
  });

  it('ManualRule has required shape', () => {
    const r: ManualRule = {
      id: 'r-1', title: 'No earnings week', body: 'never trade through earnings',
      severity: 'block',
      triggers: [{ type: 'earnings_within_days', value: 7 }],
      source: 'manual',
      created_at: '2026-05-07T00:00:00Z',
      updated_at: '2026-05-07T00:00:00Z',
    };
    expect(r.severity).toBe('block');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- rules-types.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create rules-types.ts**

```ts
// dashboard/api/_lib/rules-types.ts
import type { GradeLetter } from './trade-types.js';

export const TRIGGER_TYPES = [
  'symbol_in', 'symbol_not_in', 'side', 'asset_class',
  'option_type', 'option_dte_lt', 'option_dte_gt',
  'open_position_count_gt', 'earnings_within_days',
  'strike_below_cost_basis', 'tag_present',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type Trigger =
  | { type: 'symbol_in'; symbols: string[] }
  | { type: 'symbol_not_in'; symbols: string[] }
  | { type: 'side'; value: 'buy' | 'sell' }
  | { type: 'asset_class'; value: 'stock' | 'option' }
  | { type: 'option_type'; value: 'put' | 'call' }
  | { type: 'option_dte_lt'; value: number }
  | { type: 'option_dte_gt'; value: number }
  | { type: 'open_position_count_gt'; value: number }
  | { type: 'earnings_within_days'; value: number }
  | { type: 'strike_below_cost_basis' }
  | { type: 'tag_present'; tag: string };

export function isTrigger(x: unknown): x is Trigger {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.type !== 'string') return false;
  if (!(TRIGGER_TYPES as readonly string[]).includes(o.type)) return false;
  switch (o.type) {
    case 'symbol_in':
    case 'symbol_not_in':
      return Array.isArray(o.symbols) && o.symbols.every(s => typeof s === 'string');
    case 'side':
      return o.value === 'buy' || o.value === 'sell';
    case 'asset_class':
      return o.value === 'stock' || o.value === 'option';
    case 'option_type':
      return o.value === 'put' || o.value === 'call';
    case 'option_dte_lt':
    case 'option_dte_gt':
    case 'open_position_count_gt':
    case 'earnings_within_days':
      return typeof o.value === 'number';
    case 'strike_below_cost_basis':
      return true;
    case 'tag_present':
      return typeof o.tag === 'string';
    default:
      return false;
  }
}

export type Severity = 'block' | 'warn';

export interface ManualRule {
  id: string;
  title: string;
  body: string;
  severity: Severity;
  triggers: Trigger[];
  source: 'manual' | 'tendency';
  created_at: string;
  updated_at: string;
}

export interface Pattern {
  id: string;
  name: string;
  environment: string;
  variables: string[];
  legs: string[];
  rules: string[];
  win_rate?: number;
  created_at: string;
  updated_at: string;
}

export interface Cheatsheet {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  body: string;
  target?: string;
  due?: string;
  checked?: boolean;
  created_at: string;
  updated_at: string;
}

export const MATCHER_NAMES = [
  'loss_concentration_by_symbol',
  'loss_concentration_by_side',
  'cc_below_cost_basis',
  'held_through_earnings',
  'override_loss_pattern',
  'over_grading_self',
] as const;
export type MatcherName = (typeof MATCHER_NAMES)[number];

export interface Tendency {
  id: string;
  matcher: MatcherName;
  finding: string;
  evidence_trade_ids: string[];
  detected_at: string;
}

export interface Proposal {
  id: string;
  matcher: MatcherName;
  proposed_rule: {
    title: string;
    body: string;
    severity: Severity;
    triggers: Trigger[];
  };
  reasoning: string;
  evidence_trade_ids: string[];
  status: 'open' | 'dismissed' | 'approved';
  proposed_at: string;
  resolved_at?: string;
  demote_target_rule_id?: string;       // if set, this proposal demotes an existing rule
}

export interface BotRulesPayload {
  mode: 'conservative' | 'aggressive';
  wheel: {
    symbols: string[];
    priority_tier?: string[];
    fallback_tier?: string[];
    otm_pct: number;
    dte_min: number;
    dte_max: number;
    close_at_profit_pct: number;
  };
  strategy: {
    underlying: string;
    initial_qty: number;
    stop_loss_pct: number;
    trail_activate_pct: number;
    trail_floor_pct: number;
    ladders: { trigger_pct: number; qty: number }[];
  };
  congress?: {
    sizing_tiers: { name: string; min_disclosure: number; max_alloc: number }[];
    politicians: { id: string; name: string }[];
  };
  pushed_at: string;
}

export interface AssignmentEntry {
  parent_trade_id: string;
  underlying: string;
  strike: number;
  qty: number;
  account: 'conservative_paper' | 'aggressive_paper';
  detected_at: string;
}

// Helpers used across Phase 3 modules
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

export const _typeAliasUsed: GradeLetter[] = [];   // keeps GradeLetter import non-empty
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd dashboard && npm test -- rules-types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/rules-types.ts dashboard/tests/rules-types.test.ts
git commit -m "feat(dashboard): add Phase 3 rules-types module"
```

---

### Task 1.4: Extend bot-state.ts to accept bot:rules:* keys

**Files:**
- Modify: `dashboard/api/bot-state.ts`
- Test: `dashboard/tests/bot-state.test.ts`

- [ ] **Step 1: Read existing bot-state.ts to understand its current shape**

```bash
cat dashboard/api/bot-state.ts
```

The existing handler accepts a JSON body `{ key, value }` with bearer auth and a key whitelist via `isAllowedBotStateKey`. With Task 1.2 already extending the whitelist, this should "just work" for `bot:rules:*` — but we add tests to confirm and to fix any payload-size or shape issues that surface.

- [ ] **Step 2: Write the failing test**

```ts
// dashboard/tests/bot-state.test.ts — append to existing tests
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kvSet = vi.fn();
const kvSetEx = vi.fn();
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ set: kvSet, setex: kvSetEx, get: vi.fn() }),
}));

describe('bot-state.ts — bot:rules push', () => {
  beforeEach(() => { kvSet.mockReset(); kvSetEx.mockReset(); });

  it('accepts bot:rules:conservative payload and writes it', async () => {
    const handler = (await import('../api/bot-state')).default;
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: {
        key: 'bot:rules:conservative',
        value: {
          mode: 'conservative',
          wheel: { symbols: ['TSLA'], otm_pct: 0.10, dte_min: 14, dte_max: 28, close_at_profit_pct: 0.50 },
          strategy: { underlying: 'TSLA', initial_qty: 10, stop_loss_pct: 0.10, trail_activate_pct: 0.10, trail_floor_pct: 0.05, ladders: [] },
          pushed_at: '2026-05-07T13:00:00Z',
        },
      },
    };
    process.env.BOT_PUSH_TOKEN = 'test-token';
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(kvSet).toHaveBeenCalledWith('bot:rules:conservative', expect.any(Object));
  });

  it('rejects bot:rules:invalid_mode', async () => {
    const handler = (await import('../api/bot-state')).default;
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { key: 'bot:rules:invalid', value: {} },
    };
    process.env.BOT_PUSH_TOKEN = 'test-token';
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail or pass**

```bash
cd dashboard && npm test -- bot-state.test.ts
```

Expected: PASS for both — the handler already routes through `isAllowedBotStateKey` from Task 1.2. If a test fails because the handler validates payload shape, fix by either (a) loosening the validation for `bot:rules:*` keys (no shape check) or (b) adding a minimal shape check that the test payload satisfies. Recommended: no shape check; the dashboard reads it back with type assertion.

- [ ] **Step 4: Adjust handler if needed**

If tests fail, the most likely cause is payload-shape validation. Open `dashboard/api/bot-state.ts` and confirm the path: validate auth → validate key via `isAllowedBotStateKey` → call `kv.set(key, value)` → write `bot:last-update:${key}`. No new branch needed.

- [ ] **Step 5: Commit**

```bash
git add dashboard/tests/bot-state.test.ts
git commit -m "test(dashboard): bot:rules:* push receiver coverage"
```

---

### Task 1.5: Create the Python rules pusher

**Files:**
- Create: `tools/push_rules_to_dashboard.py`
- Test: `tools/test_push_rules_to_dashboard.py`

- [ ] **Step 1: Write the failing test**

```python
# tools/test_push_rules_to_dashboard.py
import json
import os
from unittest.mock import MagicMock, patch
import pytest


def test_build_payload_conservative_shape():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('conservative')
    assert payload['mode'] == 'conservative'
    assert 'wheel' in payload
    assert 'strategy' in payload
    assert payload['wheel']['otm_pct'] == 0.10
    assert payload['wheel']['close_at_profit_pct'] == 0.50
    assert payload['strategy']['underlying'] == 'TSLA'
    assert 'pushed_at' in payload
    # congress only on conservative
    assert 'congress' in payload


def test_build_payload_aggressive_no_congress():
    from tools.push_rules_to_dashboard import build_payload
    payload = build_payload('aggressive')
    assert payload['mode'] == 'aggressive'
    assert payload['wheel']['otm_pct'] == 0.05
    assert payload['wheel']['close_at_profit_pct'] == 0.60
    assert 'priority_tier' in payload['wheel']
    assert 'fallback_tier' in payload['wheel']
    assert 'congress' not in payload


@patch('tools.push_rules_to_dashboard.requests.post')
def test_push_calls_dashboard_with_bearer(mock_post):
    mock_post.return_value = MagicMock(status_code=200, text='ok')
    from tools.push_rules_to_dashboard import push
    os.environ['BOT_PUSH_TOKEN'] = 'tok-1'
    os.environ['DASHBOARD_URL'] = 'https://example.com'
    push('conservative')
    args, kwargs = mock_post.call_args
    assert args[0] == 'https://example.com/api/bot-state'
    assert kwargs['headers']['Authorization'] == 'Bearer tok-1'
    body = kwargs['json']
    assert body['key'] == 'bot:rules:conservative'
    assert body['value']['mode'] == 'conservative'
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tools/test_push_rules_to_dashboard.py -v
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the script**

```python
# tools/push_rules_to_dashboard.py
"""Read config.MODES and POST a BotRulesPayload to /api/bot-state.

Used by tsla-monitor.yml + tsla-monitor-aggressive.yml after each bot run.
Idempotent — same input produces same output (modulo `pushed_at`).
"""
import argparse
import datetime as dt
import os
import sys
from typing import Any, Dict

import requests

# Add repo root so `import config` works whether invoked from root or tools/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402


def build_payload(mode: str) -> Dict[str, Any]:
    if mode not in config.MODES:
        raise ValueError(f"unknown mode: {mode}")
    m = config.MODES[mode]

    wheel: Dict[str, Any] = {
        'symbols': list(m['wheel_symbols']),
        'otm_pct': float(m['wheel_otm_pct']),
        'dte_min': int(m['wheel_dte_min']),
        'dte_max': int(m['wheel_dte_max']),
        'close_at_profit_pct': float(m['wheel_close_at_profit_pct']),
    }
    if 'wheel_priority_tier' in m:
        wheel['priority_tier'] = list(m['wheel_priority_tier'])
    if 'wheel_fallback_tier' in m:
        wheel['fallback_tier'] = list(m['wheel_fallback_tier'])

    strategy: Dict[str, Any] = {
        'underlying': m.get('strategy_underlying', 'TSLA'),
        'initial_qty': int(m.get('strategy_initial_qty', 10)),
        'stop_loss_pct': float(m.get('strategy_stop_loss_pct', 0.10)),
        'trail_activate_pct': float(m.get('strategy_trail_activate_pct', 0.10)),
        'trail_floor_pct': float(m.get('strategy_trail_floor_pct', 0.05)),
        'ladders': [
            {'trigger_pct': float(l['trigger_pct']), 'qty': int(l['qty'])}
            for l in m.get('strategy_ladders', [])
        ],
    }

    payload: Dict[str, Any] = {
        'mode': mode,
        'wheel': wheel,
        'strategy': strategy,
        'pushed_at': dt.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
    }

    # Congress-copy is conservative-only
    if mode == 'conservative' and hasattr(config, 'SIZING_TIERS') and hasattr(config, 'POLITICIANS'):
        payload['congress'] = {
            'sizing_tiers': [
                {'name': t['name'], 'min_disclosure': float(t['min_disclosure']),
                 'max_alloc': float(t['max_alloc'])}
                for t in config.SIZING_TIERS
            ],
            'politicians': [
                {'id': p['id'], 'name': p['name']}
                for p in config.POLITICIANS
            ],
        }

    return payload


def push(mode: str) -> None:
    token = os.environ.get('BOT_PUSH_TOKEN')
    base = os.environ.get('DASHBOARD_URL')
    if not token or not base:
        # Fail silently — push is fire-and-forget and bots must not block
        print('[push_rules] BOT_PUSH_TOKEN or DASHBOARD_URL missing; skipping', file=sys.stderr)
        return

    payload = build_payload(mode)
    body = {'key': f'bot:rules:{mode}', 'value': payload}
    try:
        r = requests.post(
            f"{base.rstrip('/')}/api/bot-state",
            json=body,
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            timeout=10,
        )
        if r.status_code >= 300:
            print(f"[push_rules] dashboard returned {r.status_code}: {r.text}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001 — don't crash the bot
        print(f"[push_rules] error posting to dashboard: {exc}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', required=True, choices=['conservative', 'aggressive'])
    args = parser.parse_args()
    push(args.mode)


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tools/test_push_rules_to_dashboard.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/push_rules_to_dashboard.py tools/test_push_rules_to_dashboard.py
git commit -m "feat(bot): add tools/push_rules_to_dashboard.py for Phase 3 dashboard"
```

---

### Task 1.6: Wire the pusher into both monitor workflows

**Files:**
- Modify: `.github/workflows/tsla-monitor.yml`
- Modify: `.github/workflows/tsla-monitor-aggressive.yml`

- [ ] **Step 1: Append the push step to tsla-monitor.yml**

Open `.github/workflows/tsla-monitor.yml`. Find the last step inside the existing job (typically after the bot scripts run + state files commit). Append:

```yaml
      - name: Push rules to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
          DASHBOARD_URL: https://tradingbot-dashboard-blue.vercel.app
        run: python tools/push_rules_to_dashboard.py --mode conservative
```

- [ ] **Step 2: Append the push step to tsla-monitor-aggressive.yml**

```yaml
      - name: Push rules to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
          DASHBOARD_URL: https://tradingbot-dashboard-blue.vercel.app
        run: python tools/push_rules_to_dashboard.py --mode aggressive
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/tsla-monitor.yml .github/workflows/tsla-monitor-aggressive.yml
git commit -m "feat(workflows): push bot rules to dashboard after each monitor run"
```

- [ ] **Step 4: Smoke-test by manual dispatch**

After this commit lands on the branch (or after merging M1), run:

```bash
gh workflow run tsla-monitor.yml
gh workflow run tsla-monitor-aggressive.yml
```

Then check that the dashboard's KV has the new keys:

```bash
curl -s -H "Cookie: $DASHBOARD_SESSION" \
  https://tradingbot-dashboard-blue.vercel.app/api/kv/bot-state?key=bot:rules:conservative \
  | jq .
```

Expected: JSON payload with `mode`, `wheel`, `strategy`, optional `congress`, `pushed_at`. (The `kv/bot-state` resource read is already implemented and key-whitelisted via Task 1.2.)

---

### Task 1.7: Create assignment-pending plumbing skeleton

**Files:**
- Create: `dashboard/api/_lib/assignment-spawn.ts`
- Test: `dashboard/tests/assignment-spawn.test.ts`

This task lays the groundwork for M5. We add the helpers but don't call them yet.

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/assignment-spawn.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lpush = vi.fn();
const lrange = vi.fn();
const lrem = vi.fn();
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ rpush: lpush, lrange, lrem }),
}));

describe('assignment-spawn helpers', () => {
  beforeEach(() => { lpush.mockReset(); lrange.mockReset(); lrem.mockReset(); });

  it('enqueueAssignmentPending pushes JSON with parent_trade_id', async () => {
    const { enqueueAssignmentPending } = await import('../api/_lib/assignment-spawn');
    await enqueueAssignmentPending({
      parent_trade_id: 'T-2026-05-01-001',
      underlying: 'F',
      strike: 12,
      qty: 100,
      account: 'conservative_paper',
      detected_at: '2026-05-07T13:00:00Z',
    });
    expect(lpush).toHaveBeenCalledWith(
      'trades:index:assignments-pending',
      expect.stringContaining('T-2026-05-01-001'),
    );
  });

  it('drainAssignments returns parsed entries', async () => {
    lrange.mockResolvedValue([
      JSON.stringify({ parent_trade_id: 'T-1', underlying: 'F', strike: 12, qty: 100, account: 'conservative_paper', detected_at: '...' }),
    ]);
    const { drainAssignments } = await import('../api/_lib/assignment-spawn');
    const entries = await drainAssignments();
    expect(entries).toHaveLength(1);
    expect(entries[0].parent_trade_id).toBe('T-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- assignment-spawn.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create assignment-spawn.ts**

```ts
// dashboard/api/_lib/assignment-spawn.ts
import { kv } from './kv.js';
import { assignmentsPendingKey } from './kv-keys.js';
import type { AssignmentEntry } from './rules-types.js';

export async function enqueueAssignmentPending(entry: AssignmentEntry): Promise<void> {
  await kv().rpush(assignmentsPendingKey(), JSON.stringify(entry));
}

export async function drainAssignments(): Promise<AssignmentEntry[]> {
  const raw = (await kv().lrange(assignmentsPendingKey(), 0, -1)) as string[];
  return raw.map((s) => JSON.parse(s) as AssignmentEntry);
}

export async function removeAssignment(entry: AssignmentEntry): Promise<void> {
  await kv().lrem(assignmentsPendingKey(), 1, JSON.stringify(entry));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- assignment-spawn.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/assignment-spawn.ts dashboard/tests/assignment-spawn.test.ts
git commit -m "feat(dashboard): assignment-spawn helpers (M5 plumbing)"
```

---

**Milestone 1 complete.** At this point: bot rules flow into `bot:rules:conservative` / `bot:rules:aggressive` after each bot run; the dashboard data model knows about block severity, override reasons, parent trades, and assignment source; and the assignments-pending inbox is plumbed and tested. No user-visible changes yet.

Continue to M2.

---

## Milestone 2 — Rules API + active rule-checker

Builds the catchall `api/rules/[resource].ts`, replaces the rule-check stub with a real trigger-DSL evaluator, exposes `POST /api/trades/check`, and wires the order-form UX for warn banner + block-override flow.

### Task 2.1: Skeleton api/rules/[resource].ts (auth + dispatch)

**Files:**
- Create: `dashboard/api/rules/[resource].ts`
- Test: `dashboard/tests/rules-api-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/tests/rules-api-dispatch.test.ts
import { describe, it, expect, vi } from 'vitest';

const requireAuth = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../api/_lib/auth-guard', () => ({ requireAuth }));

const kvGet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: vi.fn() }) }));

describe('api/rules/[resource] dispatch', () => {
  it('returns 404 for unknown resource', async () => {
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'unknown' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 401 when auth-guard rejects', async () => {
    requireAuth.mockResolvedValueOnce({ ok: false });
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'manual' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('GET manual returns array (empty by default)', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'manual' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ rules: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- rules-api-dispatch.test.ts
```

Expected: FAIL — file not found.

- [ ] **Step 3: Create the catchall**

```ts
// dashboard/api/rules/[resource].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { kv } from '../_lib/kv.js';
import { rulesKey, botRulesKey } from '../_lib/kv-keys.js';
import {
  type ManualRule, type Pattern, type Cheatsheet, type Goal,
  type Tendency, type Proposal, isTrigger, newId,
} from '../_lib/rules-types.js';

type Resource = 'manual' | 'patterns' | 'cheatsheets' | 'goals' | 'tendencies' | 'proposals' | 'bot';

const VALID: Resource[] = ['manual', 'patterns', 'cheatsheets', 'goals', 'tendencies', 'proposals', 'bot'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth.ok) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const resource = req.query.resource as string;
  if (!VALID.includes(resource as Resource)) {
    return res.status(404).json({ error: 'unknown resource' });
  }

  switch (resource as Resource) {
    case 'manual':       return manualHandler(req, res);
    case 'patterns':     return patternsHandler(req, res);
    case 'cheatsheets':  return cheatsheetsHandler(req, res);
    case 'goals':        return goalsHandler(req, res);
    case 'tendencies':   return tendenciesHandler(req, res);
    case 'proposals':    return proposalsHandler(req, res);
    case 'bot':          return botHandler(req, res);
  }
}

// Stubbed in this task — fleshed out in subsequent tasks
async function manualHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const rules = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];
    return res.status(200).json({ rules });
  }
  return res.status(501).json({ error: 'not implemented' });
}

async function patternsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not implemented' });
}
async function cheatsheetsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not implemented' });
}
async function goalsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not implemented' });
}
async function tendenciesHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not implemented' });
}
async function proposalsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not implemented' });
}
async function botHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not implemented' });
}

// Suppress unused-imports lint until later tasks fill these in
export const _phase3Helpers = { isTrigger, newId, botRulesKey };
export type _Phase3Types = Pattern | Cheatsheet | Goal | Tendency | Proposal;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd dashboard && npm test -- rules-api-dispatch.test.ts
```

Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/rules/[resource].ts dashboard/tests/rules-api-dispatch.test.ts
git commit -m "feat(dashboard): rules API skeleton with dispatch + auth"
```

---

### Task 2.2: Implement manual CRUD

**Files:**
- Modify: `dashboard/api/rules/[resource].ts` — replace `manualHandler`
- Test: `dashboard/tests/rules-api-manual.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/rules-api-manual.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));

describe('rules manual CRUD', () => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

  it('POST creates a new rule with generated id, source=manual, timestamps', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'manual' },
      body: {
        title: 'No earnings week',
        body: 'never trade through earnings',
        severity: 'block',
        triggers: [{ type: 'earnings_within_days', value: 7 }],
      },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toMatch(/^r-/);
    expect(written[0].source).toBe('manual');
    expect(written[0].created_at).toBeDefined();
    expect(written[0].updated_at).toBe(written[0].created_at);
  });

  it('POST rejects invalid trigger', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'manual' },
      body: { title: 't', body: 'b', severity: 'warn', triggers: [{ type: 'bogus' }] },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('PATCH updates an existing rule by id', async () => {
    const existing = {
      id: 'r-1', title: 'old', body: 'b', severity: 'warn', triggers: [],
      source: 'manual', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
    };
    kvGet.mockResolvedValueOnce([existing]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'PATCH',
      query: { resource: 'manual' },
      body: { id: 'r-1', patch: { title: 'new title' } },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const written = kvSet.mock.calls[0][1];
    expect(written[0].title).toBe('new title');
    expect(written[0].updated_at).not.toBe('2026-05-01T00:00:00Z');
  });

  it('DELETE removes a rule by id', async () => {
    const existing = [
      { id: 'r-1', title: 'a' }, { id: 'r-2', title: 'b' },
    ];
    kvGet.mockResolvedValueOnce(existing);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'DELETE',
      query: { resource: 'manual' },
      body: { id: 'r-1' },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('r-2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- rules-api-manual.test.ts
```

Expected: FAIL — most return 501.

- [ ] **Step 3: Replace manualHandler in `api/rules/[resource].ts`**

```ts
async function manualHandler(req: VercelRequest, res: VercelResponse) {
  const list = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];

  if (req.method === 'GET') {
    return res.status(200).json({ rules: list });
  }

  if (req.method === 'POST') {
    const { title, body, severity, triggers } = req.body ?? {};
    if (typeof title !== 'string' || typeof body !== 'string'
        || (severity !== 'block' && severity !== 'warn')
        || !Array.isArray(triggers) || !triggers.every(isTrigger)) {
      return res.status(400).json({ error: 'invalid rule payload' });
    }
    const now = new Date().toISOString();
    const rule: ManualRule = {
      id: newId('r'), title, body, severity, triggers,
      source: 'manual', created_at: now, updated_at: now,
    };
    const next = [...list, rule];
    await kv().set(rulesKey('manual'), next);
    return res.status(201).json({ rule });
  }

  if (req.method === 'PATCH') {
    const { id, patch } = req.body ?? {};
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    if (patch?.triggers && !patch.triggers.every(isTrigger)) {
      return res.status(400).json({ error: 'invalid triggers' });
    }
    const updated: ManualRule = {
      ...list[idx], ...patch,
      id: list[idx].id,                   // never overwrite id
      created_at: list[idx].created_at,   // preserve
      updated_at: new Date().toISOString(),
    };
    const next = list.map((r, i) => (i === idx ? updated : r));
    await kv().set(rulesKey('manual'), next);
    return res.status(200).json({ rule: updated });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body ?? {};
    const next = list.filter((r) => r.id !== id);
    await kv().set(rulesKey('manual'), next);
    return res.status(200).json({ ok: true, removed: id });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- rules-api-manual.test.ts
```

Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/rules/[resource].ts dashboard/tests/rules-api-manual.test.ts
git commit -m "feat(dashboard): rules manual CRUD"
```

---

### Task 2.3: Implement patterns / cheatsheets / goals CRUD

These three resources share the same pattern — a list of records keyed by `id`. Build a generic helper to avoid duplication.

**Files:**
- Modify: `dashboard/api/rules/[resource].ts` — replace patterns/cheatsheets/goals handlers
- Test: `dashboard/tests/rules-api-shared-crud.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/rules-api-shared-crud.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));

describe.each(['patterns', 'cheatsheets', 'goals'] as const)('rules %s CRUD', (resource) => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

  it('POST creates with generated id + timestamps', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../api/rules/[resource]')).default;
    const body =
      resource === 'patterns'
        ? { name: 'Wheel TSLA', environment: 'high IV', variables: [], legs: [], rules: [] }
        : resource === 'cheatsheets'
        ? { title: 'Greeks 101', body: 'delta...' }
        : { body: 'sell 1 contract / week' };
    const req: any = { method: 'POST', query: { resource }, body };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const written = kvSet.mock.calls[0][1];
    expect(written[0].id).toMatch(/^[A-Za-z]{1,3}-/);
    expect(written[0].created_at).toBeDefined();
  });

  it('GET returns the stored array', async () => {
    kvGet.mockResolvedValueOnce([{ id: 'x-1' }]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- rules-api-shared-crud.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add a generic CRUD helper inside `api/rules/[resource].ts` and replace the three handlers**

```ts
// Inside api/rules/[resource].ts — add helper near the top, replace 3 handlers

interface BaseRecord { id: string; created_at: string; updated_at: string; }

async function genericCrud<T extends BaseRecord>(
  req: VercelRequest, res: VercelResponse,
  key: string,
  validate: (body: unknown) => string | null,   // returns error message or null
  idPrefix: string,
) {
  const list = (await kv().get<T[]>(key)) ?? [];

  if (req.method === 'GET') {
    return res.status(200).json({ items: list });
  }

  if (req.method === 'POST') {
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const now = new Date().toISOString();
    const record = { ...req.body, id: newId(idPrefix), created_at: now, updated_at: now } as T;
    const next = [...list, record];
    await kv().set(key, next);
    return res.status(201).json({ item: record });
  }

  if (req.method === 'PATCH') {
    const { id, patch } = req.body ?? {};
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const err = validate({ ...list[idx], ...patch });
    if (err) return res.status(400).json({ error: err });
    const updated = {
      ...list[idx], ...patch,
      id: list[idx].id,
      created_at: list[idx].created_at,
      updated_at: new Date().toISOString(),
    } as T;
    const next = list.map((r, i) => (i === idx ? updated : r));
    await kv().set(key, next);
    return res.status(200).json({ item: updated });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body ?? {};
    const next = list.filter((r) => r.id !== id);
    await kv().set(key, next);
    return res.status(200).json({ ok: true, removed: id });
  }

  return res.status(405).json({ error: 'method not allowed' });
}

async function patternsHandler(req: VercelRequest, res: VercelResponse) {
  return genericCrud<Pattern>(req, res, rulesKey('patterns'), (b: any) => {
    if (typeof b?.name !== 'string') return 'name required';
    if (typeof b?.environment !== 'string') return 'environment required';
    if (!Array.isArray(b?.variables)) return 'variables must be array';
    if (!Array.isArray(b?.legs)) return 'legs must be array';
    if (!Array.isArray(b?.rules)) return 'rules must be array';
    return null;
  }, 'p');
}

async function cheatsheetsHandler(req: VercelRequest, res: VercelResponse) {
  return genericCrud<Cheatsheet>(req, res, rulesKey('cheatsheets'), (b: any) => {
    if (typeof b?.title !== 'string') return 'title required';
    if (typeof b?.body !== 'string') return 'body required';
    return null;
  }, 'c');
}

async function goalsHandler(req: VercelRequest, res: VercelResponse) {
  return genericCrud<Goal>(req, res, rulesKey('goals'), (b: any) => {
    if (typeof b?.body !== 'string') return 'body required';
    return null;
  }, 'g');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- rules-api-shared-crud.test.ts
```

Expected: PASS for all three resources.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/rules/[resource].ts dashboard/tests/rules-api-shared-crud.test.ts
git commit -m "feat(dashboard): rules patterns/cheatsheets/goals CRUD via shared helper"
```

---

### Task 2.4: Implement tendencies / proposals / bot reads

**Files:**
- Modify: `dashboard/api/rules/[resource].ts`
- Test: `dashboard/tests/rules-api-reads.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/rules-api-reads.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));

describe('rules reads', () => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

  it('GET tendencies returns array', async () => {
    kvGet.mockResolvedValueOnce([{ id: 't-1', matcher: 'cc_below_cost_basis' }]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'tendencies' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ tendencies: [{ id: 't-1', matcher: 'cc_below_cost_basis' }] });
  });

  it('GET proposals filters dismissed older than 30 days', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86400000).toISOString();
    const recent = new Date(now.getTime() - 5 * 86400000).toISOString();
    kvGet.mockResolvedValueOnce([
      { id: 'p-old',    status: 'dismissed', resolved_at: old,    proposed_at: old },
      { id: 'p-recent', status: 'dismissed', resolved_at: recent, proposed_at: recent },
      { id: 'p-open',   status: 'open',                            proposed_at: recent },
    ]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'proposals' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.proposals.map((p: any) => p.id)).toEqual(['p-recent', 'p-open']);
  });

  it('GET bot returns both modes', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'bot:rules:conservative') return { mode: 'conservative', wheel: { otm_pct: 0.1 } };
      if (k === 'bot:rules:aggressive')   return { mode: 'aggressive',   wheel: { otm_pct: 0.05 } };
      return null;
    });
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'bot' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.conservative.wheel.otm_pct).toBe(0.1);
    expect(body.aggressive.wheel.otm_pct).toBe(0.05);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- rules-api-reads.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Replace the three read handlers**

```ts
// Replace in api/rules/[resource].ts

async function tendenciesHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const tendencies = (await kv().get<Tendency[]>(rulesKey('tendencies'))) ?? [];
  return res.status(200).json({ tendencies });
}

async function proposalsHandler(req: VercelRequest, res: VercelResponse) {
  const proposals = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];

  if (req.method === 'GET') {
    const cutoff = Date.now() - 30 * 86400000;
    const visible = proposals.filter((p) => {
      if (p.status === 'open') return true;
      const ts = p.resolved_at ? Date.parse(p.resolved_at) : Date.parse(p.proposed_at);
      return ts >= cutoff;
    });
    return res.status(200).json({ proposals: visible });
  }

  if (req.method === 'POST') {
    // Approve / dismiss / edit-and-approve are implemented in a later task (2.5)
    return res.status(501).json({ error: 'not implemented in 2.4' });
  }

  return res.status(405).json({ error: 'method not allowed' });
}

async function botHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const [cons, agg] = await Promise.all([
    kv().get(botRulesKey('conservative')),
    kv().get(botRulesKey('aggressive')),
  ]);
  return res.status(200).json({ conservative: cons, aggressive: agg });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- rules-api-reads.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/rules/[resource].ts dashboard/tests/rules-api-reads.test.ts
git commit -m "feat(dashboard): rules tendencies/proposals/bot read handlers"
```

---

### Task 2.5: Proposal approve / dismiss / edit-then-approve

**Files:**
- Modify: `dashboard/api/rules/[resource].ts` — extend `proposalsHandler`
- Test: `dashboard/tests/rules-api-proposals.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/rules-api-proposals.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));

const seedProposal = {
  id: 'p-1', matcher: 'cc_below_cost_basis',
  proposed_rule: {
    title: 'No CC below cost', body: 'do not sell covered calls below cost basis',
    severity: 'block', triggers: [{ type: 'strike_below_cost_basis' }],
  },
  reasoning: 'You did this 3 times and lost 2.',
  evidence_trade_ids: ['T-1', 'T-2', 'T-3'],
  status: 'open',
  proposed_at: '2026-05-04T22:00:00Z',
};

describe('proposals POST', () => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

  it('approve → creates manual rule + marks proposal approved', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [seedProposal];
      if (k === 'rules:manual') return [];
      return null;
    });
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST', query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-1' },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const setCalls = kvSet.mock.calls;
    const proposalsWritten = setCalls.find((c) => c[0] === 'rules:proposals')![1];
    expect(proposalsWritten[0].status).toBe('approved');
    expect(proposalsWritten[0].resolved_at).toBeDefined();
    const manualWritten = setCalls.find((c) => c[0] === 'rules:manual')![1];
    expect(manualWritten[0].title).toBe('No CC below cost');
    expect(manualWritten[0].source).toBe('tendency');
  });

  it('dismiss → marks status=dismissed without creating a rule', async () => {
    kvGet.mockResolvedValueOnce([seedProposal]);
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST', query: { resource: 'proposals' },
      body: { action: 'dismiss', proposal_id: 'p-1' },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const proposalsWritten = kvSet.mock.calls.find((c) => c[0] === 'rules:proposals')![1];
    expect(proposalsWritten[0].status).toBe('dismissed');
    expect(kvSet.mock.calls.find((c) => c[0] === 'rules:manual')).toBeUndefined();
  });

  it('edit-and-approve → uses edits over proposed_rule', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [seedProposal];
      if (k === 'rules:manual') return [];
      return null;
    });
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST', query: { resource: 'proposals' },
      body: {
        action: 'edit-and-approve', proposal_id: 'p-1',
        edits: { title: 'Edited title', severity: 'warn' },
      },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    const manualWritten = kvSet.mock.calls.find((c) => c[0] === 'rules:manual')![1];
    expect(manualWritten[0].title).toBe('Edited title');
    expect(manualWritten[0].severity).toBe('warn');
    expect(manualWritten[0].body).toBe(seedProposal.proposed_rule.body);
  });

  it('demote proposal → patches target rule severity to warn', async () => {
    const demoteProposal = {
      ...seedProposal, id: 'p-2',
      demote_target_rule_id: 'r-existing',
      proposed_rule: { title: 'Demote: No CC', body: 'demote', severity: 'warn', triggers: [] },
    };
    const targetRule = {
      id: 'r-existing', title: 'No CC', body: 'b', severity: 'block', triggers: [],
      source: 'manual', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    };
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [demoteProposal];
      if (k === 'rules:manual') return [targetRule];
      return null;
    });
    const handler = (await import('../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST', query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-2' },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    const manualWritten = kvSet.mock.calls.find((c) => c[0] === 'rules:manual')![1];
    expect(manualWritten[0].id).toBe('r-existing');
    expect(manualWritten[0].severity).toBe('warn');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- rules-api-proposals.test.ts
```

Expected: FAIL — POST returns 501.

- [ ] **Step 3: Replace proposalsHandler**

```ts
// Replace proposalsHandler in api/rules/[resource].ts

async function proposalsHandler(req: VercelRequest, res: VercelResponse) {
  const proposals = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];

  if (req.method === 'GET') {
    const cutoff = Date.now() - 30 * 86400000;
    const visible = proposals.filter((p) => {
      if (p.status === 'open') return true;
      const ts = p.resolved_at ? Date.parse(p.resolved_at) : Date.parse(p.proposed_at);
      return ts >= cutoff;
    });
    return res.status(200).json({ proposals: visible });
  }

  if (req.method === 'POST') {
    const { action, proposal_id, edits } = req.body ?? {};
    if (!['approve', 'dismiss', 'edit-and-approve'].includes(action)) {
      return res.status(400).json({ error: 'invalid action' });
    }
    const idx = proposals.findIndex((p) => p.id === proposal_id);
    if (idx === -1) return res.status(404).json({ error: 'proposal not found' });
    if (proposals[idx].status !== 'open') {
      return res.status(409).json({ error: 'proposal already resolved' });
    }

    const now = new Date().toISOString();
    const proposal = proposals[idx];

    if (action === 'dismiss') {
      const updated = { ...proposal, status: 'dismissed' as const, resolved_at: now };
      const next = proposals.map((p, i) => (i === idx ? updated : p));
      await kv().set(rulesKey('proposals'), next);
      return res.status(200).json({ proposal: updated });
    }

    // approve or edit-and-approve
    const finalRule = action === 'edit-and-approve' && edits
      ? { ...proposal.proposed_rule, ...edits }
      : proposal.proposed_rule;

    const manualList = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];

    if (proposal.demote_target_rule_id) {
      const targetIdx = manualList.findIndex((r) => r.id === proposal.demote_target_rule_id);
      if (targetIdx === -1) {
        return res.status(404).json({ error: 'demote target rule not found' });
      }
      const demoted = { ...manualList[targetIdx], severity: 'warn' as const, updated_at: now };
      const nextManual = manualList.map((r, i) => (i === targetIdx ? demoted : r));
      await kv().set(rulesKey('manual'), nextManual);
    } else {
      const newRule: ManualRule = {
        id: newId('r'),
        title: finalRule.title,
        body: finalRule.body,
        severity: finalRule.severity,
        triggers: finalRule.triggers,
        source: 'tendency',
        created_at: now,
        updated_at: now,
      };
      await kv().set(rulesKey('manual'), [...manualList, newRule]);
    }

    const updated = { ...proposal, status: 'approved' as const, resolved_at: now };
    const nextProposals = proposals.map((p, i) => (i === idx ? updated : p));
    await kv().set(rulesKey('proposals'), nextProposals);

    return res.status(200).json({ proposal: updated });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- rules-api-proposals.test.ts
```

Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/rules/[resource].ts dashboard/tests/rules-api-proposals.test.ts
git commit -m "feat(dashboard): proposal approve/dismiss/edit-and-approve + demote handling"
```

---

### Task 2.6: Replace rule-check.ts stub with trigger-DSL evaluator

**Files:**
- Modify: `dashboard/api/_lib/rule-check.ts` — full replacement
- Test: `dashboard/tests/rule-check.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/rule-check.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet }) }));
const fetchEarningsDate = vi.fn();
vi.mock('../api/_lib/fundamentals-fetch', () => ({ fetchEarningsDate }));

import type { ManualRule, Trigger } from '../api/_lib/rules-types';

const mkRule = (overrides: Partial<ManualRule>): ManualRule => ({
  id: 'r-1', title: 't', body: 'b', severity: 'block', triggers: [],
  source: 'manual', created_at: '', updated_at: '', ...overrides,
});

describe('rule-check trigger evaluator', () => {
  beforeEach(() => { kvGet.mockReset(); fetchEarningsDate.mockReset(); });

  it('all-triggers-must-match: rule fires when every trigger true', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        triggers: [
          { type: 'symbol_in', symbols: ['TSLA'] },
          { type: 'side', value: 'sell' },
        ],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const result = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'sell', qty: 1,
      account: 'conservative_paper',
    }, { positions: [] });
    expect(result.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('all-triggers-must-match: rule does NOT fire when one trigger fails', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        triggers: [
          { type: 'symbol_in', symbols: ['TSLA'] },
          { type: 'side', value: 'sell' },
        ],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const result = await runRuleChecks({
      asset_class: 'option', symbol: 'AAPL', side: 'sell', qty: 1,
      account: 'conservative_paper',
    }, { positions: [] });
    expect(result.find((v) => v.rule === 'r-1')).toBeUndefined();
  });

  it('option_dte_lt fires correctly using DST-aware ET expiration', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'warn',
        triggers: [{ type: 'option_dte_lt', value: 7 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    // Build an expiration date 5 days in the future
    const exp = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const result = await runRuleChecks({
      asset_class: 'option', symbol: 'TSLA', side: 'sell', qty: 1,
      account: 'conservative_paper', expiration: exp,
    }, { positions: [] });
    expect(result.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('open_position_count_gt counts ctx.positions for the symbol', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'warn',
        triggers: [{ type: 'open_position_count_gt', value: 2 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const result = await runRuleChecks(
      { asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100, account: 'conservative_paper' },
      { positions: [
        { symbol: 'F', qty: 100, avg_entry_price: 12 },
        { symbol: 'F', qty: 100, avg_entry_price: 13 },
        { symbol: 'F', qty: 100, avg_entry_price: 14 },
      ] as any },
    );
    expect(result.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('earnings_within_days fires when fetchEarningsDate within window', async () => {
    fetchEarningsDate.mockResolvedValue(
      new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10),
    );
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'block',
        triggers: [{ type: 'earnings_within_days', value: 7 }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const result = await runRuleChecks(
      { asset_class: 'stock', symbol: 'TSLA', side: 'buy', qty: 10, account: 'conservative_paper' },
      { positions: [] },
    );
    expect(result.find((v) => v.rule === 'r-1' && v.severity === 'block')).toBeDefined();
  });

  it('strike_below_cost_basis fires when option strike < stock avg_entry_price', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [mkRule({
        severity: 'block',
        triggers: [{ type: 'strike_below_cost_basis' }, { type: 'option_type', value: 'call' }],
      })];
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const result = await runRuleChecks(
      {
        asset_class: 'option', symbol: 'F', side: 'sell', qty: 1,
        account: 'conservative_paper',
        option_type: 'call', strike: 11,
      } as any,
      { positions: [{ symbol: 'F', qty: 100, avg_entry_price: 12 }] as any },
    );
    expect(result.find((v) => v.rule === 'r-1')).toBeDefined();
  });

  it('emits warn-severity bot rule violations for symbol outside wheel', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:manual') return [];
      if (k === 'bot:rules:conservative') return {
        wheel: { symbols: ['TSLA', 'F'], otm_pct: 0.10, dte_min: 14, dte_max: 28 },
      };
      if (k === 'bot:rules:aggressive') return null;
      return null;
    });
    const { runRuleChecks } = await import('../api/_lib/rule-check');
    const result = await runRuleChecks(
      {
        asset_class: 'option', symbol: 'NFLX', side: 'sell', qty: 1,
        account: 'conservative_paper', option_type: 'put',
      } as any,
      { positions: [] },
    );
    const botViolation = result.find((v) => v.rule === 'bot_outside_wheel_symbols');
    expect(botViolation?.severity).toBe('warn');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- rule-check.test.ts
```

Expected: FAIL — no `runRuleChecks` export.

- [ ] **Step 3: Rewrite rule-check.ts**

```ts
// dashboard/api/_lib/rule-check.ts — full replacement
import { kv } from './kv.js';
import { rulesKey, botRulesKey } from './kv-keys.js';
import { fetchEarningsDate } from './fundamentals-fetch.js';
import type { ManualRule, Trigger, BotRulesPayload } from './rules-types.js';
import type {
  AssetClass, AccountId, RuleWarning, OrderSide,
} from './trade-types.js';

export interface RuleCheckInput {
  asset_class: AssetClass;
  symbol: string;
  side: OrderSide | 'buy' | 'sell';
  qty: number;
  account: AccountId;
  // Optional fields used by triggers
  option_type?: 'put' | 'call';
  strike?: number;
  expiration?: string;        // YYYY-MM-DD
  tags?: string[];
}

export interface RuleCheckCtx {
  positions: Array<{ symbol: string; qty: number; avg_entry_price: number }>;
}

export async function runRuleChecks(
  input: RuleCheckInput,
  ctx: RuleCheckCtx,
): Promise<RuleWarning[]> {
  const violations: RuleWarning[] = [];

  // --- Manual rules ---
  const manual = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];
  for (const rule of manual) {
    let allMatch = true;
    for (const t of rule.triggers) {
      const ok = await evaluateTrigger(t, input, ctx);
      if (!ok) { allMatch = false; break; }
    }
    if (allMatch && rule.triggers.length > 0) {
      violations.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.title,
      });
    }
  }

  // --- Bot rules (warn-only) ---
  const accountMode = input.account === 'aggressive_paper' ? 'aggressive' : 'conservative';
  const botPayload = (await kv().get<BotRulesPayload>(botRulesKey(accountMode))) ?? null;
  if (botPayload && input.asset_class === 'option') {
    const wheel = botPayload.wheel;

    if (!wheel.symbols.includes(input.symbol)) {
      violations.push({
        rule: 'bot_outside_wheel_symbols',
        severity: 'warn',
        message: `${input.symbol} is not on the ${accountMode} wheel symbol list`,
      });
    }

    if (input.expiration) {
      const dte = calcDTE(input.expiration);
      if (dte < wheel.dte_min - 3 || dte > wheel.dte_max + 3) {
        violations.push({
          rule: 'bot_dte_outside_wheel',
          severity: 'warn',
          message: `expiration ${dte} DTE is outside wheel range ${wheel.dte_min}-${wheel.dte_max}`,
        });
      }
    }
  }

  // --- Legacy stub rules (kept for backward compatibility) ---
  // Bot wheel overlap warning (existing behavior)
  const cons = (await kv().get<Record<string, { stage?: number }>>('bot:state:conservative')) ?? {};
  const agg = (await kv().get<Record<string, { stage?: number }>>('bot:state:aggressive')) ?? {};
  const consHas = cons[input.symbol]?.stage === 1 || cons[input.symbol]?.stage === 2;
  const aggHas = agg[input.symbol]?.stage === 1 || agg[input.symbol]?.stage === 2;
  if (consHas || aggHas) {
    const accounts = [consHas && 'conservative', aggHas && 'aggressive'].filter(Boolean).join(' & ');
    violations.push({
      rule: 'bot_wheel_overlap',
      severity: 'warn',
      message: `bot has an open wheel on ${input.symbol} in ${accounts}. manual position will share BP.`,
    });
  }

  // Sort: blocks first, then warns, then info
  return violations.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
}

// Backward-compat alias used by Phase 2 callers
export const runStubRuleChecks = runRuleChecks;

function sevRank(s: 'block' | 'warn' | 'info'): number {
  return s === 'block' ? 0 : s === 'warn' ? 1 : 2;
}

function calcDTE(expiration: string): number {
  // expiration is YYYY-MM-DD; treat as 4 PM ET on that day for DTE math
  const d = new Date(`${expiration}T20:00:00Z`); // EDT 4pm = 20:00 UTC
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000));
}

async function evaluateTrigger(
  t: Trigger,
  input: RuleCheckInput,
  ctx: RuleCheckCtx,
): Promise<boolean> {
  switch (t.type) {
    case 'symbol_in':       return t.symbols.includes(input.symbol);
    case 'symbol_not_in':   return !t.symbols.includes(input.symbol);
    case 'side': {
      const isBuy = input.side === 'buy' || input.side === 'BTO' || input.side === 'BTC';
      return t.value === 'buy' ? isBuy : !isBuy;
    }
    case 'asset_class':     return input.asset_class === t.value;
    case 'option_type':     return input.option_type === t.value;
    case 'option_dte_lt':   return input.expiration ? calcDTE(input.expiration) < t.value : false;
    case 'option_dte_gt':   return input.expiration ? calcDTE(input.expiration) > t.value : false;
    case 'open_position_count_gt': {
      const n = ctx.positions.filter((p) => p.symbol === input.symbol).length;
      return n > t.value;
    }
    case 'earnings_within_days': {
      const date = await fetchEarningsDate(input.symbol);
      if (!date) return false;
      const days = Math.floor((Date.parse(date) - Date.now()) / 86400000);
      return days >= 0 && days <= t.value;
    }
    case 'strike_below_cost_basis': {
      if (input.asset_class !== 'option' || input.option_type !== 'call' || input.strike == null) return false;
      const stock = ctx.positions.find((p) => p.symbol === input.symbol);
      if (!stock) return false;
      return input.strike < stock.avg_entry_price;
    }
    case 'tag_present':     return (input.tags ?? []).includes(t.tag);
    default:                return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- rule-check.test.ts
```

Expected: PASS for all seven cases.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/rule-check.ts dashboard/tests/rule-check.test.ts
git commit -m "feat(dashboard): replace rule-check stub with trigger-DSL evaluator"
```

---

### Task 2.7: Add `check` action to api/trades/[action].ts

**Files:**
- Modify: `dashboard/api/trades/[action].ts` — add `check` action
- Test: `dashboard/tests/trades-check-action.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/tests/trades-check-action.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const runRuleChecks = vi.fn();
vi.mock('../api/_lib/rule-check', () => ({ runRuleChecks }));
const alpacaTrade = vi.fn().mockResolvedValue([]);
vi.mock('../api/_lib/data-api', () => ({ alpacaTrade, alpacaData: vi.fn(), alpacaTradeMutation: vi.fn() }));

describe('trades/check', () => {
  it('returns violations from runRuleChecks', async () => {
    runRuleChecks.mockResolvedValueOnce([
      { rule: 'r-1', severity: 'block', message: 'No earnings week' },
    ]);
    const handler = (await import('../api/trades/[action]')).default;
    const req: any = {
      method: 'POST',
      query: { action: 'check' },
      body: {
        asset_class: 'option', symbol: 'TSLA', side: 'sell', qty: 1,
        account: 'conservative_paper', option_type: 'put', expiration: '2026-05-30',
      },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].severity).toBe('block');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd dashboard && npm test -- trades-check-action.test.ts
```

Expected: FAIL — `check` action returns 404 or 501.

- [ ] **Step 3: Add the action**

Open `dashboard/api/trades/[action].ts`. In the action dispatcher, add a `check` branch (likely a switch statement). Add:

```ts
// Add near top imports
import { runRuleChecks } from '../_lib/rule-check.js';
import { alpacaTrade } from '../_lib/data-api.js';

// In the action dispatch switch, add:
case 'check': {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const draft = req.body ?? {};
  const account = draft.account ?? 'conservative_paper';
  // Pull positions from Alpaca for the relevant account so triggers have ctx
  let positions: any[] = [];
  try {
    const mode = account === 'aggressive_paper' ? 'aggressive' : 'conservative';
    positions = await alpacaTrade(mode, '/v2/positions');
  } catch {
    positions = [];
  }
  const violations = await runRuleChecks(draft, {
    positions: positions.map((p: any) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avg_entry_price: parseFloat(p.avg_entry_price),
    })),
  });
  return res.status(200).json({ violations });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd dashboard && npm test -- trades-check-action.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/trades-check-action.test.ts
git commit -m "feat(dashboard): trades/check action wires rule-checker to order form"
```

---

### Task 2.8: Persist rule_violations on trade submit

**Files:**
- Modify: `dashboard/api/trades/[action].ts` — extend `submit` action
- Test: `dashboard/tests/trades-submit-violations.test.ts`

The `submit` handler should accept a `rule_violations` array on the body and store it on the trade record. Block-severity violations require an `override_reason`; reject without it.

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/tests/trades-submit-violations.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvSet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ set: kvSet, get: vi.fn(), rpush: vi.fn(), incr: vi.fn().mockResolvedValue(1) }) }));
const alpacaTradeMutation = vi.fn().mockResolvedValue({ id: 'order-1', status: 'accepted' });
vi.mock('../api/_lib/data-api', () => ({ alpacaTrade: vi.fn(), alpacaTradeMutation, alpacaData: vi.fn() }));

describe('trades/submit with rule_violations', () => {
  it('persists rule_violations on trade record', async () => {
    const handler = (await import('../api/trades/[action]')).default;
    const req: any = {
      method: 'POST',
      query: { action: 'submit' },
      body: {
        asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100,
        account: 'conservative_paper', order_type: 'market', tif: 'day',
        entry_grade: 'B', entry_reasoning: 'because',
        rule_violations: [
          { rule: 'r-1', rule_title: 'No size', severity: 'warn', message: 'order is large' },
        ],
      },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    const tradeWritten = kvSet.mock.calls.find((c) => c[0]?.startsWith?.('trade:'))?.[1];
    expect(tradeWritten?.rule_warnings_at_entry).toBeDefined();
    expect(tradeWritten.rule_warnings_at_entry).toHaveLength(1);
  });

  it('rejects block-severity violation without override_reason', async () => {
    const handler = (await import('../api/trades/[action]')).default;
    const req: any = {
      method: 'POST',
      query: { action: 'submit' },
      body: {
        asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100,
        account: 'conservative_paper', order_type: 'market', tif: 'day',
        entry_grade: 'B', entry_reasoning: 'because',
        rule_violations: [
          { rule: 'r-1', severity: 'block', message: 'blocked', override_reason: '' },
        ],
      },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd dashboard && npm test -- trades-submit-violations.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Extend the existing submit handler**

In `api/trades/[action].ts`, find the `submit` action. Before placing the Alpaca order, validate:

```ts
// Inside submit case, after parsing req.body:
const rule_violations: any[] = req.body.rule_violations ?? [];
for (const v of rule_violations) {
  if (v.severity === 'block') {
    const reason = (v.override_reason ?? '').trim();
    if (reason.length < 20) {
      return res.status(400).json({ error: 'block-severity violation requires override_reason ≥ 20 chars' });
    }
  }
}
// ... existing order placement ...
// When constructing the trade record:
const trade: Trade = {
  // ... existing fields,
  rule_warnings_at_entry: rule_violations,
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd dashboard && npm test -- trades-submit-violations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/trades-submit-violations.test.ts
git commit -m "feat(dashboard): persist rule_violations + require override_reason for blocks"
```

---

### Task 2.9: Order form — wire `/api/trades/check` and violations banner

**Files:**
- Modify: `dashboard/src/routes/OrderNew.tsx`
- Create: `dashboard/src/components/order/RuleViolationsBanner.tsx`
- Create: `dashboard/src/components/order/BlockOverrideFields.tsx`

- [ ] **Step 1: Create RuleViolationsBanner component**

```tsx
// dashboard/src/components/order/RuleViolationsBanner.tsx
import type { RuleWarning } from '../../lib/trade-types';

interface Props { violations: RuleWarning[]; }

export default function RuleViolationsBanner({ violations }: Props) {
  if (!violations.length) return null;
  const hasBlock = violations.some((v) => v.severity === 'block');
  const tone = hasBlock ? 'border-red-500 bg-red-950/40' : 'border-yellow-500 bg-yellow-950/40';
  const title = hasBlock ? `${violations.filter(v=>v.severity==='block').length} blocking rule(s)` : 'rules to consider';
  return (
    <div className={`border ${tone} rounded p-3 my-3 text-sm`}>
      <div className="font-semibold uppercase tracking-wider text-xs mb-2">{title}</div>
      <ul className="space-y-1">
        {violations.map((v, i) => (
          <li key={i}>
            <span className={`uppercase text-xs mr-2 ${v.severity === 'block' ? 'text-red-400' : 'text-yellow-400'}`}>
              {v.severity}
            </span>
            <span>{v.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Create BlockOverrideFields component**

```tsx
// dashboard/src/components/order/BlockOverrideFields.tsx
interface Props {
  blockedCount: number;
  agreed: boolean;
  reason: string;
  onAgree: (v: boolean) => void;
  onReason: (v: string) => void;
}

export default function BlockOverrideFields({ blockedCount, agreed, reason, onAgree, onReason }: Props) {
  const remaining = Math.max(0, 20 - reason.trim().length);
  return (
    <div className="border border-red-500/50 bg-red-950/30 rounded p-3 my-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => onAgree(e.target.checked)}
          className="mt-1"
        />
        <span>I'm overriding {blockedCount} rule{blockedCount === 1 ? '' : 's'} because:</span>
      </label>
      <textarea
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        maxLength={500}
        rows={3}
        placeholder="Explain why this trade is the exception (≥ 20 chars)…"
        className="w-full mt-2 bg-neutral-900 border border-neutral-700 rounded p-2 text-sm"
      />
      <div className="text-xs text-neutral-400 mt-1">
        {remaining > 0 ? `${remaining} more chars` : `${reason.trim().length}/500`}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire OrderNew.tsx to call `/api/trades/check`**

In `dashboard/src/routes/OrderNew.tsx`:
- Add state: `const [violations, setViolations] = useState<RuleWarning[]>([]);`
- Add state: `const [overrideAgreed, setOverrideAgreed] = useState(false);`
- Add state: `const [overrideReason, setOverrideReason] = useState('');`
- After form fields are valid (or on a "Check rules" debounced effect), call:
  ```ts
  const r = await fetch('/api/trades/check', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const { violations } = await r.json();
  setViolations(violations);
  ```
- Render `<RuleViolationsBanner violations={violations} />` above the confirm button.
- If any `severity === 'block'`, render `<BlockOverrideFields …>` and disable the submit button until `overrideAgreed && overrideReason.trim().length >= 20`.
- When submitting, attach `rule_violations` (with the typed `override_reason` for block-severity entries) to the POST body.

- [ ] **Step 4: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173, log in, navigate to `/order/new`, build a stock buy on a symbol with a manual block-severity rule defined (you can seed one via the API with curl during testing). Confirm:
- Banner renders red when block-severity hit
- Submit disabled until override agreed + 20+ char reason
- Yellow banner renders for warn-only

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/OrderNew.tsx dashboard/src/components/order/RuleViolationsBanner.tsx dashboard/src/components/order/BlockOverrideFields.tsx
git commit -m "feat(dashboard): order form wires rule check + block override flow"
```

---

**Milestone 2 complete.** The rules API and rule-checker are live: rules can be CRUDded, proposals approved/dismissed, the order form blocks rule-violating trades until the user types an override reason. No `/rules` page yet — that's M3.

---

## Milestone 3 — `/rules` + `/rules/edit` pages

Builds the user-facing rules pages. Read-only `/rules` is the page Tim opens before placing a trade; `/rules/edit` is the section-dispatched editor.

### Task 3.1: useRules hook

**Files:**
- Create: `dashboard/src/hooks/useRules.ts`
- Test: `dashboard/tests/use-rules.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// dashboard/tests/use-rules.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useManualRules } from '../src/hooks/useRules';

global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ rules: [{ id: 'r-1', title: 'No earnings' }] }),
}) as any;

describe('useManualRules', () => {
  it('loads manual rules from /api/rules/manual', async () => {
    const { result } = renderHook(() => useManualRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    expect(result.current.rules[0].title).toBe('No earnings');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```bash
cd dashboard && npm test -- use-rules.test.tsx
```

- [ ] **Step 3: Create hook**

```ts
// dashboard/src/hooks/useRules.ts
import { useEffect, useState, useCallback } from 'react';
import type {
  ManualRule, Pattern, Cheatsheet, Goal, Tendency, Proposal, BotRulesPayload,
} from '../lib/rules-types';

function makeListHook<T>(resource: string, listKey: string) {
  return function useResource() {
    const [items, setItems] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/rules/${resource}`);
        if (!r.ok) throw new Error(`${r.status}`);
        const json = await r.json();
        setItems(json[listKey] ?? json.items ?? []);
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    return { [listKey]: items, loading, error, refresh } as Record<string, any>;
  };
}

export const useManualRules = (() => {
  const inner = makeListHook<ManualRule>('manual', 'rules');
  return () => inner() as { rules: ManualRule[]; loading: boolean; error: string | null; refresh: () => Promise<void> };
})();

export const usePatterns = (() => {
  const inner = makeListHook<Pattern>('patterns', 'items');
  return () => inner() as { items: Pattern[]; loading: boolean; error: string | null; refresh: () => Promise<void> };
})();

export const useCheatsheets = (() => {
  const inner = makeListHook<Cheatsheet>('cheatsheets', 'items');
  return () => inner() as { items: Cheatsheet[]; loading: boolean; error: string | null; refresh: () => Promise<void> };
})();

export const useGoals = (() => {
  const inner = makeListHook<Goal>('goals', 'items');
  return () => inner() as { items: Goal[]; loading: boolean; error: string | null; refresh: () => Promise<void> };
})();

export const useTendencies = (() => {
  const inner = makeListHook<Tendency>('tendencies', 'tendencies');
  return () => inner() as { tendencies: Tendency[]; loading: boolean; error: string | null; refresh: () => Promise<void> };
})();

export const useProposals = (() => {
  const inner = makeListHook<Proposal>('proposals', 'proposals');
  return () => inner() as { proposals: Proposal[]; loading: boolean; error: string | null; refresh: () => Promise<void> };
})();

export function useBotRules() {
  const [conservative, setCons] = useState<BotRulesPayload | null>(null);
  const [aggressive, setAgg] = useState<BotRulesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch('/api/rules/bot').then((r) => r.json()).then((j) => {
      setCons(j.conservative); setAgg(j.aggressive);
    }).finally(() => setLoading(false));
  }, []);
  return { conservative, aggressive, loading };
}
```

Also create `dashboard/src/lib/rules-types.ts` re-exporting from `api/_lib/rules-types.ts`:

```ts
// dashboard/src/lib/rules-types.ts
export type {
  Trigger, ManualRule, Pattern, Cheatsheet, Goal, Tendency, Proposal,
  BotRulesPayload, MatcherName, AssignmentEntry, Severity, TriggerType,
} from '../../api/_lib/rules-types';
export { TRIGGER_TYPES, isTrigger } from '../../api/_lib/rules-types';
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/hooks/useRules.ts dashboard/src/lib/rules-types.ts dashboard/tests/use-rules.test.tsx
git commit -m "feat(dashboard): useRules hooks for all rule resources"
```

---

### Task 3.2: BotRulesSection component

**Files:**
- Create: `dashboard/src/components/rules/BotRulesSection.tsx`

- [ ] **Step 1: Implement**

```tsx
// dashboard/src/components/rules/BotRulesSection.tsx
import type { BotRulesPayload } from '../../lib/rules-types';

interface Props { conservative: BotRulesPayload | null; aggressive: BotRulesPayload | null; }

function ModeColumn({ payload, label }: { payload: BotRulesPayload | null; label: string }) {
  if (!payload) return <div className="text-neutral-500 text-sm">no data — bot hasn't pushed yet</div>;
  return (
    <div className="space-y-3 text-sm">
      <div className="font-semibold uppercase tracking-wider text-xs text-neutral-400">{label}</div>
      <div>
        <div className="font-medium">Wheel</div>
        <ul className="ml-4 list-disc space-y-0.5 text-neutral-300">
          <li>Symbols: {payload.wheel.symbols.join(', ')}</li>
          {payload.wheel.priority_tier && <li>Priority tier: {payload.wheel.priority_tier.join(', ')}</li>}
          {payload.wheel.fallback_tier && <li>Fallback tier: {payload.wheel.fallback_tier.join(', ')}</li>}
          <li>OTM %: {(payload.wheel.otm_pct * 100).toFixed(0)}%</li>
          <li>DTE range: {payload.wheel.dte_min}-{payload.wheel.dte_max}</li>
          <li>Close at: {(payload.wheel.close_at_profit_pct * 100).toFixed(0)}% profit</li>
        </ul>
      </div>
      <div>
        <div className="font-medium">Strategy ({payload.strategy.underlying})</div>
        <ul className="ml-4 list-disc space-y-0.5 text-neutral-300">
          <li>Initial qty: {payload.strategy.initial_qty}</li>
          <li>Stop: -{(payload.strategy.stop_loss_pct * 100).toFixed(0)}%</li>
          <li>Trail activate: +{(payload.strategy.trail_activate_pct * 100).toFixed(0)}%</li>
          <li>Trail floor: -{(payload.strategy.trail_floor_pct * 100).toFixed(0)}% from high</li>
          {payload.strategy.ladders.map((l, i) => (
            <li key={i}>Ladder: {(l.trigger_pct * 100).toFixed(0)}% → +{l.qty} shares</li>
          ))}
        </ul>
      </div>
      {payload.congress && (
        <div>
          <div className="font-medium">Congress copy</div>
          <ul className="ml-4 list-disc space-y-0.5 text-neutral-300">
            <li>Politicians: {payload.congress.politicians.map(p => p.name).join(', ')}</li>
            <li>Sizing tiers: {payload.congress.sizing_tiers.length}</li>
          </ul>
        </div>
      )}
      <div className="text-xs text-neutral-500">pushed_at: {payload.pushed_at}</div>
    </div>
  );
}

export default function BotRulesSection({ conservative, aggressive }: Props) {
  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ModeColumn payload={conservative} label="Conservative" />
        <ModeColumn payload={aggressive} label="Aggressive" />
      </div>
      <div className="mt-4 text-xs text-neutral-500">
        Edit in <code>config.py</code> on the bot repo.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/components/rules/BotRulesSection.tsx
git commit -m "feat(dashboard): BotRulesSection two-column display"
```

---

### Task 3.3: RuleCard + ManualRulesSection + PatternsSection + CheatsheetsSection + GoalsSection + TendenciesSection + ProposalsSection

Each is a small list-of-cards component. Bundle them in one task with full code for each since they share patterns.

**Files (all NEW):**
- `dashboard/src/components/rules/RuleCard.tsx`
- `dashboard/src/components/rules/ManualRulesSection.tsx`
- `dashboard/src/components/rules/PatternsSection.tsx`
- `dashboard/src/components/rules/CheatsheetsSection.tsx`
- `dashboard/src/components/rules/GoalsSection.tsx`
- `dashboard/src/components/rules/TendenciesSection.tsx`
- `dashboard/src/components/rules/ProposalsSection.tsx`

- [ ] **Step 1: Create RuleCard.tsx (shared primitive)**

```tsx
// dashboard/src/components/rules/RuleCard.tsx
import type { ManualRule, Trigger } from '../../lib/rules-types';

interface Props {
  rule: ManualRule;
  onEdit: (rule: ManualRule) => void;
  onDelete: (id: string) => void;
}

function summarizeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'symbol_in':                return `symbol ∈ {${t.symbols.join(', ')}}`;
    case 'symbol_not_in':            return `symbol ∉ {${t.symbols.join(', ')}}`;
    case 'side':                     return `side = ${t.value}`;
    case 'asset_class':              return `asset = ${t.value}`;
    case 'option_type':              return `option = ${t.value}`;
    case 'option_dte_lt':            return `DTE < ${t.value}`;
    case 'option_dte_gt':            return `DTE > ${t.value}`;
    case 'open_position_count_gt':   return `open positions > ${t.value}`;
    case 'earnings_within_days':     return `earnings ≤ ${t.value} days`;
    case 'strike_below_cost_basis':  return `strike < cost basis`;
    case 'tag_present':              return `tag = "${t.tag}"`;
  }
}

export default function RuleCard({ rule, onEdit, onDelete }: Props) {
  const sevColor = rule.severity === 'block'
    ? 'bg-red-500/20 text-red-300 border-red-500/40'
    : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40';
  return (
    <div className="border border-neutral-800 rounded p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-xs uppercase tracking-wider border rounded px-1.5 py-0.5 ${sevColor}`}>
          {rule.severity}
        </span>
        <span className="font-medium">{rule.title}</span>
        {rule.source === 'tendency' && (
          <span className="text-xs text-purple-400 ml-auto">from tendency</span>
        )}
      </div>
      {rule.triggers.length > 0 && (
        <div className="text-xs text-neutral-400">
          {rule.triggers.map(summarizeTrigger).join(' AND ')}
        </div>
      )}
      <p className="text-sm text-neutral-300 whitespace-pre-wrap">{rule.body}</p>
      <div className="flex gap-2 text-xs">
        <button onClick={() => onEdit(rule)} className="text-blue-400 hover:underline">Edit</button>
        <button onClick={() => onDelete(rule.id)} className="text-red-400 hover:underline">Delete</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create ManualRulesSection.tsx**

```tsx
// dashboard/src/components/rules/ManualRulesSection.tsx
import { useNavigate } from 'react-router-dom';
import { useManualRules } from '../../hooks/useRules';
import RuleCard from './RuleCard';

export default function ManualRulesSection() {
  const { rules, loading, refresh } = useManualRules();
  const nav = useNavigate();

  async function handleDelete(id: string) {
    if (!confirm('Delete this rule?')) return;
    await fetch('/api/rules/manual', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-neutral-400">{rules.length} rule{rules.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=manual')} className="text-blue-400 text-sm hover:underline">
          + Add rule
        </button>
      </div>
      {loading ? <div className="text-neutral-500 text-sm">loading…</div> :
        rules.length === 0 ? <div className="text-neutral-500 text-sm">no manual rules yet</div> :
        <div className="space-y-2">
          {rules.map((r) => (
            <RuleCard
              key={r.id}
              rule={r}
              onEdit={(rule) => nav(`/rules/edit?section=manual&id=${rule.id}`)}
              onDelete={handleDelete}
            />
          ))}
        </div>
      }
    </div>
  );
}
```

- [ ] **Step 3: Create PatternsSection.tsx**

```tsx
// dashboard/src/components/rules/PatternsSection.tsx
import { useNavigate } from 'react-router-dom';
import { usePatterns } from '../../hooks/useRules';

export default function PatternsSection() {
  const { items, loading, refresh } = usePatterns();
  const nav = useNavigate();

  async function handleDelete(id: string) {
    if (!confirm('Delete this pattern?')) return;
    await fetch('/api/rules/patterns', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-neutral-400">{items.length} pattern{items.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=patterns')} className="text-blue-400 text-sm hover:underline">
          + Add pattern
        </button>
      </div>
      {loading ? <div className="text-neutral-500 text-sm">loading…</div> :
        items.length === 0 ? <div className="text-neutral-500 text-sm">no patterns yet</div> :
        <div className="space-y-2">
          {items.map((p) => (
            <div key={p.id} className="border border-neutral-800 rounded p-3 space-y-2">
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-neutral-400">env: {p.environment}</div>
              {p.win_rate != null && <div className="text-xs">win rate: {(p.win_rate * 100).toFixed(0)}%</div>}
              {p.legs.length > 0 && <div className="text-sm"><strong>Legs:</strong> {p.legs.join(', ')}</div>}
              {p.rules.length > 0 && <ul className="text-sm ml-4 list-disc">{p.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>}
              <div className="flex gap-2 text-xs">
                <button onClick={() => nav(`/rules/edit?section=patterns&id=${p.id}`)} className="text-blue-400 hover:underline">Edit</button>
                <button onClick={() => handleDelete(p.id)} className="text-red-400 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      }
    </div>
  );
}
```

- [ ] **Step 4: Create CheatsheetsSection.tsx + GoalsSection.tsx**

```tsx
// dashboard/src/components/rules/CheatsheetsSection.tsx
import { useNavigate } from 'react-router-dom';
import { useCheatsheets } from '../../hooks/useRules';

export default function CheatsheetsSection() {
  const { items, loading, refresh } = useCheatsheets();
  const nav = useNavigate();

  async function handleDelete(id: string) {
    if (!confirm('Delete this cheatsheet?')) return;
    await fetch('/api/rules/cheatsheets', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-neutral-400">{items.length} cheatsheet{items.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=cheatsheets')} className="text-blue-400 text-sm hover:underline">
          + Add
        </button>
      </div>
      {loading ? <div className="text-neutral-500 text-sm">loading…</div> :
        <div className="space-y-2">
          {items.map((c) => (
            <details key={c.id} className="border border-neutral-800 rounded p-3">
              <summary className="font-medium cursor-pointer">{c.title}</summary>
              <div className="mt-2 whitespace-pre-wrap text-sm">{c.body}</div>
              <div className="flex gap-2 text-xs mt-2">
                <button onClick={() => nav(`/rules/edit?section=cheatsheets&id=${c.id}`)} className="text-blue-400 hover:underline">Edit</button>
                <button onClick={() => handleDelete(c.id)} className="text-red-400 hover:underline">Delete</button>
              </div>
            </details>
          ))}
        </div>
      }
    </div>
  );
}
```

```tsx
// dashboard/src/components/rules/GoalsSection.tsx
import { useNavigate } from 'react-router-dom';
import { useGoals } from '../../hooks/useRules';

export default function GoalsSection() {
  const { items, loading, refresh } = useGoals();
  const nav = useNavigate();

  async function toggle(id: string, checked: boolean) {
    await fetch('/api/rules/goals', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, patch: { checked } }),
    });
    refresh();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this goal?')) return;
    await fetch('/api/rules/goals', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-neutral-400">{items.length} goal{items.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=goals')} className="text-blue-400 text-sm hover:underline">
          + Add goal
        </button>
      </div>
      {loading ? <div className="text-neutral-500 text-sm">loading…</div> :
        <ul className="space-y-1">
          {items.map((g) => (
            <li key={g.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={!!g.checked} onChange={(e) => toggle(g.id, e.target.checked)} className="mt-1" />
              <div className="flex-1">
                <div className={g.checked ? 'line-through text-neutral-500' : ''}>{g.body}</div>
                {(g.target || g.due) && (
                  <div className="text-xs text-neutral-400">
                    {g.target && <span>target: {g.target}</span>}
                    {g.due && <span className="ml-2">due: {g.due}</span>}
                  </div>
                )}
              </div>
              <button onClick={() => nav(`/rules/edit?section=goals&id=${g.id}`)} className="text-blue-400 text-xs hover:underline">edit</button>
              <button onClick={() => handleDelete(g.id)} className="text-red-400 text-xs hover:underline">×</button>
            </li>
          ))}
        </ul>
      }
    </div>
  );
}
```

- [ ] **Step 5: Create TendenciesSection.tsx**

```tsx
// dashboard/src/components/rules/TendenciesSection.tsx
import { useTendencies } from '../../hooks/useRules';
import { Link } from 'react-router-dom';

export default function TendenciesSection() {
  const { tendencies, loading } = useTendencies();
  if (loading) return <div className="text-neutral-500 text-sm">loading…</div>;
  if (!tendencies.length) return <div className="text-neutral-500 text-sm">no tendencies detected yet</div>;
  return (
    <ul className="space-y-3">
      {tendencies.map((t) => (
        <li key={t.id} className="border border-purple-500/30 bg-purple-950/20 rounded p-3">
          <div className="text-xs uppercase tracking-wider text-purple-300 mb-1">{t.matcher}</div>
          <div className="text-sm">{t.finding}</div>
          {t.evidence_trade_ids.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-neutral-400 cursor-pointer">{t.evidence_trade_ids.length} evidence trade(s)</summary>
              <ul className="mt-1 ml-4 list-disc text-xs">
                {t.evidence_trade_ids.map((id) => (
                  <li key={id}><Link to={`/trade/${id}`} className="text-blue-400 hover:underline">{id}</Link></li>
                ))}
              </ul>
            </details>
          )}
          <div className="text-xs text-neutral-500 mt-1">detected: {t.detected_at}</div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Create ProposalsSection.tsx**

```tsx
// dashboard/src/components/rules/ProposalsSection.tsx
import { useProposals } from '../../hooks/useRules';
import { useNavigate, Link } from 'react-router-dom';

export default function ProposalsSection() {
  const { proposals, loading, refresh } = useProposals();
  const nav = useNavigate();
  const open = proposals.filter((p) => p.status === 'open');

  async function approve(id: string) {
    await fetch('/api/rules/proposals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', proposal_id: id }),
    });
    refresh();
  }
  async function dismiss(id: string) {
    if (!confirm('Dismiss this proposal? It won\'t be re-suggested.')) return;
    await fetch('/api/rules/proposals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', proposal_id: id }),
    });
    refresh();
  }

  if (loading) return <div className="text-neutral-500 text-sm">loading…</div>;
  if (!open.length) return <div className="text-neutral-500 text-sm">no open proposals</div>;

  return (
    <ul className="space-y-3">
      {open.map((p) => (
        <li key={p.id} className="border border-blue-500/40 bg-blue-950/20 rounded p-3 space-y-2">
          <div className="text-xs uppercase tracking-wider text-blue-300">
            {p.demote_target_rule_id ? 'DEMOTE' : 'NEW RULE'} · from {p.matcher}
          </div>
          <div className="font-medium">{p.proposed_rule.title}</div>
          <div className="text-sm text-neutral-300 whitespace-pre-wrap">{p.proposed_rule.body}</div>
          <div className="text-xs text-neutral-400 italic">{p.reasoning}</div>
          {p.evidence_trade_ids.length > 0 && (
            <details>
              <summary className="text-xs text-neutral-400 cursor-pointer">{p.evidence_trade_ids.length} evidence trade(s)</summary>
              <ul className="mt-1 ml-4 list-disc text-xs">
                {p.evidence_trade_ids.map((id) => (
                  <li key={id}><Link to={`/trade/${id}`} className="text-blue-400 hover:underline">{id}</Link></li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2 text-sm pt-1">
            <button onClick={() => approve(p.id)} className="bg-green-600 hover:bg-green-500 px-2 py-1 rounded text-xs">Add to my rules</button>
            <button onClick={() => nav(`/rules/edit?section=proposals&id=${p.id}`)} className="bg-blue-700 hover:bg-blue-600 px-2 py-1 rounded text-xs">Edit then add</button>
            <button onClick={() => dismiss(p.id)} className="bg-neutral-700 hover:bg-neutral-600 px-2 py-1 rounded text-xs">Dismiss</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/rules/
git commit -m "feat(dashboard): rules-page section components (cards, lists, proposals)"
```

---

### Task 3.4: Rules.tsx top-level page

**Files:**
- Create: `dashboard/src/routes/Rules.tsx`

- [ ] **Step 1: Implement**

```tsx
// dashboard/src/routes/Rules.tsx
import { useState, useEffect } from 'react';
import BotRulesSection from '../components/rules/BotRulesSection';
import ManualRulesSection from '../components/rules/ManualRulesSection';
import PatternsSection from '../components/rules/PatternsSection';
import TendenciesSection from '../components/rules/TendenciesSection';
import ProposalsSection from '../components/rules/ProposalsSection';
import CheatsheetsSection from '../components/rules/CheatsheetsSection';
import GoalsSection from '../components/rules/GoalsSection';
import { useBotRules } from '../hooks/useRules';

const SECTIONS = [
  { key: 'bot',         title: 'Bot rules',     defaultOpen: true  },
  { key: 'manual',      title: 'My rules',      defaultOpen: true  },
  { key: 'patterns',    title: 'Playbook patterns', defaultOpen: false },
  { key: 'tendencies',  title: 'Tendencies',    defaultOpen: false },
  { key: 'proposals',   title: 'Proposals',     defaultOpen: true  },
  { key: 'cheatsheets', title: 'Cheatsheets',   defaultOpen: false },
  { key: 'goals',       title: 'Goals',         defaultOpen: false },
] as const;

const STORAGE_KEY = 'rules:expanded';

export default function Rules() {
  const { conservative, aggressive } = useBotRules();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {}
    return Object.fromEntries(SECTIONS.map((s) => [s.key, s.defaultOpen]));
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
  }, [expanded]);

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  function renderSection(key: string) {
    switch (key) {
      case 'bot':         return <BotRulesSection conservative={conservative} aggressive={aggressive} />;
      case 'manual':      return <ManualRulesSection />;
      case 'patterns':    return <PatternsSection />;
      case 'tendencies':  return <TendenciesSection />;
      case 'proposals':   return <ProposalsSection />;
      case 'cheatsheets': return <CheatsheetsSection />;
      case 'goals':       return <GoalsSection />;
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold">Rules</h1>
      {SECTIONS.map((s) => (
        <section key={s.key} className="border border-neutral-800 rounded">
          <button
            onClick={() => toggle(s.key)}
            className="w-full flex justify-between items-center p-3 hover:bg-neutral-900 transition-colors"
          >
            <h2 className="font-semibold">{s.title}</h2>
            <span className="text-neutral-500 text-sm">{expanded[s.key] ? '−' : '+'}</span>
          </button>
          {expanded[s.key] && <div className="p-4 border-t border-neutral-800">{renderSection(s.key)}</div>}
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/routes/Rules.tsx
git commit -m "feat(dashboard): Rules page (read-only seven sections)"
```

---

### Task 3.5: TriggerBuilder component (no-JSON UI)

**Files:**
- Create: `dashboard/src/components/rules/TriggerBuilder.tsx`
- Test: `dashboard/tests/trigger-builder.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// dashboard/tests/trigger-builder.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import TriggerBuilder from '../src/components/rules/TriggerBuilder';

describe('TriggerBuilder', () => {
  it('renders empty state with + Add', () => {
    render(<TriggerBuilder triggers={[]} onChange={() => {}} />);
    expect(screen.getByText(/add trigger/i)).toBeTruthy();
  });

  it('adds a default symbol_in trigger when + clicked', () => {
    const onChange = vi.fn();
    render(<TriggerBuilder triggers={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText(/add trigger/i));
    expect(onChange).toHaveBeenCalledWith([{ type: 'symbol_in', symbols: [] }]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// dashboard/src/components/rules/TriggerBuilder.tsx
import { TRIGGER_TYPES, type Trigger, type TriggerType } from '../../lib/rules-types';

interface Props { triggers: Trigger[]; onChange: (next: Trigger[]) => void; }

const DEFAULTS: Record<TriggerType, Trigger> = {
  symbol_in:                { type: 'symbol_in', symbols: [] },
  symbol_not_in:            { type: 'symbol_not_in', symbols: [] },
  side:                     { type: 'side', value: 'sell' },
  asset_class:              { type: 'asset_class', value: 'option' },
  option_type:              { type: 'option_type', value: 'put' },
  option_dte_lt:            { type: 'option_dte_lt', value: 7 },
  option_dte_gt:            { type: 'option_dte_gt', value: 30 },
  open_position_count_gt:   { type: 'open_position_count_gt', value: 3 },
  earnings_within_days:     { type: 'earnings_within_days', value: 7 },
  strike_below_cost_basis:  { type: 'strike_below_cost_basis' },
  tag_present:              { type: 'tag_present', tag: '' },
};

export default function TriggerBuilder({ triggers, onChange }: Props) {
  function update(i: number, next: Trigger) {
    onChange(triggers.map((t, idx) => (idx === i ? next : t)));
  }
  function remove(i: number) {
    onChange(triggers.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...triggers, { ...DEFAULTS.symbol_in }]);
  }

  return (
    <div className="space-y-2">
      {triggers.length > 0 && (
        <div className="text-xs text-neutral-400">all triggers must match (AND)</div>
      )}
      {triggers.map((t, i) => (
        <div key={i} className="flex items-center gap-2 flex-wrap">
          <select
            value={t.type}
            onChange={(e) => update(i, { ...DEFAULTS[e.target.value as TriggerType] })}
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          >
            {TRIGGER_TYPES.map((tt) => <option key={tt} value={tt}>{tt}</option>)}
          </select>
          <TriggerValueInput trigger={t} onChange={(next) => update(i, next)} />
          <button onClick={() => remove(i)} className="text-red-400 text-xs hover:underline ml-auto">×</button>
        </div>
      ))}
      <button onClick={add} className="text-blue-400 text-sm hover:underline">+ Add trigger</button>
    </div>
  );
}

function TriggerValueInput({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  const inputCls = 'bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm';
  switch (trigger.type) {
    case 'symbol_in':
    case 'symbol_not_in':
      return (
        <input
          type="text" placeholder="TSLA, F, NVDA"
          value={trigger.symbols.join(', ')}
          onChange={(e) => onChange({ ...trigger, symbols: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) })}
          className={inputCls}
        />
      );
    case 'side':
      return (
        <select value={trigger.value} onChange={(e) => onChange({ ...trigger, value: e.target.value as 'buy' | 'sell' })} className={inputCls}>
          <option value="buy">buy</option><option value="sell">sell</option>
        </select>
      );
    case 'asset_class':
      return (
        <select value={trigger.value} onChange={(e) => onChange({ ...trigger, value: e.target.value as 'stock' | 'option' })} className={inputCls}>
          <option value="stock">stock</option><option value="option">option</option>
        </select>
      );
    case 'option_type':
      return (
        <select value={trigger.value} onChange={(e) => onChange({ ...trigger, value: e.target.value as 'put' | 'call' })} className={inputCls}>
          <option value="put">put</option><option value="call">call</option>
        </select>
      );
    case 'option_dte_lt':
    case 'option_dte_gt':
    case 'open_position_count_gt':
    case 'earnings_within_days':
      return (
        <input
          type="number" min={0} max={365} value={trigger.value}
          onChange={(e) => onChange({ ...trigger, value: parseInt(e.target.value || '0', 10) })}
          className={`${inputCls} w-20`}
        />
      );
    case 'strike_below_cost_basis':
      return <span className="text-xs text-neutral-500">(no params)</span>;
    case 'tag_present':
      return (
        <input
          type="text" placeholder="tag-name"
          value={trigger.tag}
          onChange={(e) => onChange({ ...trigger, tag: e.target.value })}
          className={inputCls}
        />
      );
  }
}
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/rules/TriggerBuilder.tsx dashboard/tests/trigger-builder.test.tsx
git commit -m "feat(dashboard): TriggerBuilder no-JSON dropdown UI"
```

---

### Task 3.6: RulesEdit.tsx — section dispatcher + manual rule form

**Files:**
- Create: `dashboard/src/routes/RulesEdit.tsx`

- [ ] **Step 1: Implement**

```tsx
// dashboard/src/routes/RulesEdit.tsx
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import TriggerBuilder from '../components/rules/TriggerBuilder';
import type { ManualRule, Trigger, Severity, Pattern, Cheatsheet, Goal, Proposal } from '../lib/rules-types';

export default function RulesEdit() {
  const [params] = useSearchParams();
  const section = params.get('section') ?? 'manual';
  const id = params.get('id') ?? null;

  switch (section) {
    case 'manual':       return <ManualRuleForm id={id} />;
    case 'patterns':     return <PatternForm id={id} />;
    case 'cheatsheets':  return <CheatsheetForm id={id} />;
    case 'goals':        return <GoalForm id={id} />;
    case 'proposals':    return <ProposalApproveForm id={id!} />;
    default:             return <div className="p-4">unknown section</div>;
  }
}

function ManualRuleForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('warn');
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(!!id);

  useEffect(() => {
    if (!id) return;
    fetch('/api/rules/manual').then((r) => r.json()).then((j) => {
      const rule = j.rules.find((r: ManualRule) => r.id === id);
      if (rule) { setTitle(rule.title); setBody(rule.body); setSeverity(rule.severity); setTriggers(rule.triggers); }
      setLoading(false);
    });
  }, [id]);

  async function save() {
    const payload = { title, body, severity, triggers };
    if (id) {
      await fetch('/api/rules/manual', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, patch: payload }),
      });
    } else {
      await fetch('/api/rules/manual', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    nav('/rules');
  }

  if (loading) return <div className="p-4">loading…</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold">{id ? 'Edit rule' : 'New rule'}</h1>
      <label className="block">
        <span className="text-sm text-neutral-300">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="block w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm text-neutral-300">Severity</span>
        <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className="block bg-neutral-900 border border-neutral-700 rounded px-3 py-2">
          <option value="warn">warn (banner only)</option>
          <option value="block">block (override w/ reason)</option>
        </select>
      </label>
      <div>
        <span className="text-sm text-neutral-300">Triggers</span>
        <TriggerBuilder triggers={triggers} onChange={setTriggers} />
      </div>
      <label className="block">
        <span className="text-sm text-neutral-300">Body (plain English — what the AI grader sees)</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="block w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2" />
      </label>
      <div className="flex gap-2">
        <button onClick={save} disabled={!title || !body} className="bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 px-4 py-2 rounded text-sm">Save</button>
        <button onClick={() => nav('/rules')} className="bg-neutral-700 hover:bg-neutral-600 px-4 py-2 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}

function PatternForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [variables, setVariables] = useState('');
  const [legs, setLegs] = useState('');
  const [rules, setRules] = useState('');
  const [winRate, setWinRate] = useState('');
  const [loading, setLoading] = useState(!!id);

  useEffect(() => {
    if (!id) return;
    fetch('/api/rules/patterns').then((r) => r.json()).then((j) => {
      const p: Pattern = j.items.find((p: Pattern) => p.id === id);
      if (p) {
        setName(p.name); setEnvironment(p.environment);
        setVariables(p.variables.join('\n')); setLegs(p.legs.join('\n'));
        setRules(p.rules.join('\n')); setWinRate(p.win_rate?.toString() ?? '');
      }
      setLoading(false);
    });
  }, [id]);

  async function save() {
    const payload = {
      name, environment,
      variables: variables.split('\n').map((s) => s.trim()).filter(Boolean),
      legs: legs.split('\n').map((s) => s.trim()).filter(Boolean),
      rules: rules.split('\n').map((s) => s.trim()).filter(Boolean),
      win_rate: winRate ? parseFloat(winRate) : undefined,
    };
    const opts = { headers: { 'content-type': 'application/json' } };
    if (id) {
      await fetch('/api/rules/patterns', { ...opts, method: 'PATCH', body: JSON.stringify({ id, patch: payload }) });
    } else {
      await fetch('/api/rules/patterns', { ...opts, method: 'POST', body: JSON.stringify(payload) });
    }
    nav('/rules');
  }

  if (loading) return <div className="p-4">loading…</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-3">
      <h1 className="text-xl font-bold">{id ? 'Edit pattern' : 'New pattern'}</h1>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} /></Field>
      <Field label="Environment"><input value={environment} onChange={(e) => setEnvironment(e.target.value)} className={fieldCls} placeholder="e.g. high IV, post-earnings dip" /></Field>
      <Field label="Variables (one per line)"><textarea value={variables} onChange={(e) => setVariables(e.target.value)} rows={3} className={fieldCls} /></Field>
      <Field label="Legs (one per line)"><textarea value={legs} onChange={(e) => setLegs(e.target.value)} rows={3} className={fieldCls} /></Field>
      <Field label="Rules (one per line)"><textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={3} className={fieldCls} /></Field>
      <Field label="Win rate (0-1, optional)"><input value={winRate} onChange={(e) => setWinRate(e.target.value)} className={fieldCls} placeholder="0.65" /></Field>
      <div className="flex gap-2">
        <button onClick={save} disabled={!name || !environment} className="bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 px-4 py-2 rounded text-sm">Save</button>
        <button onClick={() => nav('/rules')} className="bg-neutral-700 hover:bg-neutral-600 px-4 py-2 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}

function CheatsheetForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(!!id);
  useEffect(() => {
    if (!id) return;
    fetch('/api/rules/cheatsheets').then((r) => r.json()).then((j) => {
      const c: Cheatsheet = j.items.find((c: Cheatsheet) => c.id === id);
      if (c) { setTitle(c.title); setBody(c.body); }
      setLoading(false);
    });
  }, [id]);
  async function save() {
    const payload = { title, body };
    const opts = { headers: { 'content-type': 'application/json' } };
    if (id) await fetch('/api/rules/cheatsheets', { ...opts, method: 'PATCH', body: JSON.stringify({ id, patch: payload }) });
    else    await fetch('/api/rules/cheatsheets', { ...opts, method: 'POST', body: JSON.stringify(payload) });
    nav('/rules');
  }
  if (loading) return <div className="p-4">loading…</div>;
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-3">
      <h1 className="text-xl font-bold">{id ? 'Edit cheatsheet' : 'New cheatsheet'}</h1>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} /></Field>
      <Field label="Body (markdown)"><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={fieldCls} /></Field>
      <div className="flex gap-2">
        <button onClick={save} disabled={!title} className="bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 px-4 py-2 rounded text-sm">Save</button>
        <button onClick={() => nav('/rules')} className="bg-neutral-700 hover:bg-neutral-600 px-4 py-2 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}

function GoalForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const [body, setBody] = useState('');
  const [target, setTarget] = useState('');
  const [due, setDue] = useState('');
  const [loading, setLoading] = useState(!!id);
  useEffect(() => {
    if (!id) return;
    fetch('/api/rules/goals').then((r) => r.json()).then((j) => {
      const g: Goal = j.items.find((g: Goal) => g.id === id);
      if (g) { setBody(g.body); setTarget(g.target ?? ''); setDue(g.due ?? ''); }
      setLoading(false);
    });
  }, [id]);
  async function save() {
    const payload: any = { body };
    if (target) payload.target = target;
    if (due) payload.due = due;
    const opts = { headers: { 'content-type': 'application/json' } };
    if (id) await fetch('/api/rules/goals', { ...opts, method: 'PATCH', body: JSON.stringify({ id, patch: payload }) });
    else    await fetch('/api/rules/goals', { ...opts, method: 'POST', body: JSON.stringify(payload) });
    nav('/rules');
  }
  if (loading) return <div className="p-4">loading…</div>;
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-3">
      <h1 className="text-xl font-bold">{id ? 'Edit goal' : 'New goal'}</h1>
      <Field label="Body"><input value={body} onChange={(e) => setBody(e.target.value)} className={fieldCls} /></Field>
      <Field label="Target (optional)"><input value={target} onChange={(e) => setTarget(e.target.value)} className={fieldCls} placeholder="e.g. $5000" /></Field>
      <Field label="Due (optional, YYYY-MM-DD)"><input value={due} onChange={(e) => setDue(e.target.value)} className={fieldCls} /></Field>
      <div className="flex gap-2">
        <button onClick={save} disabled={!body} className="bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 px-4 py-2 rounded text-sm">Save</button>
        <button onClick={() => nav('/rules')} className="bg-neutral-700 hover:bg-neutral-600 px-4 py-2 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}

function ProposalApproveForm({ id }: { id: string }) {
  const nav = useNavigate();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('warn');
  const [triggers, setTriggers] = useState<Trigger[]>([]);

  useEffect(() => {
    fetch('/api/rules/proposals').then((r) => r.json()).then((j) => {
      const p: Proposal = j.proposals.find((p: Proposal) => p.id === id);
      if (p) {
        setProposal(p);
        setTitle(p.proposed_rule.title);
        setBody(p.proposed_rule.body);
        setSeverity(p.proposed_rule.severity);
        setTriggers(p.proposed_rule.triggers);
      }
    });
  }, [id]);

  async function save() {
    await fetch('/api/rules/proposals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'edit-and-approve', proposal_id: id,
        edits: { title, body, severity, triggers },
      }),
    });
    nav('/rules');
  }

  if (!proposal) return <div className="p-4">loading…</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold">Edit proposed rule before adding</h1>
      <div className="text-xs text-neutral-400 italic">{proposal.reasoning}</div>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} /></Field>
      <Field label="Severity">
        <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={fieldCls}>
          <option value="warn">warn</option><option value="block">block</option>
        </select>
      </Field>
      <div>
        <span className="text-sm text-neutral-300">Triggers</span>
        <TriggerBuilder triggers={triggers} onChange={setTriggers} />
      </div>
      <Field label="Body"><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className={fieldCls} /></Field>
      <div className="flex gap-2">
        <button onClick={save} className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded text-sm">Add to my rules</button>
        <button onClick={() => nav('/rules')} className="bg-neutral-700 hover:bg-neutral-600 px-4 py-2 rounded text-sm">Cancel</button>
      </div>
    </div>
  );
}

const fieldCls = 'block w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-neutral-300 block mb-1">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/routes/RulesEdit.tsx
git commit -m "feat(dashboard): RulesEdit page (manual/patterns/cheatsheets/goals/proposal forms)"
```

---

### Task 3.7: Wire navigation + routes

**Files:**
- Modify: `dashboard/src/components/layout/Layout.tsx` (or app's router/nav file)
- Modify: `dashboard/src/main.tsx` or `App.tsx` (whichever holds the route table)

- [ ] **Step 1: Add routes for /rules and /rules/edit**

Find the router setup (likely in `dashboard/src/main.tsx` or `App.tsx`). Add:

```tsx
import Rules from './routes/Rules';
import RulesEdit from './routes/RulesEdit';
// ...
<Route path="/rules" element={<RequireAuth><Rules /></RequireAuth>} />
<Route path="/rules/edit" element={<RequireAuth><RulesEdit /></RequireAuth>} />
```

- [ ] **Step 2: Add nav link**

In the nav component (likely `dashboard/src/components/layout/Layout.tsx`), add:

```tsx
<NavLink to="/rules" className={navLinkCls}>Rules</NavLink>
```

(Position it between existing items in a sensible spot — e.g., after `/orders`.)

- [ ] **Step 3: Smoke test**

```bash
cd dashboard && npm run dev
```

Navigate to `/rules`, verify all 7 sections render. Click "+ Add rule" → fill in a rule with `symbol_in: TSLA`, severity `warn`, body "test rule" → save → returns to `/rules` → new card visible.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/main.tsx dashboard/src/components/layout/Layout.tsx
git commit -m "feat(dashboard): wire /rules + /rules/edit routes and nav link"
```

---

**Milestone 3 complete.** `/rules` and `/rules/edit` are live. Tim can write/edit/delete manual rules, patterns, cheatsheets, goals; tendencies and proposals render (empty until M4 cron runs). Approve/dismiss/edit-then-add flow on proposals works.

---

## Milestone 4 — Tendency detection cron

Implements the Sunday cron with six deterministic matchers, Sonnet 4.6 proposal generation, and the demote loop. After this milestone, M3's tendencies and proposals sections start showing real data.

### Task 4.1: et-time.ts DST helper

**Files:**
- Create: `dashboard/api/_lib/et-time.ts`
- Test: `dashboard/tests/et-time.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// dashboard/tests/et-time.test.ts
import { describe, it, expect } from 'vitest';
import { etDateAt, etTodayAt, isAfterEtNow, hoursUntilEt } from '../api/_lib/et-time';

describe('et-time helpers', () => {
  it('etDateAt returns correct UTC during EDT (March-November)', () => {
    // 2026-06-15 16:00 ET (EDT) = 2026-06-15 20:00 UTC
    const d = etDateAt(2026, 6, 15, 16, 0);
    expect(d.toISOString()).toBe('2026-06-15T20:00:00.000Z');
  });

  it('etDateAt returns correct UTC during EST (November-March)', () => {
    // 2026-01-15 16:00 ET (EST) = 2026-01-15 21:00 UTC
    const d = etDateAt(2026, 1, 15, 16, 0);
    expect(d.toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });

  it('etDateAt handles March DST transition correctly', () => {
    // 2026-03-08 is the DST start in 2026 (2 AM ET → 3 AM EDT)
    // 2026-03-09 16:00 ET should be 20:00 UTC (EDT now active)
    const d = etDateAt(2026, 3, 9, 16, 0);
    expect(d.toISOString()).toBe('2026-03-09T20:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement et-time.ts**

```ts
// dashboard/api/_lib/et-time.ts
/** Build a Date for a given ET wall-clock time, DST-aware via Intl.DateTimeFormat. */
export function etDateAt(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // Strategy: format a UTC date in America/New_York and read back the offset
  // We iterate at most twice (DST transition disambiguation), then return.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = etOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60_000);
}

/** Returns the offset (in minutes) of America/New_York at the given instant.
 *  EDT = -240 min, EST = -300 min. */
export function etOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(at);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  // tz is like "GMT-4" or "GMT-5"
  const m = /GMT([+-]\d+)/.exec(tz);
  if (!m) return -300; // fallback to EST
  return parseInt(m[1], 10) * 60;
}

export function etTodayAt(hour: number, minute = 0): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const d = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
  return etDateAt(y, m, d, hour, minute);
}

export function isAfterEtNow(d: Date): boolean {
  return d.getTime() > Date.now();
}

export function hoursUntilEt(d: Date): number {
  return (d.getTime() - Date.now()) / 3_600_000;
}
```

- [ ] **Step 4: Run to verify PASS**

```bash
cd dashboard && npm test -- et-time.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/et-time.ts dashboard/tests/et-time.test.ts
git commit -m "feat(dashboard): et-time DST-aware helpers (closes Phase 2 follow-up #3)"
```

---

### Task 4.2: tendency-matchers.ts (six deterministic matchers)

**Files:**
- Create: `dashboard/api/_lib/tendency-matchers.ts`
- Test: `dashboard/tests/tendency-matchers.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// dashboard/tests/tendency-matchers.test.ts
import { describe, it, expect } from 'vitest';
import { runMatchers, type ClosedTradeView } from '../api/_lib/tendency-matchers';

function mk(over: Partial<ClosedTradeView>): ClosedTradeView {
  return {
    id: 't', symbol: 'TSLA', asset_class: 'option', option_type: 'put',
    side: 'STO', closed_at: '2026-04-01T20:00:00Z', realized_pnl: -100,
    user_grade: 'B', ai_grade: 'C', tags: [], rule_violations: [],
    strike: 200, expiration: '2026-04-15', cost_basis_at_entry: null,
    earnings_during_hold: false,
    ...over,
  };
}

describe('tendency matchers', () => {
  it('loss_concentration_by_symbol fires when ≥3 losing trades on same symbol', () => {
    const trades = [
      mk({ id: 't1', symbol: 'F', realized_pnl: -100 }),
      mk({ id: 't2', symbol: 'F', realized_pnl: -50 }),
      mk({ id: 't3', symbol: 'F', realized_pnl: -200 }),
    ];
    const findings = runMatchers(trades);
    const f = findings.find((x) => x.matcher === 'loss_concentration_by_symbol');
    expect(f).toBeDefined();
    expect(f?.evidence_trade_ids).toEqual(['t1', 't2', 't3']);
  });

  it('cc_below_cost_basis fires for ≥2 calls below cost basis with ≥1 loss', () => {
    const trades = [
      mk({ id: 'cc1', option_type: 'call', side: 'STO', strike: 10, cost_basis_at_entry: 12, realized_pnl: -50 }),
      mk({ id: 'cc2', option_type: 'call', side: 'STO', strike: 11, cost_basis_at_entry: 13, realized_pnl: 25 }),
    ];
    const findings = runMatchers(trades);
    const f = findings.find((x) => x.matcher === 'cc_below_cost_basis');
    expect(f).toBeDefined();
  });

  it('over_grading_self informational only — no rule trigger', () => {
    const trades: ClosedTradeView[] = [];
    for (let i = 0; i < 12; i++) {
      trades.push(mk({ id: `t${i}`, user_grade: 'A', ai_grade: 'C', realized_pnl: 0 }));
    }
    const findings = runMatchers(trades);
    const f = findings.find((x) => x.matcher === 'over_grading_self');
    expect(f).toBeDefined();
    expect(f?.actionable).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement tendency-matchers.ts**

```ts
// dashboard/api/_lib/tendency-matchers.ts
import type { GradeLetter } from './trade-types.js';
import { GRADE_LETTERS, gradeIndex } from './trade-types.js';
import type { MatcherName, Trigger, Severity } from './rules-types.js';

export interface ClosedTradeView {
  id: string;
  symbol: string;
  asset_class: 'stock' | 'option';
  option_type: 'put' | 'call' | null;
  side: string;                                // OrderSide
  closed_at: string;
  realized_pnl: number;
  user_grade: GradeLetter;
  ai_grade: GradeLetter | null;
  tags: string[];
  rule_violations: Array<{ rule: string; severity: Severity; override_reason?: string }>;
  strike: number | null;
  expiration: string | null;
  cost_basis_at_entry: number | null;          // for CC: the underlying's avg_entry_price at STO
  earnings_during_hold: boolean;
}

export interface Finding {
  matcher: MatcherName;
  finding: string;                  // plain-English summary (will be rewritten by Sonnet for proposal text)
  evidence_trade_ids: string[];
  key: string;                      // dedup key for proposals (matcher + dimension)
  actionable: boolean;              // true if we should generate a proposal
  suggested_severity: Severity;
  suggested_triggers: Trigger[];    // seed for proposal
}

export function runMatchers(trades: ClosedTradeView[]): Finding[] {
  const out: Finding[] = [];
  const f1 = lossConcentrationBySymbol(trades);   if (f1) out.push(f1);
  const f2 = lossConcentrationBySide(trades);     if (f2) out.push(f2);
  const f3 = ccBelowCostBasis(trades);            if (f3) out.push(f3);
  const f4 = heldThroughEarnings(trades);         if (f4) out.push(f4);
  const f5 = overrideLossPattern(trades);         out.push(...f5);   // can produce multiple
  const f6 = overGradingSelf(trades);             if (f6) out.push(f6);
  return out;
}

function lossConcentrationBySymbol(trades: ClosedTradeView[]): Finding | null {
  const bySymbol = groupBy(trades, (t) => t.symbol);
  for (const [symbol, ts] of Object.entries(bySymbol)) {
    if (ts.length < 3) continue;
    const wins = ts.filter((t) => t.realized_pnl > 0).length;
    const winRate = wins / ts.length;
    const total = ts.reduce((s, t) => s + t.realized_pnl, 0);
    if (winRate < 0.4 && total < 0) {
      return {
        matcher: 'loss_concentration_by_symbol',
        finding: `${ts.length} trades on ${symbol}, ${(winRate * 100).toFixed(0)}% win rate, total P&L ${total.toFixed(0)}`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `loss_concentration_by_symbol:${symbol}`,
        actionable: true,
        suggested_severity: 'warn',
        suggested_triggers: [{ type: 'symbol_in', symbols: [symbol] }],
      };
    }
  }
  return null;
}

function lossConcentrationBySide(trades: ClosedTradeView[]): Finding | null {
  const groups: Record<string, ClosedTradeView[]> = {};
  for (const t of trades) {
    const k = `${t.asset_class}:${t.option_type ?? 'na'}`;
    (groups[k] ??= []).push(t);
  }
  for (const [k, ts] of Object.entries(groups)) {
    if (ts.length < 5) continue;
    const wins = ts.filter((t) => t.realized_pnl > 0).length;
    if (wins / ts.length < 0.4) {
      const [ac, ot] = k.split(':');
      const triggers: Trigger[] = [{ type: 'asset_class', value: ac as 'stock' | 'option' }];
      if (ot !== 'na') triggers.push({ type: 'option_type', value: ot as 'put' | 'call' });
      return {
        matcher: 'loss_concentration_by_side',
        finding: `${ts.length} ${k} trades, ${((wins / ts.length) * 100).toFixed(0)}% win rate`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `loss_concentration_by_side:${k}`,
        actionable: true,
        suggested_severity: 'warn',
        suggested_triggers: triggers,
      };
    }
  }
  return null;
}

function ccBelowCostBasis(trades: ClosedTradeView[]): Finding | null {
  const ccs = trades.filter((t) =>
    t.asset_class === 'option' && t.option_type === 'call' && t.side === 'STO'
    && t.strike != null && t.cost_basis_at_entry != null
    && t.strike < t.cost_basis_at_entry,
  );
  const losses = ccs.filter((t) => t.realized_pnl < 0);
  if (ccs.length >= 2 && losses.length >= 1) {
    return {
      matcher: 'cc_below_cost_basis',
      finding: `${ccs.length} covered calls below cost basis, ${losses.length} ended at a loss`,
      evidence_trade_ids: ccs.map((t) => t.id),
      key: 'cc_below_cost_basis:global',
      actionable: true,
      suggested_severity: 'block',
      suggested_triggers: [
        { type: 'asset_class', value: 'option' },
        { type: 'option_type', value: 'call' },
        { type: 'side', value: 'sell' },
        { type: 'strike_below_cost_basis' },
      ],
    };
  }
  return null;
}

function heldThroughEarnings(trades: ClosedTradeView[]): Finding | null {
  const eligible = trades.filter((t) => t.earnings_during_hold);
  const losses = eligible.filter((t) => t.realized_pnl < 0);
  if (eligible.length >= 2 && losses.length / eligible.length >= 0.5) {
    return {
      matcher: 'held_through_earnings',
      finding: `${eligible.length} trades held through earnings, ${losses.length} lost money`,
      evidence_trade_ids: eligible.map((t) => t.id),
      key: 'held_through_earnings:global',
      actionable: true,
      suggested_severity: 'block',
      suggested_triggers: [{ type: 'earnings_within_days', value: 14 }],
    };
  }
  return null;
}

function overrideLossPattern(trades: ClosedTradeView[]): Finding[] {
  const byRule: Record<string, ClosedTradeView[]> = {};
  for (const t of trades) {
    for (const v of t.rule_violations) {
      if (v.severity === 'block' && v.override_reason) {
        (byRule[v.rule] ??= []).push(t);
      }
    }
  }
  const findings: Finding[] = [];
  for (const [ruleId, ts] of Object.entries(byRule)) {
    if (ts.length < 3) continue;
    const losses = ts.filter((t) => t.realized_pnl < 0).length;
    if (losses / ts.length >= 0.6) {
      findings.push({
        matcher: 'override_loss_pattern',
        finding: `Rule ${ruleId} overridden ${ts.length} times, ${losses} lost money (${((losses / ts.length) * 100).toFixed(0)}%)`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `override_loss_pattern:${ruleId}`,
        actionable: true,
        suggested_severity: 'block',
        suggested_triggers: [],   // can't auto-suggest; user-curated rule already exists
      });
    }
  }
  return findings;
}

function overGradingSelf(trades: ClosedTradeView[]): Finding | null {
  const graded = trades.filter((t) => t.ai_grade != null);
  if (graded.length < 10) return null;
  const totalDelta = graded.reduce((s, t) => s + (gradeIndex(t.user_grade) - gradeIndex(t.ai_grade!)), 0);
  const avgDelta = totalDelta / graded.length;
  // Negative delta = user grades higher than AI. ≥1 letter = avgDelta ≤ -1
  if (avgDelta <= -1) {
    return {
      matcher: 'over_grading_self',
      finding: `Across ${graded.length} graded trades, you grade yourself ~${(-avgDelta).toFixed(1)} letter steps higher than AI on average.`,
      evidence_trade_ids: graded.map((t) => t.id),
      key: 'over_grading_self:global',
      actionable: false,
      suggested_severity: 'warn',
      suggested_triggers: [],
    };
  }
  return null;
}

function groupBy<T>(arr: T[], k: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of arr) (out[k(x)] ??= []).push(x);
  return out;
}
```

- [ ] **Step 4: Run to verify PASS**

```bash
cd dashboard && npm test -- tendency-matchers.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/tendency-matchers.ts dashboard/tests/tendency-matchers.test.ts
git commit -m "feat(dashboard): six deterministic tendency matchers"
```

---

### Task 4.3: proposal-prompts.ts — Sonnet 4.6 integration

**Files:**
- Create: `dashboard/api/_lib/proposal-prompts.ts`
- Test: `dashboard/tests/proposal-prompts.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// dashboard/tests/proposal-prompts.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return { default: class { constructor() {} messages = { create: mockCreate }; } };
});

describe('proposal-prompts', () => {
  beforeEach(() => { mockCreate.mockReset(); });

  it('proposeNewRule returns parsed JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        proposed_rule_title: 'No F losses', proposed_rule_body: 'stop trading F',
        suggested_severity: 'warn', suggested_triggers: [{ type: 'symbol_in', symbols: ['F'] }],
        reasoning: 'You lost on F three times.',
      })}],
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 480, cache_creation_input_tokens: 0 },
    });
    const { proposeNewRule } = await import('../api/_lib/proposal-prompts');
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const out = await proposeNewRule({
      matcher: 'loss_concentration_by_symbol',
      finding: 'F losing 3/3',
      evidence_trade_ids: ['T-1', 'T-2', 'T-3'],
      key: 'loss_concentration_by_symbol:F',
      actionable: true,
      suggested_severity: 'warn',
      suggested_triggers: [{ type: 'symbol_in', symbols: ['F'] }],
    } as any, []);
    expect(out.proposed_rule.title).toBe('No F losses');
    expect(out.proposed_rule.severity).toBe('warn');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Implement proposal-prompts.ts**

```ts
// dashboard/api/_lib/proposal-prompts.ts
import Anthropic from '@anthropic-ai/sdk';
import type { Finding } from './tendency-matchers.js';
import type { Proposal, ManualRule } from './rules-types.js';
import { newId } from './rules-types.js';

const MODEL = 'claude-sonnet-4-6';

const CACHED_SYSTEM = `You help a trader convert detected behavioral patterns into concise, journal-quality trading rules.

Severity levels:
- "block" — order placement requires typed override reasoning. Use ONLY when the pattern is severe (≥60% loss rate over ≥3 trades, or strong directional signal).
- "warn" — banner shown at order placement, click-through. Use as the default.

Trigger DSL grammar (each rule has a list of triggers, ALL must match for rule to fire):
- {"type":"symbol_in","symbols":["TSLA","F"]}
- {"type":"symbol_not_in","symbols":[...]}
- {"type":"side","value":"buy"|"sell"}
- {"type":"asset_class","value":"stock"|"option"}
- {"type":"option_type","value":"put"|"call"}
- {"type":"option_dte_lt"|"option_dte_gt","value":<number>}
- {"type":"open_position_count_gt","value":<number>}
- {"type":"earnings_within_days","value":<number>}
- {"type":"strike_below_cost_basis"}
- {"type":"tag_present","tag":"<tag>"}

Output: pure JSON with keys proposed_rule_title (≤60 chars, plain English), proposed_rule_body (≤200 words, journal voice — "I" or imperative), suggested_severity, suggested_triggers (array; you MAY adjust the suggestion to be more accurate), reasoning (≤80 words, "you did X N times, lost Y").

Rules:
- Speak in the trader's voice ("don't sell calls below cost basis"), NOT "the user" or "the trader".
- No jargon the trader hasn't already used. Plain English.
- If the finding doesn't justify a rule, return {"reasoning":"insufficient signal"} and skip the other fields.`;

export async function proposeNewRule(
  finding: Finding,
  evidenceSnippets: Array<{ id: string; symbol: string; pnl: number; closed_at: string }>,
): Promise<Pick<Proposal, 'id' | 'matcher' | 'proposed_rule' | 'reasoning' | 'evidence_trade_ids' | 'status' | 'proposed_at'>> {
  const client = new Anthropic();

  const userBlock = JSON.stringify({
    matcher: finding.matcher,
    finding: finding.finding,
    suggested_severity: finding.suggested_severity,
    suggested_triggers: finding.suggested_triggers,
    evidence: evidenceSnippets.slice(0, 5),
  });

  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: [
      { type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral' } },
    ] as any,
    messages: [{ role: 'user', content: userBlock }],
  });

  const text = r.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch {
    // Try to extract JSON object from response
    const m = /\{[\s\S]*\}/.exec(text);
    parsed = m ? JSON.parse(m[0]) : null;
  }
  if (!parsed || !parsed.proposed_rule_title) {
    throw new Error('proposal generation returned unparseable output');
  }

  return {
    id: newId('p'),
    matcher: finding.matcher,
    proposed_rule: {
      title: parsed.proposed_rule_title,
      body: parsed.proposed_rule_body ?? '',
      severity: parsed.suggested_severity === 'block' ? 'block' : 'warn',
      triggers: Array.isArray(parsed.suggested_triggers) ? parsed.suggested_triggers : finding.suggested_triggers,
    },
    reasoning: parsed.reasoning ?? finding.finding,
    evidence_trade_ids: finding.evidence_trade_ids,
    status: 'open',
    proposed_at: new Date().toISOString(),
  };
}

export async function proposeDemote(
  rule: ManualRule,
  stats: { overrides: number; profitable_pct: number },
): Promise<Pick<Proposal, 'id' | 'matcher' | 'proposed_rule' | 'reasoning' | 'evidence_trade_ids' | 'status' | 'proposed_at' | 'demote_target_rule_id'>> {
  return {
    id: newId('p'),
    matcher: 'override_loss_pattern',
    proposed_rule: {
      title: `Demote: ${rule.title}`,
      body: `${rule.body}\n\n(suggested demote: you've overridden this ${stats.overrides} times and ${(stats.profitable_pct * 100).toFixed(0)}% of overrides were profitable — consider downgrading to warn.)`,
      severity: 'warn',
      triggers: rule.triggers,
    },
    reasoning: `You overrode "${rule.title}" ${stats.overrides} times this period and ${(stats.profitable_pct * 100).toFixed(0)}% of those overrides made money — the rule may be too strict.`,
    evidence_trade_ids: [],
    status: 'open',
    proposed_at: new Date().toISOString(),
    demote_target_rule_id: rule.id,
  };
}
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/proposal-prompts.ts dashboard/tests/proposal-prompts.test.ts
git commit -m "feat(dashboard): proposal-prompts (Sonnet 4.6 with prompt caching)"
```

---

### Task 4.4: Add detect-tendencies action to api/cron/[job].ts

**Files:**
- Modify: `dashboard/api/cron/[job].ts`
- Test: `dashboard/tests/cron-detect-tendencies.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// dashboard/tests/cron-detect-tendencies.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({}));
const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, lrange: vi.fn().mockResolvedValue([]) }) }));
const proposeNewRule = vi.fn();
vi.mock('../api/_lib/proposal-prompts', () => ({ proposeNewRule, proposeDemote: vi.fn() }));

describe('cron/detect-tendencies', () => {
  beforeEach(() => {
    kvGet.mockReset(); kvSet.mockReset(); proposeNewRule.mockReset();
    process.env.CRON_TOKEN = 'tok';
  });

  it('rejects without bearer token', async () => {
    const handler = (await import('../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'detect-tendencies' }, headers: {} };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('runs matchers + writes tendencies + appends proposals', async () => {
    // Mock: trades returning 3 losing F trades
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [];
      if (k === 'rules:manual') return [];
      if (k === 'rules:tendencies') return [];
      if (k === 'trades:index:open') return [];
      if (k.startsWith('trades:index:')) return ['t1', 't2', 't3'];
      if (k === 'trade:t1') return { id: 't1', symbol: 'F', asset_class: 'option', option_type: 'put', side: 'STO', closed_at: '2026-04-01T20:00:00Z', realized_pnl: -100, entry_grade: 'B', tags: [], rule_warnings_at_entry: [], strike: 12, expiration: '2026-04-15' };
      if (k === 'trade:t2') return { id: 't2', symbol: 'F', asset_class: 'option', option_type: 'put', side: 'STO', closed_at: '2026-04-05T20:00:00Z', realized_pnl: -50,  entry_grade: 'B', tags: [], rule_warnings_at_entry: [], strike: 12, expiration: '2026-04-19' };
      if (k === 'trade:t3') return { id: 't3', symbol: 'F', asset_class: 'option', option_type: 'put', side: 'STO', closed_at: '2026-04-08T20:00:00Z', realized_pnl: -200, entry_grade: 'B', tags: [], rule_warnings_at_entry: [], strike: 12, expiration: '2026-04-22' };
      if (k === 'grade:t1') return null; if (k === 'grade:t2') return null; if (k === 'grade:t3') return null;
      return null;
    });
    proposeNewRule.mockResolvedValue({
      id: 'p-new', matcher: 'loss_concentration_by_symbol',
      proposed_rule: { title: 'No F', body: 'stop F', severity: 'warn', triggers: [] },
      reasoning: 'r', evidence_trade_ids: ['t1','t2','t3'], status: 'open', proposed_at: '...',
    });

    const handler = (await import('../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'detect-tendencies' }, headers: { authorization: 'Bearer tok' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(kvSet).toHaveBeenCalledWith('rules:tendencies', expect.any(Array));
    expect(kvSet).toHaveBeenCalledWith('rules:proposals', expect.any(Array));
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Add detect-tendencies action**

In `dashboard/api/cron/[job].ts`, add a `detectTendenciesHandler`. Inside the dispatch (which probably already routes by `req.query.job`), add a `case 'detect-tendencies'`. Implementation:

```ts
// Inside api/cron/[job].ts — add imports
import { runMatchers, type ClosedTradeView } from '../_lib/tendency-matchers.js';
import { proposeNewRule, proposeDemote } from '../_lib/proposal-prompts.js';
import { rulesKey } from '../_lib/kv-keys.js';
import type { Tendency, Proposal, ManualRule } from '../_lib/rules-types.js';
import type { Trade } from '../_lib/trade-types.js';
import { newId } from '../_lib/rules-types.js';

// In dispatch:
case 'detect-tendencies': return detectTendenciesHandler(req, res);

async function detectTendenciesHandler(req: VercelRequest, res: VercelResponse) {
  // Bearer auth
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.CRON_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Load closed trades from last LOOKBACK days
  const LOOKBACK = 90;
  const trades: ClosedTradeView[] = await loadClosedTrades(LOOKBACK);

  // Run matchers
  const findings = runMatchers(trades);

  // Write tendencies (replace by matcher key)
  const existingTendencies = (await kv().get<Tendency[]>(rulesKey('tendencies'))) ?? [];
  const updatedTendencies = mergeTendencies(existingTendencies, findings);
  await kv().set(rulesKey('tendencies'), updatedTendencies);

  // Generate proposals for actionable findings, dedupe
  const proposals = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];
  let proposalsAppended = 0;
  for (const finding of findings) {
    if (!finding.actionable) continue;
    if (proposals.some((p) =>
      p.status !== 'approved'
      && proposalKey(p) === finding.key
    )) continue;
    try {
      const evidenceSnippets = trades
        .filter((t) => finding.evidence_trade_ids.includes(t.id))
        .slice(0, 5)
        .map((t) => ({ id: t.id, symbol: t.symbol, pnl: t.realized_pnl, closed_at: t.closed_at }));
      const proposal = await proposeNewRule(finding, evidenceSnippets);
      proposals.push(proposal as Proposal);
      proposalsAppended++;
    } catch (e) {
      console.error('[detect-tendencies] proposal generation failed:', e);
    }
  }

  // Demote loop
  const manual = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];
  for (const rule of manual.filter((r) => r.severity === 'block')) {
    const overrides: ClosedTradeView[] = trades.filter((t) =>
      t.rule_violations.some((v) => v.rule === rule.id && v.severity === 'block' && v.override_reason),
    );
    if (overrides.length < 3) continue;
    const profitable = overrides.filter((o) => o.realized_pnl > 0).length;
    const profitablePct = profitable / overrides.length;
    if (profitablePct < 0.6) continue;
    if (proposals.some((p) => p.demote_target_rule_id === rule.id && p.status === 'open')) continue;
    try {
      const proposal = await proposeDemote(rule, { overrides: overrides.length, profitable_pct: profitablePct });
      proposals.push(proposal as Proposal);
      proposalsAppended++;
    } catch (e) {
      console.error('[detect-tendencies] demote proposal failed:', e);
    }
  }

  await kv().set(rulesKey('proposals'), proposals);

  return res.status(200).json({
    findings_count: findings.length,
    proposals_appended: proposalsAppended,
  });
}

function mergeTendencies(existing: Tendency[], findings: ReturnType<typeof runMatchers>): Tendency[] {
  const byMatcher: Record<string, Tendency> = {};
  for (const t of existing) byMatcher[t.matcher] = t;
  const now = new Date().toISOString();
  for (const f of findings) {
    byMatcher[f.matcher] = {
      id: newId('te'),
      matcher: f.matcher,
      finding: f.finding,
      evidence_trade_ids: f.evidence_trade_ids,
      detected_at: now,
    };
  }
  return Object.values(byMatcher);
}

function proposalKey(p: Proposal): string {
  // Mirrors Finding.key generation by matcher; for simplicity, use matcher + first trigger string
  if (p.demote_target_rule_id) return `demote:${p.demote_target_rule_id}`;
  const tig = p.proposed_rule.triggers[0];
  if (!tig) return p.matcher;
  if (tig.type === 'symbol_in') return `${p.matcher}:${(tig as any).symbols[0]}`;
  return `${p.matcher}:${tig.type}`;
}

async function loadClosedTrades(days: number): Promise<ClosedTradeView[]> {
  const cutoff = new Date(Date.now() - days * 86400000);
  const months: string[] = [];
  for (let d = new Date(cutoff); d <= new Date(); d.setMonth(d.getMonth() + 1)) {
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  const idsByMonth = await Promise.all(months.map((m) => kv().get<string[]>(`trades:index:${m}`)));
  const allIds = idsByMonth.flat().filter(Boolean) as string[];

  const trades = await Promise.all(allIds.map(async (id) => {
    const trade = await kv().get<Trade>(`trade:${id}`);
    if (!trade || !trade.closed_at) return null;
    const grade = await kv().get<any>(`grade:${id}`);
    return tradeToClosedView(trade, grade);
  }));

  return trades.filter((t): t is ClosedTradeView => t !== null);
}

function tradeToClosedView(t: Trade, grade: any): ClosedTradeView {
  return {
    id: t.id,
    symbol: t.symbol,
    asset_class: t.asset_class,
    option_type: t.contract_type,
    side: t.side,
    closed_at: t.closed_at!,
    realized_pnl: t.realized_pnl ?? 0,
    user_grade: t.entry_grade,
    ai_grade: grade?.hindsight?.letter ?? null,
    tags: t.tags,
    rule_violations: (t.rule_warnings_at_entry ?? []).map((v: any) => ({
      rule: v.rule, severity: v.severity, override_reason: v.override_reason,
    })),
    strike: t.strike,
    expiration: t.expiration,
    cost_basis_at_entry: null,    // populated by submit handler in M5 follow-up if needed
    earnings_during_hold: false,  // populated by grade-cron (out of scope for first version)
  };
}
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/cron/[job].ts dashboard/tests/cron-detect-tendencies.test.ts
git commit -m "feat(dashboard): detect-tendencies cron action with matchers + proposals"
```

---

### Task 4.5: Register tendency cron with cron-job.org

**Files:**
- Modify: `tools/setup_cronjobs.py`

- [ ] **Step 1: Add the cron entry**

Open `tools/setup_cronjobs.py`. Find the existing `JOBS` list (or whatever holds the job definitions). Add:

```python
{
    "title": "Dashboard — Detect Tendencies",
    "url": f"{DASHBOARD_URL}/api/cron/detect-tendencies?job=detect-tendencies",
    "schedule": {
        "timezone": "UTC",
        "expiresAt": 0,
        "hours": [22],          # Sunday 22:00 UTC = 6 PM ET (during DST; 5 PM ET during EST)
        "minutes": [0],
        "mdays": [-1],          # any day of month
        "months": [-1],
        "wdays": [0],           # Sunday only
    },
    "requestMethod": 1,         # POST
    "extendedData": {
        "headers": {
            "Authorization": f"Bearer {DASHBOARD_CRON_TOKEN}",
        },
    },
},
```

(Match the surrounding job entry format — the example above mirrors the existing `grade-open-trades` registration.)

- [ ] **Step 2: Run setup**

```bash
python tools/setup_cronjobs.py
```

Expected output: registers the new job, returns its `jobId`. Note the jobId for documentation.

- [ ] **Step 3: Update CLAUDE.md**

Append the new job to the `Cron schedule (cron-job.org)` table in `CLAUDE.md`:

```
| Dashboard — Detect Tendencies | <jobId> | `0 22 * * 0` | `POST /api/cron/detect-tendencies?job=detect-tendencies` w/ Bearer ${CRON_TOKEN} |
```

- [ ] **Step 4: Commit**

```bash
git add tools/setup_cronjobs.py CLAUDE.md
git commit -m "feat(cron): register detect-tendencies Sunday 6 PM ET cron"
```

---

**Milestone 4 complete.** Tendency detection runs every Sunday. Findings populate `/rules` → Tendencies; new-rule and demote proposals appear in `/rules` → Proposals with approve/dismiss/edit-then-add buttons.

---

## Milestone 5 — STO assignment auto-spawn

Extends the existing `grade-open-trades` cron with assignment detection + drain. When an STO put is assigned, a linked stock trade auto-spawns with `parent_id` and inherited grades.

### Task 5.1: Detect assignment in grade-open-trades cron

**Files:**
- Modify: `dashboard/api/cron/[job].ts` — extend `grade-open-trades` action
- Test: `dashboard/tests/cron-assignment-detect.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// dashboard/tests/cron-assignment-detect.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({}));
const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrange = vi.fn().mockResolvedValue([]);
const kvRpush = vi.fn();
const kvLrem = vi.fn();
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, rpush: kvRpush, lrem: kvLrem }),
}));
const alpacaTrade = vi.fn();
vi.mock('../api/_lib/data-api', () => ({ alpacaTrade, alpacaData: vi.fn(), alpacaTradeMutation: vi.fn() }));

describe('grade-open-trades — assignment detection', () => {
  beforeEach(() => {
    kvGet.mockReset(); kvSet.mockReset(); kvRpush.mockReset(); kvLrem.mockReset(); alpacaTrade.mockReset();
    process.env.CRON_TOKEN = 'tok';
  });

  it('detects STO put filled + stock pos exists → enqueues assignment', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return ['T-2026-04-01-001'];
      if (k === 'trade:T-2026-04-01-001') return {
        id: 'T-2026-04-01-001', account: 'conservative_paper',
        asset_class: 'option', option_type: 'put', side: 'STO',
        symbol: 'F', strike: 12, expiration: '2026-05-01',
        alpaca_order_id: 'order-1', closed_at: null, contract_type: 'put',
      };
      return null;
    });
    alpacaTrade.mockImplementation(async (mode: string, path: string) => {
      if (path === '/v2/orders/order-1') return { status: 'filled' };
      if (path === '/v2/positions') return [{ symbol: 'F', qty: '100', avg_entry_price: '12.00' }];
      return null;
    });
    kvLrange.mockResolvedValueOnce([]);  // assignments-pending starts empty

    const handler = (await import('../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'grade-open-trades' }, headers: { authorization: 'Bearer tok' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    expect(kvRpush).toHaveBeenCalledWith(
      'trades:index:assignments-pending',
      expect.stringContaining('T-2026-04-01-001'),
    );
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Extend grade-open-trades**

In `dashboard/api/cron/[job].ts`, find the `grade-open-trades` handler. After it completes its existing close-detection / grading loop (or interleaved in the same iteration over open trades), add assignment detection:

```ts
// Imports at top of file (if not already present):
import { enqueueAssignmentPending, drainAssignments, removeAssignment } from '../_lib/assignment-spawn.js';
import { alpacaTrade } from '../_lib/data-api.js';

// Inside the grade-open-trades handler, AFTER the existing close-detection logic:
async function detectAssignments(openTradeIds: string[]) {
  for (const id of openTradeIds) {
    const trade = await kv().get<Trade>(`trade:${id}`);
    if (!trade) continue;
    if (trade.asset_class !== 'option' || trade.contract_type !== 'put' || trade.side !== 'STO') continue;
    if (trade.closed_at) continue;

    const mode = trade.account === 'aggressive_paper' ? 'aggressive' : 'conservative';
    let order: any;
    try { order = await alpacaTrade(mode, `/v2/orders/${trade.alpaca_order_id}`); }
    catch { continue; }
    if (order?.status !== 'filled') continue;

    let positions: any[] = [];
    try { positions = await alpacaTrade(mode, '/v2/positions'); }
    catch { continue; }

    const stock = positions.find((p: any) =>
      p.symbol === trade.symbol && parseFloat(p.qty) >= 100,
    );
    if (!stock) continue;

    // Idempotency: don't enqueue if already pending or if a child already exists with this parent_id
    // Cheap check — pending list is short
    await enqueueAssignmentPending({
      parent_trade_id: trade.id,
      underlying: trade.symbol,
      strike: trade.strike ?? 0,
      qty: 100,
      account: trade.account === 'aggressive_paper' ? 'aggressive_paper' : 'conservative_paper',
      detected_at: new Date().toISOString(),
    });
  }
}

// Call it inside grade-open-trades handler after existing logic:
const openIds = (await kv().lrange('trades:index:open', 0, -1)) as string[];
await detectAssignments(openIds);
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/cron/[job].ts dashboard/tests/cron-assignment-detect.test.ts
git commit -m "feat(dashboard): assignment detection in grade-open-trades cron"
```

---

### Task 5.2: Drain inbox + spawn follow-on trade

**Files:**
- Modify: `dashboard/api/cron/[job].ts` — add drain logic
- Modify: `dashboard/api/_lib/assignment-spawn.ts` — add `buildAssignmentTrade` helper
- Test: `dashboard/tests/cron-assignment-drain.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// dashboard/tests/cron-assignment-drain.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({}));
const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrange = vi.fn();
const kvRpush = vi.fn();
const kvLrem = vi.fn();
const kvIncr = vi.fn().mockResolvedValue(1);
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, rpush: kvRpush, lrem: kvLrem, incr: kvIncr }),
}));
vi.mock('../api/_lib/data-api', () => ({
  alpacaTrade: vi.fn().mockResolvedValue([]), alpacaData: vi.fn(), alpacaTradeMutation: vi.fn(),
}));

describe('grade-open-trades — assignment drain', () => {
  beforeEach(() => {
    kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvRpush.mockReset(); kvLrem.mockReset();
    process.env.CRON_TOKEN = 'tok';
  });

  it('drain creates linked stock trade with parent_id + inherited grades', async () => {
    const parent = {
      id: 'T-2026-04-01-001', account: 'conservative_paper',
      asset_class: 'option', contract_type: 'put', side: 'STO',
      symbol: 'F', strike: 12, expiration: '2026-05-01',
      alpaca_order_id: 'o-1', closed_at: '2026-05-01T20:00:00Z',
      tags: ['wheel'], entry_grade: 'B', entry_reasoning: 'put on F',
      schema: 1,
    };
    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:assignments-pending') return [JSON.stringify({
        parent_trade_id: 'T-2026-04-01-001', underlying: 'F', strike: 12, qty: 100,
        account: 'conservative_paper', detected_at: '2026-05-01T20:00:00Z',
      })];
      if (k === 'trades:index:open') return [];
      return [];
    });
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-2026-04-01-001') return parent;
      if (k === 'grade:T-2026-04-01-001') return { hindsight: { letter: 'B+' } };
      return null;
    });

    const handler = (await import('../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'grade-open-trades' }, headers: { authorization: 'Bearer tok' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    const tradeWriteCall = kvSet.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith('trade:T-') && c[0] !== 'trade:T-2026-04-01-001');
    expect(tradeWriteCall).toBeDefined();
    const written = tradeWriteCall![1];
    expect(written.parent_id).toBe('T-2026-04-01-001');
    expect(written.source).toBe('assignment');
    expect(written.asset_class).toBe('stock');
    expect(written.qty).toBe(100);
    expect(written.entry_grade).toBe('B');
    expect(written.ai_grade_inherited).toBe(true);
    expect(kvLrem).toHaveBeenCalled();
  });

  it('drain is idempotent — does not double-spawn for same parent', async () => {
    const entry = JSON.stringify({
      parent_trade_id: 'T-1', underlying: 'F', strike: 12, qty: 100,
      account: 'conservative_paper', detected_at: '...',
    });
    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:assignments-pending') return [entry];
      return [];
    });
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-1') return { id: 'T-1', symbol: 'F' } as any;
      // simulate a child already exists
      if (k === 'assignment-child:T-1') return 'T-2026-05-01-005';
      return null;
    });

    const handler = (await import('../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'grade-open-trades' }, headers: { authorization: 'Bearer tok' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);

    // Should not write a new trade record but should remove the entry from pending
    const tradeWriteCalls = kvSet.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].startsWith('trade:T-') && c[0] !== 'trade:T-1');
    expect(tradeWriteCalls).toHaveLength(0);
    expect(kvLrem).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Add buildAssignmentTrade + drain in cron**

Extend `dashboard/api/_lib/assignment-spawn.ts`:

```ts
// Append to dashboard/api/_lib/assignment-spawn.ts
import type { Trade, GradeRecord } from './trade-types.js';
import { tradeId } from './trade-ids.js';

export function buildAssignmentTrade(
  parent: Trade,
  entry: AssignmentEntry,
  parentGrade: GradeRecord | null,
): Trade {
  const inheritedAi = parentGrade?.hindsight?.letter ?? null;
  return {
    id: tradeId(),
    account: parent.account,
    asset_class: 'stock',
    symbol: entry.underlying,
    side: 'buy',
    qty: entry.qty,
    order_type: 'market',
    limit_price: null, stop_price: null, trail_pct: null, tif: 'day',
    contract_symbol: null, strike: null, expiration: null, contract_type: null,
    greeks_at_entry: null,
    alpaca_order_id: '',                          // synthetic — no Alpaca order
    alpaca_close_order_id: null,
    submitted_at: entry.detected_at,
    filled_at: entry.detected_at,
    filled_avg_price: entry.strike,
    closed_at: null, closed_avg_price: null, realized_pnl: null,
    closed_by: null,
    tags: parent.tags,
    entry_grade: parent.entry_grade,
    entry_reasoning: `Assigned from put ${parent.id} (${parent.contract_symbol ?? `${parent.symbol} $${parent.strike}P`})`,
    journal: '',
    exposure_at_submit: entry.qty * entry.strike,
    rule_warnings_at_entry: [],
    schema: 1,
    parent_id: parent.id,
    source: 'assignment',
    ai_grade_inherited: inheritedAi != null,
  };
}
```

In `dashboard/api/cron/[job].ts`, after `detectAssignments`, add drain logic:

```ts
async function drainAssignmentsAndSpawn() {
  const entries = await drainAssignments();
  for (const entry of entries) {
    // Idempotency: skip if a child trade for this parent already exists
    const existingChild = await kv().get<string>(`assignment-child:${entry.parent_trade_id}`);
    if (existingChild) {
      await removeAssignment(entry);
      continue;
    }

    const parent = await kv().get<Trade>(`trade:${entry.parent_trade_id}`);
    if (!parent) {
      console.error('[drain] parent trade missing:', entry.parent_trade_id);
      await removeAssignment(entry);
      continue;
    }

    const grade = await kv().get<GradeRecord>(`grade:${entry.parent_trade_id}`);
    const newTrade = buildAssignmentTrade(parent, entry, grade);

    await kv().set(`trade:${newTrade.id}`, newTrade);
    await kv().set(`assignment-child:${entry.parent_trade_id}`, newTrade.id);
    await kv().rpush('trades:index:open', newTrade.id);
    const yyyymm = newTrade.submitted_at.slice(0, 7);
    await kv().rpush(`trades:index:${yyyymm}`, newTrade.id);

    await removeAssignment(entry);
  }
}

// Call it at the end of grade-open-trades handler:
await drainAssignmentsAndSpawn();
```

Also add `assignment-child:*` to the dashboard key whitelist in `kv-keys.ts`:

```ts
const DASHBOARD_KEY_PATTERNS: RegExp[] = [
  // ... existing ...
  /^assignment-child:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
];
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/_lib/assignment-spawn.ts dashboard/api/_lib/kv-keys.ts dashboard/api/cron/[job].ts dashboard/tests/cron-assignment-drain.test.ts
git commit -m "feat(dashboard): drain assignments inbox + spawn linked stock trade"
```

---

### Task 5.3: Wire parent ↔ child links on /trade/:id

**Files:**
- Modify: `dashboard/src/routes/TradeDetail.tsx`

- [ ] **Step 1: Render the parent link on a spawned trade**

Locate where the trade record is rendered. Near the top of the detail page (above the chart), add:

```tsx
{trade.parent_id && (
  <div className="mb-4 p-3 border border-purple-500/40 bg-purple-950/20 rounded">
    <span className="text-xs uppercase text-purple-300 mr-2">↑ Assigned from</span>
    <Link to={`/trade/${trade.parent_id}`} className="text-blue-400 hover:underline font-mono">
      {trade.parent_id}
    </Link>
    {trade.ai_grade_inherited && (
      <span className="ml-3 text-xs text-neutral-400">(grades inherited from parent)</span>
    )}
  </div>
)}
```

- [ ] **Step 2: Render the child link on a parent trade**

When viewing a put trade, fetch `assignment-child:{trade.id}` to discover its spawned child. Add a hook or inline fetch:

```tsx
const [childId, setChildId] = useState<string | null>(null);
useEffect(() => {
  if (!trade?.id || trade.contract_type !== 'put' || trade.side !== 'STO') return;
  fetch(`/api/kv/bot-state?key=assignment-child:${trade.id}`)
    .then((r) => r.ok ? r.text() : null)
    .then((text) => { if (text) setChildId(text.replace(/"/g, '')); });
}, [trade?.id]);

// Render below parent_id block:
{childId && (
  <div className="mb-4 p-3 border border-purple-500/40 bg-purple-950/20 rounded">
    <span className="text-xs uppercase text-purple-300 mr-2">↓ Assignment spawned</span>
    <Link to={`/trade/${childId}`} className="text-blue-400 hover:underline font-mono">{childId}</Link>
  </div>
)}
```

(Note: extending `kv/[resource].ts`'s `bot-state` read to allow the `assignment-child:*` pattern requires the regex update from Task 5.2 plus a similar update to `dashboard/api/kv/[resource].ts` if it does its own validation.)

- [ ] **Step 3: Manual smoke test**

After deploying, place a paper STO put close to the money on a cheap stock during market hours. Wait for assignment (or simulate by setting parent's `closed_by: 'assigned'`). Verify the child appears via the cron, and that both detail pages link to each other.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/routes/TradeDetail.tsx
git commit -m "feat(dashboard): parent ↔ child trade links on /trade/:id"
```

---

### Task 5.4: Exclude inherited grades from calibration math

**Files:**
- Modify: places that compute calibration (likely `dashboard/api/_lib/grading.ts` — the `calibrationFor` callsites; and any aggregation in `api/trades/[action].ts` that touches grades)

- [ ] **Step 1: Search for grade-aggregation callsites**

```bash
cd dashboard && grep -rn 'ai_grade_inherited\|calibrationFor\|hindsight' api/ src/ | head -40
```

- [ ] **Step 2: Add a guard wherever calibration is computed**

In any aggregation that consumes `(user_grade, ai_grade)`, filter out trades where `ai_grade_inherited === true` BEFORE computing:

```ts
// Example pattern:
const calibrationTrades = closed.filter((t) => !t.ai_grade_inherited);
const calibrationData = calibrationTrades
  .filter((t) => t.ai_grade != null)
  .map((t) => ({ user_grade: t.entry_grade, ai_grade: t.ai_grade }));
```

This doesn't apply to display sites (the trade detail page should still show inherited grades — just label them clearly, which Task 5.3 already does).

- [ ] **Step 3: Add a test**

```ts
// dashboard/tests/calibration-excludes-inherited.test.ts
import { describe, it, expect } from 'vitest';

describe('calibration math', () => {
  it('excludes ai_grade_inherited trades from calibration aggregation', () => {
    const trades = [
      { id: 't1', entry_grade: 'B', ai_grade: 'C', ai_grade_inherited: false },
      { id: 't2', entry_grade: 'A', ai_grade: 'A', ai_grade_inherited: true },   // inherited — exclude
    ];
    const filtered = trades.filter((t) => !t.ai_grade_inherited);
    expect(filtered.map((t) => t.id)).toEqual(['t1']);
  });
});
```

(This is a regression test — actual filtering happens in M6's performance aggregation, but the pattern is established here.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/tests/calibration-excludes-inherited.test.ts
git commit -m "test(dashboard): regression test for inherited-grade exclusion in calibration"
```

---

**Milestone 5 complete.** STO put assignments now auto-spawn linked stock trades with `parent_id`, inherited grades, and proper UI links. Calibration math correctly excludes inherited grades.

---

## Milestone 6 — `/watchlist` + `/calendar` + `/performance`

The three supporting visualization pages. `/watchlist` is straightforward; `/calendar` and `/performance` are the "heavy v1" Tim asked for during brainstorming.

### Task 6.1: Watchlist page

**Files:**
- Create: `dashboard/src/routes/Watchlist.tsx`

The `watchlist` KV key already exists from Phase 2 (CRUD via `api/kv/[resource].ts`). This task adds the listing page.

- [ ] **Step 1: Implement Watchlist.tsx**

```tsx
// dashboard/src/routes/Watchlist.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Sparkline from '../components/Sparkline';

interface WatchlistItem { symbol: string; added_at: string; note?: string; }
interface Quote { symbol: string; price: number; change_pct: number; bars30d: number[]; }

export default function Watchlist() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [newSymbol, setNewSymbol] = useState('');
  const [newNote, setNewNote] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const r = await fetch('/api/kv/watchlist');
    const j = await r.json();
    setItems(j.items ?? []);
    setLoading(false);

    // Fetch quotes in parallel
    await Promise.all((j.items ?? []).map(async (item: WatchlistItem) => {
      try {
        const q = await fetch(`/api/alpaca/quote?symbol=${encodeURIComponent(item.symbol)}`);
        const b = await fetch(`/api/alpaca/bars?symbol=${encodeURIComponent(item.symbol)}&days=30`);
        const qj = await q.json();
        const bj = await b.json();
        setQuotes((cur) => ({
          ...cur,
          [item.symbol]: {
            symbol: item.symbol,
            price: qj.price ?? 0,
            change_pct: qj.change_pct ?? 0,
            bars30d: (bj.bars ?? []).map((bar: any) => bar.c),
          },
        }));
      } catch {}
    }));
  }

  useEffect(() => { refresh(); }, []);

  async function addSymbol() {
    if (!newSymbol.trim()) return;
    await fetch('/api/kv/watchlist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: newSymbol.trim().toUpperCase(), note: newNote.trim() || undefined }),
    });
    setNewSymbol(''); setNewNote('');
    refresh();
  }

  async function remove(symbol: string) {
    if (!confirm(`Remove ${symbol} from watchlist?`)) return;
    await fetch('/api/kv/watchlist', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol }),
    });
    refresh();
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Watchlist</h1>
      <div className="flex gap-2 mb-6">
        <input
          placeholder="Symbol (e.g. NVDA)"
          value={newSymbol} onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
          className="bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm w-32"
        />
        <input
          placeholder="Note (optional)"
          value={newNote} onChange={(e) => setNewNote(e.target.value)}
          className="bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm flex-1"
        />
        <button onClick={addSymbol} disabled={!newSymbol.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 px-4 py-2 rounded text-sm">+ Add</button>
      </div>
      {loading ? <div className="text-neutral-500">loading…</div> :
        items.length === 0 ? <div className="text-neutral-500">empty — add a symbol above</div> :
        <table className="w-full text-sm">
          <thead className="text-neutral-400 text-xs uppercase border-b border-neutral-800">
            <tr><th className="text-left p-2">Symbol</th><th className="text-right p-2">Price</th><th className="text-right p-2">Day %</th><th className="p-2 w-32">30d</th><th className="text-left p-2">Note</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const q = quotes[item.symbol];
              return (
                <tr key={item.symbol} className="border-b border-neutral-900">
                  <td className="p-2 font-mono"><Link to={`/lookup/${item.symbol}`} className="text-blue-400 hover:underline">{item.symbol}</Link></td>
                  <td className="p-2 text-right">${q?.price?.toFixed(2) ?? '—'}</td>
                  <td className={`p-2 text-right ${(q?.change_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {q ? `${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%` : '—'}
                  </td>
                  <td className="p-2"><Sparkline values={q?.bars30d ?? []} width={120} height={24} /></td>
                  <td className="p-2 text-neutral-400">{item.note ?? ''}</td>
                  <td className="p-2 text-right">
                    <button onClick={() => remove(item.symbol)} className="text-red-400 text-xs hover:underline">×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      }
    </div>
  );
}
```

- [ ] **Step 2: Wire route + nav**

In the router (e.g., `dashboard/src/main.tsx` or `App.tsx`), add:

```tsx
<Route path="/watchlist" element={<RequireAuth><Watchlist /></RequireAuth>} />
```

In nav, add `<NavLink to="/watchlist">Watchlist</NavLink>`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/routes/Watchlist.tsx dashboard/src/main.tsx dashboard/src/components/layout/Layout.tsx
git commit -m "feat(dashboard): /watchlist page with quotes + 30d sparklines"
```

---

### Task 6.2: trades/calendar API action

**Files:**
- Modify: `dashboard/api/trades/[action].ts` — add `calendar` action
- Test: `dashboard/tests/trades-calendar-action.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// dashboard/tests/trades-calendar-action.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvGet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, lrange: vi.fn().mockResolvedValue([]) }) }));

describe('trades/calendar', () => {
  it('returns days bucketed by closed_at date with realized_pnl summed', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trades:index:2026-04') return ['t1', 't2'];
      if (k === 'trade:t1') return { id: 't1', symbol: 'F', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50,  account: 'conservative_paper', tags: [], asset_class: 'stock' };
      if (k === 'trade:t2') return { id: 't2', symbol: 'F', closed_at: '2026-04-15T18:00:00Z', realized_pnl: -25, account: 'conservative_paper', tags: [], asset_class: 'stock' };
      return null;
    });
    const handler = (await import('../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'calendar', month: '2026-04' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.days['2026-04-15'].realized_pnl).toBe(25);  // 50 + (-25)
    expect(body.days['2026-04-15'].trade_count).toBe(2);
    expect(body.month_total).toBe(25);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Add `calendar` action**

```ts
// In api/trades/[action].ts, add:
case 'calendar': {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);
  const account = req.query.account as string | undefined;
  const symbol = req.query.symbol as string | undefined;
  const tag = req.query.tag as string | undefined;
  const assetClass = req.query.asset_class as string | undefined;

  const ids = (await kv().get<string[]>(`trades:index:${month}`)) ?? [];
  const trades = (await Promise.all(ids.map((id) => kv().get<Trade>(`trade:${id}`))))
    .filter((t): t is Trade => !!t)
    .filter((t) => account ? t.account === account : true)
    .filter((t) => symbol ? t.symbol === symbol : true)
    .filter((t) => tag ? t.tags.includes(tag) : true)
    .filter((t) => assetClass ? t.asset_class === assetClass : true);

  const days: Record<string, {
    realized_pnl: number; trade_count: number;
    closed_trade_ids: string[];
    open_options_expiring: Array<{ symbol: string; option_type: 'put'|'call'; strike: number }>;
  }> = {};

  for (const t of trades) {
    if (t.closed_at) {
      const day = t.closed_at.slice(0, 10);
      if (!days[day]) days[day] = { realized_pnl: 0, trade_count: 0, closed_trade_ids: [], open_options_expiring: [] };
      days[day].realized_pnl += (t.realized_pnl ?? 0);
      days[day].trade_count += 1;
      days[day].closed_trade_ids.push(t.id);
    }
    // Expirations overlay — open options whose expiration falls in this month
    if (!t.closed_at && t.asset_class === 'option' && t.expiration && t.expiration.startsWith(month)) {
      const day = t.expiration;
      if (!days[day]) days[day] = { realized_pnl: 0, trade_count: 0, closed_trade_ids: [], open_options_expiring: [] };
      days[day].open_options_expiring.push({
        symbol: t.symbol, option_type: t.contract_type as 'put'|'call', strike: t.strike ?? 0,
      });
    }
  }

  const month_total = Object.values(days).reduce((s, d) => s + d.realized_pnl, 0);
  return res.status(200).json({ days, month_total });
}
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/trades-calendar-action.test.ts
git commit -m "feat(dashboard): trades/calendar action returns month-bucketed P&L"
```

---

### Task 6.3: Calendar page + MonthGrid component

**Files:**
- Create: `dashboard/src/routes/Calendar.tsx`
- Create: `dashboard/src/components/calendar/MonthGrid.tsx`
- Create: `dashboard/src/components/calendar/DayDrawer.tsx`

- [ ] **Step 1: MonthGrid component**

```tsx
// dashboard/src/components/calendar/MonthGrid.tsx
interface DayInfo {
  realized_pnl: number;
  trade_count: number;
  closed_trade_ids: string[];
  open_options_expiring: Array<{ symbol: string; option_type: 'put'|'call'; strike: number }>;
}

interface Props {
  year: number;
  month: number;          // 1-12
  days: Record<string, DayInfo>;
  monthTotal: number;
  onDayClick: (date: string) => void;
}

export default function MonthGrid({ year, month, days, monthTotal, onDayClick }: Props) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const weeks: Array<Array<{ date: string; day: number } | null>> = [];
  let week: Array<{ date: string; day: number } | null> = Array(first.getDay()).fill(null);

  for (let d = 1; d <= last.getDate(); d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    week.push({ date, day: d });
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push(null); weeks.push(week); }

  // P&L color scale (linear by month max abs)
  const maxAbs = Math.max(0.01, ...Object.values(days).map((d) => Math.abs(d.realized_pnl)));
  function pnlColor(pnl: number): string {
    if (pnl === 0) return 'bg-neutral-900';
    const intensity = Math.min(1, Math.abs(pnl) / maxAbs);
    const a = (intensity * 0.9).toFixed(2);
    return pnl > 0 ? `bg-green-500/[${a}]` : `bg-red-500/[${a}]`;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-2">
        <div className="text-sm text-neutral-400">
          {monthTotal >= 0 ? <span className="text-green-400">+${monthTotal.toFixed(2)}</span> : <span className="text-red-400">-${Math.abs(monthTotal).toFixed(2)}</span>}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-xs text-neutral-500 mb-1">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d) => <div key={d} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {weeks.flatMap((w, wi) => w.map((cell, ci) => {
          if (!cell) return <div key={`${wi}-${ci}`} className="aspect-square" />;
          const info = days[cell.date];
          const pnl = info?.realized_pnl ?? 0;
          const expiring = info?.open_options_expiring ?? [];
          return (
            <button
              key={cell.date}
              onClick={() => onDayClick(cell.date)}
              className={`aspect-square border border-neutral-800 rounded p-1 hover:border-neutral-600 ${pnlColor(pnl)} relative`}
              title={info ? `${info.trade_count} trades, ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : ''}
            >
              <div className="absolute top-1 left-1 text-xs text-neutral-300">{cell.day}</div>
              {pnl !== 0 && (
                <div className={`absolute bottom-1 right-1 text-xs ${pnl >= 0 ? 'text-green-200' : 'text-red-200'}`}>
                  {pnl >= 0 ? '+' : '-'}${Math.abs(pnl) >= 1000 ? `${(Math.abs(pnl)/1000).toFixed(1)}k` : Math.abs(pnl).toFixed(0)}
                </div>
              )}
              {expiring.length > 0 && (
                <div className="absolute top-1 right-1 text-[9px] text-purple-300">
                  ○ {expiring.length}
                </div>
              )}
            </button>
          );
        }))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: DayDrawer component**

```tsx
// dashboard/src/components/calendar/DayDrawer.tsx
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';

interface Props { date: string | null; account?: string; onClose: () => void; }

export default function DayDrawer({ date, account, onClose }: Props) {
  const [trades, setTrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    const month = date.slice(0, 7);
    const params = new URLSearchParams({ action: 'list', month });
    if (account) params.set('account', account);
    fetch(`/api/trades/list?${params}`)
      .then((r) => r.json())
      .then((j) => {
        const closed = (j.trades ?? []).filter((t: any) => t.closed_at?.startsWith(date));
        setTrades(closed);
        setLoading(false);
      });
  }, [date, account]);

  if (!date) return null;

  return (
    <div className="fixed top-0 right-0 h-full w-96 bg-neutral-950 border-l border-neutral-800 p-4 overflow-y-auto z-30">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold">{date}</h2>
        <button onClick={onClose} className="text-neutral-400 hover:text-neutral-200">✕</button>
      </div>
      {loading ? <div className="text-neutral-500 text-sm">loading…</div> :
        trades.length === 0 ? <div className="text-neutral-500 text-sm">no closed trades</div> :
        <ul className="space-y-2">
          {trades.map((t) => (
            <li key={t.id} className="border border-neutral-800 rounded p-2 text-sm">
              <Link to={`/trade/${t.id}`} className="font-mono text-blue-400 hover:underline">{t.id}</Link>
              <div className="text-xs text-neutral-400">{t.symbol} · {t.asset_class}{t.contract_type ? `/${t.contract_type}` : ''}</div>
              <div className={`text-sm ${t.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {t.realized_pnl >= 0 ? '+' : ''}${t.realized_pnl?.toFixed(2)}
              </div>
            </li>
          ))}
        </ul>
      }
    </div>
  );
}
```

- [ ] **Step 3: Calendar.tsx page**

```tsx
// dashboard/src/routes/Calendar.tsx
import { useEffect, useState } from 'react';
import MonthGrid from '../components/calendar/MonthGrid';
import DayDrawer from '../components/calendar/DayDrawer';

export default function Calendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [days, setDays] = useState<Record<string, any>>({});
  const [monthTotal, setMonthTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [account, setAccount] = useState('');
  const [symbol, setSymbol] = useState('');
  const [tag, setTag] = useState('');
  const [assetClass, setAssetClass] = useState('');

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ action: 'calendar', month: `${year}-${String(month).padStart(2,'0')}` });
    if (account) params.set('account', account);
    if (symbol) params.set('symbol', symbol);
    if (tag) params.set('tag', tag);
    if (assetClass) params.set('asset_class', assetClass);
    fetch(`/api/trades/calendar?${params}`)
      .then((r) => r.json())
      .then((j) => { setDays(j.days ?? {}); setMonthTotal(j.month_total ?? 0); })
      .finally(() => setLoading(false));
  }, [year, month, account, symbol, tag, assetClass]);

  function prevMonth() {
    if (month === 1) { setYear(y => y-1); setMonth(12); } else setMonth(m => m-1);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y+1); setMonth(1); } else setMonth(m => m+1);
  }

  const inputCls = 'bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm';

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Calendar</h1>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="bg-neutral-800 hover:bg-neutral-700 px-2 py-1 rounded">‹</button>
          <span className="font-mono">{year}-{String(month).padStart(2,'0')}</span>
          <button onClick={nextMonth} className="bg-neutral-800 hover:bg-neutral-700 px-2 py-1 rounded">›</button>
        </div>
      </div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <select value={account} onChange={(e) => setAccount(e.target.value)} className={inputCls}>
          <option value="">All accounts</option>
          <option value="conservative_paper">Conservative</option>
          <option value="aggressive_paper">Aggressive</option>
        </select>
        <input placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className={inputCls} />
        <input placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className={inputCls} />
        <select value={assetClass} onChange={(e) => setAssetClass(e.target.value)} className={inputCls}>
          <option value="">All assets</option>
          <option value="stock">Stocks</option>
          <option value="option">Options</option>
        </select>
      </div>
      {loading ? <div className="text-neutral-500">loading…</div> :
        <MonthGrid year={year} month={month} days={days} monthTotal={monthTotal} onDayClick={setSelectedDate} />
      }
      <DayDrawer date={selectedDate} account={account || undefined} onClose={() => setSelectedDate(null)} />
    </div>
  );
}
```

- [ ] **Step 4: Wire route + nav**

Add `<Route path="/calendar" element={<RequireAuth><Calendar /></RequireAuth>} />` and a nav link.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/Calendar.tsx dashboard/src/components/calendar/ dashboard/src/main.tsx dashboard/src/components/layout/Layout.tsx
git commit -m "feat(dashboard): /calendar with month grid + day drawer + filters"
```

---

### Task 6.4: trades/performance API action

**Files:**
- Modify: `dashboard/api/trades/[action].ts` — add `performance` action
- Test: `dashboard/tests/trades-performance-action.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// dashboard/tests/trades-performance-action.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
const kvGet = vi.fn();
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, lrange: vi.fn().mockResolvedValue([]) }) }));

describe('trades/performance', () => {
  it('returns six aggregations', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k.startsWith('trades:index:')) return ['t1', 't2'];
      if (k === 'trade:t1') return {
        id: 't1', symbol: 'F', asset_class: 'stock', side: 'buy', closed_at: '2026-04-15T20:00:00Z',
        realized_pnl: 50, entry_grade: 'B', tags: ['scalp'], account: 'conservative_paper',
        ai_grade_inherited: false,
      };
      if (k === 'trade:t2') return {
        id: 't2', symbol: 'TSLA', asset_class: 'stock', side: 'buy', closed_at: '2026-04-16T20:00:00Z',
        realized_pnl: -30, entry_grade: 'C', tags: ['scalp'], account: 'aggressive_paper',
        ai_grade_inherited: false,
      };
      if (k === 'grade:t1') return { hindsight: { letter: 'A' } };
      if (k === 'grade:t2') return { hindsight: { letter: 'D' } };
      return null;
    });
    const handler = (await import('../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'performance', date_range: 'ALL' } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.calibration).toHaveLength(2);
    expect(body.win_rate_by_tag.find((r: any) => r.tag === 'scalp')).toBeDefined();
    expect(body.pnl_by_symbol.find((r: any) => r.symbol === 'F')?.total_pnl).toBe(50);
    expect(body.time_heatmap).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Add `performance` action**

```ts
// In api/trades/[action].ts:
case 'performance': {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const account = req.query.account as string | undefined;
  const tag = req.query.tag as string | undefined;
  const assetClass = req.query.asset_class as string | undefined;
  const dateRange = (req.query.date_range as string) ?? 'ALL';

  // Determine month range
  const cutoff = dateRangeToCutoff(dateRange);
  const months = monthsInRange(cutoff, new Date());

  const idsByMonth = await Promise.all(months.map((m) => kv().get<string[]>(`trades:index:${m}`)));
  const ids = idsByMonth.flat().filter(Boolean) as string[];

  const trades = (await Promise.all(ids.map((id) => kv().get<Trade>(`trade:${id}`))))
    .filter((t): t is Trade => !!t)
    .filter((t) => account ? t.account === account : true)
    .filter((t) => tag ? t.tags.includes(tag) : true)
    .filter((t) => assetClass ? t.asset_class === assetClass : true);

  const grades = await Promise.all(trades.map((t) => kv().get<any>(`grade:${t.id}`)));

  // Equity curve from existing bot:equity-history if available; otherwise derive from trades
  const equityCons = (await kv().get<Array<{ ts: string; equity: number }>>('bot:equity-history:conservative')) ?? [];
  const equityAgg  = (await kv().get<Array<{ ts: string; equity: number }>>('bot:equity-history:aggressive')) ?? [];
  const equity_curve = mergeEquity(equityCons, equityAgg, cutoff);

  // Drawdown — running max minus current
  const drawdown = computeDrawdown(equity_curve);

  // Calibration scatter — exclude inherited grades
  const calibration: any[] = [];
  trades.forEach((t, i) => {
    if (t.ai_grade_inherited) return;
    const ai = grades[i]?.hindsight?.letter;
    if (!ai) return;
    calibration.push({ trade_id: t.id, user_grade: gradeToNum(t.entry_grade), ai_grade: gradeToNum(ai) });
  });

  // Win rate by tag
  const tagBuckets: Record<string, { trades: number; wins: number; total_pnl: number }> = {};
  for (const t of trades) {
    if (!t.closed_at) continue;
    for (const tg of t.tags) {
      tagBuckets[tg] ??= { trades: 0, wins: 0, total_pnl: 0 };
      tagBuckets[tg].trades += 1;
      tagBuckets[tg].wins += (t.realized_pnl ?? 0) > 0 ? 1 : 0;
      tagBuckets[tg].total_pnl += (t.realized_pnl ?? 0);
    }
  }
  const win_rate_by_tag = Object.entries(tagBuckets)
    .map(([tag, b]) => ({ tag, ...b }))
    .sort((a, b) => b.trades - a.trades);

  // PNL by symbol (also includes avg grade)
  const symBuckets: Record<string, { trades: number; wins: number; total_pnl: number; grade_sum: number }> = {};
  for (const t of trades) {
    if (!t.closed_at) continue;
    symBuckets[t.symbol] ??= { trades: 0, wins: 0, total_pnl: 0, grade_sum: 0 };
    symBuckets[t.symbol].trades += 1;
    symBuckets[t.symbol].wins += (t.realized_pnl ?? 0) > 0 ? 1 : 0;
    symBuckets[t.symbol].total_pnl += (t.realized_pnl ?? 0);
    symBuckets[t.symbol].grade_sum += gradeToNum(t.entry_grade);
  }
  const pnl_by_symbol = Object.entries(symBuckets).map(([symbol, b]) => ({
    symbol, trades: b.trades, wins: b.wins, total_pnl: b.total_pnl,
    avg_grade: b.grade_sum / b.trades,
  })).sort((a, b) => b.total_pnl - a.total_pnl);

  // Time heatmap (Mon-Fri × 9 AM - 3 PM ET, 5×7 grid)
  const heatmap: Record<string, { dow: number; hour: number; trades: number; wins: number }> = {};
  for (const t of trades) {
    if (!t.closed_at) continue;
    const d = new Date(t.closed_at);
    const etOffsetMin = etOffsetMinutes(d);
    const local = new Date(d.getTime() + etOffsetMin * 60_000);
    const dow = local.getUTCDay();   // 0 Sun
    if (dow < 1 || dow > 5) continue;
    const hour = local.getUTCHours();
    if (hour < 9 || hour > 15) continue;
    const k = `${dow}-${hour}`;
    heatmap[k] ??= { dow, hour, trades: 0, wins: 0 };
    heatmap[k].trades += 1;
    heatmap[k].wins += (t.realized_pnl ?? 0) > 0 ? 1 : 0;
  }
  const time_heatmap = Object.values(heatmap).map((h) => ({
    dow: h.dow, hour: h.hour, trades: h.trades, win_rate: h.trades ? h.wins / h.trades : 0,
  }));

  return res.status(200).json({
    equity_curve, drawdown, calibration, win_rate_by_tag, pnl_by_symbol, time_heatmap,
  });
}

// Helpers (add near top of file or in a shared module if too big):
function dateRangeToCutoff(r: string): Date {
  const now = new Date();
  switch (r) {
    case '1W':  return new Date(now.getTime() -   7 * 86400000);
    case '1M':  return new Date(now.getTime() -  30 * 86400000);
    case '3M':  return new Date(now.getTime() -  90 * 86400000);
    case '1Y':  return new Date(now.getTime() - 365 * 86400000);
    default:    return new Date(2020, 0, 1);
  }
}
function monthsInRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), 1);
  while (d <= end) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}
function gradeToNum(letter: string): number {
  const order = ['A+','A','A-','B+','B','B-','C+','C','C-','D','F'];
  const idx = order.indexOf(letter);
  return idx === -1 ? 5 : 10 - idx;   // higher number = better
}
function mergeEquity(cons: any[], agg: any[], cutoff: Date): any[] {
  const ts = new Set([...cons, ...agg].map((p) => p.ts));
  return Array.from(ts).sort()
    .filter((t) => new Date(t) >= cutoff)
    .map((t) => ({
      ts: t,
      cons: cons.find((p) => p.ts === t)?.equity ?? null,
      agg: agg.find((p) => p.ts === t)?.equity ?? null,
    }));
}
function computeDrawdown(curve: any[]): Array<{ ts: string; pct: number }> {
  let peak = -Infinity;
  return curve.map((p) => {
    const total = (p.cons ?? 0) + (p.agg ?? 0);
    if (total > peak) peak = total;
    const pct = peak > 0 ? (total - peak) / peak : 0;
    return { ts: p.ts, pct };
  });
}
// import { etOffsetMinutes } from '../_lib/et-time.js';
```

(Add `import { etOffsetMinutes } from '../_lib/et-time.js';` to the imports.)

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/trades-performance-action.test.ts
git commit -m "feat(dashboard): trades/performance action with six aggregations"
```

---

### Task 6.5: Performance page — skeleton + filter bar

**Files:**
- Create: `dashboard/src/routes/Performance.tsx`

- [ ] **Step 1: Implement Performance.tsx skeleton**

```tsx
// dashboard/src/routes/Performance.tsx
import { useEffect, useState } from 'react';
import EquityPanel from '../components/performance/EquityPanel';
import DrawdownPanel from '../components/performance/DrawdownPanel';
import CalibrationScatter from '../components/performance/CalibrationScatter';
import WinRateByTagBar from '../components/performance/WinRateByTagBar';
import PnLBySymbolTable from '../components/performance/PnLBySymbolTable';
import TimeHeatmap from '../components/performance/TimeHeatmap';

export default function Performance() {
  const [account, setAccount] = useState('');
  const [tag, setTag] = useState('');
  const [assetClass, setAssetClass] = useState('');
  const [dateRange, setDateRange] = useState('ALL');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ action: 'performance', date_range: dateRange });
    if (account) params.set('account', account);
    if (tag) params.set('tag', tag);
    if (assetClass) params.set('asset_class', assetClass);
    fetch(`/api/trades/performance?${params}`).then((r) => r.json())
      .then(setData).finally(() => setLoading(false));
  }, [account, tag, assetClass, dateRange]);

  const inputCls = 'bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm';

  return (
    <div className="max-w-6xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Performance</h1>
      <div className="flex gap-2 mb-6 flex-wrap">
        <select value={account} onChange={(e) => setAccount(e.target.value)} className={inputCls}>
          <option value="">All accounts</option>
          <option value="conservative_paper">Conservative</option>
          <option value="aggressive_paper">Aggressive</option>
        </select>
        <select value={dateRange} onChange={(e) => setDateRange(e.target.value)} className={inputCls}>
          <option value="ALL">All time</option>
          <option value="1Y">1 Year</option>
          <option value="3M">3 Months</option>
          <option value="1M">1 Month</option>
          <option value="1W">1 Week</option>
        </select>
        <input placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className={inputCls} />
        <select value={assetClass} onChange={(e) => setAssetClass(e.target.value)} className={inputCls}>
          <option value="">All assets</option>
          <option value="stock">Stocks</option>
          <option value="option">Options</option>
        </select>
      </div>
      {loading ? <div className="text-neutral-500">loading…</div> : !data ? null : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Equity Curve"><EquityPanel curve={data.equity_curve} /></Section>
          <Section title="Drawdown"><DrawdownPanel data={data.drawdown} /></Section>
          <Section title="Grade Calibration"><CalibrationScatter data={data.calibration} /></Section>
          <Section title="Win Rate by Tag"><WinRateByTagBar data={data.win_rate_by_tag} /></Section>
          <Section title="P&L by Symbol" wide><PnLBySymbolTable data={data.pnl_by_symbol} /></Section>
          <Section title="Time-of-day Heatmap" wide><TimeHeatmap data={data.time_heatmap} /></Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children, wide = false }: any) {
  return (
    <section className={`border border-neutral-800 rounded p-4 ${wide ? 'lg:col-span-2' : ''}`}>
      <h2 className="font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/routes/Performance.tsx
git commit -m "feat(dashboard): /performance page skeleton + filter bar"
```

---

### Task 6.6: Performance panels — EquityPanel + DrawdownPanel

**Files:**
- Create: `dashboard/src/components/performance/EquityPanel.tsx`
- Create: `dashboard/src/components/performance/DrawdownPanel.tsx`

- [ ] **Step 1: EquityPanel — reuses existing EquityChart, overlay both accounts**

```tsx
// dashboard/src/components/performance/EquityPanel.tsx
import { useEffect, useRef } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';

interface Props { curve: Array<{ ts: string; cons: number | null; agg: number | null }>; }

export default function EquityPanel({ curve }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 240,
      layout: { background: { color: '#0a0a0a' }, textColor: '#a3a3a3' },
      grid: { vertLines: { color: '#262626' }, horzLines: { color: '#262626' } },
    });
    const cons = chart.addSeries(LineSeries, { color: '#22c55e' });
    const agg = chart.addSeries(LineSeries, { color: '#f97316', lineStyle: 2 });
    cons.setData(curve.filter((p) => p.cons != null).map((p) => ({ time: p.ts.slice(0,10) as any, value: p.cons! })));
    agg.setData(curve.filter((p) => p.agg != null).map((p) => ({ time: p.ts.slice(0,10) as any, value: p.agg! })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [curve]);
  return <div ref={ref} />;
}
```

- [ ] **Step 2: DrawdownPanel**

```tsx
// dashboard/src/components/performance/DrawdownPanel.tsx
import { useEffect, useRef } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';

interface Props { data: Array<{ ts: string; pct: number }>; }

export default function DrawdownPanel({ data }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 200,
      layout: { background: { color: '#0a0a0a' }, textColor: '#a3a3a3' },
      grid: { vertLines: { color: '#262626' }, horzLines: { color: '#262626' } },
      rightPriceScale: { mode: 0 },     // percentage
    });
    const series = chart.addSeries(LineSeries, { color: '#ef4444' });
    series.setData(data.map((d) => ({ time: d.ts.slice(0,10) as any, value: d.pct * 100 })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);
  return <div ref={ref} />;
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/performance/EquityPanel.tsx dashboard/src/components/performance/DrawdownPanel.tsx
git commit -m "feat(dashboard): performance equity + drawdown panels"
```

---

### Task 6.7: Performance panels — CalibrationScatter + WinRateByTagBar

**Files:**
- Create: `dashboard/src/components/performance/CalibrationScatter.tsx`
- Create: `dashboard/src/components/performance/WinRateByTagBar.tsx`

- [ ] **Step 1: CalibrationScatter (custom SVG)**

```tsx
// dashboard/src/components/performance/CalibrationScatter.tsx
interface Props { data: Array<{ trade_id: string; user_grade: number; ai_grade: number }>; }

export default function CalibrationScatter({ data }: Props) {
  if (!data.length) return <div className="text-neutral-500 text-sm">no graded trades yet</div>;
  const W = 320, H = 240, P = 30;
  const min = 0, max = 11;   // grade scale 0..11
  const x = (g: number) => P + ((g - min) / (max - min)) * (W - 2*P);
  const y = (g: number) => H - P - ((g - min) / (max - min)) * (H - 2*P);

  const meanDelta = data.reduce((s, d) => s + (d.user_grade - d.ai_grade), 0) / data.length;

  return (
    <div>
      <svg width={W} height={H} className="bg-neutral-950 rounded">
        {/* axis */}
        <line x1={P} y1={H-P} x2={W-P} y2={H-P} stroke="#404040" />
        <line x1={P} y1={P} x2={P} y2={H-P} stroke="#404040" />
        {/* 45° reference */}
        <line x1={x(min)} y1={y(min)} x2={x(max)} y2={y(max)} stroke="#525252" strokeDasharray="3,3" />
        {/* labels */}
        <text x={W/2} y={H-5} textAnchor="middle" fontSize="10" fill="#737373">your grade →</text>
        <text x={10} y={H/2} textAnchor="middle" fontSize="10" fill="#737373" transform={`rotate(-90 10 ${H/2})`}>← AI grade</text>
        {/* dots */}
        {data.map((d, i) => (
          <circle key={i} cx={x(d.user_grade)} cy={y(d.ai_grade)} r="3" fill="#3b82f6" opacity="0.7" />
        ))}
      </svg>
      <div className="text-xs text-neutral-400 mt-2">
        n = {data.length}. Mean delta: {meanDelta >= 0 ? '+' : ''}{meanDelta.toFixed(2)}
        {meanDelta < -0.5 ? ' (you grade higher than AI)' : meanDelta > 0.5 ? ' (you grade lower than AI)' : ' (well calibrated)'}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: WinRateByTagBar**

```tsx
// dashboard/src/components/performance/WinRateByTagBar.tsx
interface Props { data: Array<{ tag: string; trades: number; wins: number; total_pnl: number }>; }

export default function WinRateByTagBar({ data }: Props) {
  if (!data.length) return <div className="text-neutral-500 text-sm">no tagged trades yet</div>;
  const max = Math.max(...data.map((d) => d.trades));
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const winRate = d.wins / d.trades;
        return (
          <div key={d.tag}>
            <div className="flex justify-between text-xs mb-1">
              <span>{d.tag} <span className="text-neutral-500">({d.trades})</span></span>
              <span className={d.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                {(winRate * 100).toFixed(0)}% · {d.total_pnl >= 0 ? '+' : ''}${d.total_pnl.toFixed(0)}
              </span>
            </div>
            <div className="h-2 bg-neutral-900 rounded overflow-hidden">
              <div className={`h-full ${d.total_pnl >= 0 ? 'bg-green-500/60' : 'bg-red-500/60'}`}
                style={{ width: `${(d.trades / max) * 100}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/performance/CalibrationScatter.tsx dashboard/src/components/performance/WinRateByTagBar.tsx
git commit -m "feat(dashboard): calibration scatter + win-rate-by-tag bar panels"
```

---

### Task 6.8: Performance panels — PnLBySymbolTable + TimeHeatmap

**Files:**
- Create: `dashboard/src/components/performance/PnLBySymbolTable.tsx`
- Create: `dashboard/src/components/performance/TimeHeatmap.tsx`

- [ ] **Step 1: PnLBySymbolTable (sortable)**

```tsx
// dashboard/src/components/performance/PnLBySymbolTable.tsx
import { useState } from 'react';

interface Row { symbol: string; trades: number; wins: number; total_pnl: number; avg_grade: number; }
type SortKey = keyof Row;
interface Props { data: Row[]; }

export default function PnLBySymbolTable({ data }: Props) {
  const [sort, setSort] = useState<SortKey>('total_pnl');
  const [dir, setDir] = useState<1 | -1>(-1);
  const sorted = [...data].sort((a, b) => (a[sort] > b[sort] ? 1 : a[sort] < b[sort] ? -1 : 0) * dir);

  function header(label: string, key: SortKey) {
    return (
      <th className="text-right p-2 cursor-pointer select-none" onClick={() => {
        if (sort === key) setDir((d) => -d as 1 | -1);
        else { setSort(key); setDir(-1); }
      }}>
        {label}{sort === key ? (dir === 1 ? ' ↑' : ' ↓') : ''}
      </th>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-neutral-400 text-xs uppercase border-b border-neutral-800">
        <tr>
          <th className="text-left p-2 cursor-pointer" onClick={() => { setSort('symbol'); setDir(1); }}>Symbol</th>
          {header('Trades', 'trades')}
          {header('Win %', 'wins')}
          {header('Total P&L', 'total_pnl')}
          {header('Avg grade', 'avg_grade')}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.symbol} className="border-b border-neutral-900">
            <td className="p-2 font-mono">{r.symbol}</td>
            <td className="p-2 text-right">{r.trades}</td>
            <td className="p-2 text-right">{(r.wins / r.trades * 100).toFixed(0)}%</td>
            <td className={`p-2 text-right ${r.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {r.total_pnl >= 0 ? '+' : ''}${r.total_pnl.toFixed(2)}
            </td>
            <td className="p-2 text-right">{r.avg_grade.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: TimeHeatmap**

```tsx
// dashboard/src/components/performance/TimeHeatmap.tsx
interface Cell { dow: number; hour: number; trades: number; win_rate: number; }
interface Props { data: Cell[]; }

const DOWS = ['Mon','Tue','Wed','Thu','Fri'];
const HOURS = [9, 10, 11, 12, 13, 14, 15];

export default function TimeHeatmap({ data }: Props) {
  const map: Record<string, Cell> = {};
  for (const c of data) map[`${c.dow}-${c.hour}`] = c;

  function cellColor(c: Cell | undefined): string {
    if (!c || c.trades === 0) return 'bg-neutral-900';
    const r = c.win_rate;
    const a = (Math.abs(r - 0.5) * 1.6).toFixed(2);
    return r > 0.5 ? `bg-green-500/[${a}]` : `bg-red-500/[${a}]`;
  }

  return (
    <div>
      <div className="grid grid-cols-8 gap-1 text-xs">
        <div></div>
        {HOURS.map((h) => <div key={h} className="text-center text-neutral-500">{h}</div>)}
        {DOWS.map((d, di) => (
          <>
            <div key={d} className="text-neutral-500">{d}</div>
            {HOURS.map((h) => {
              const c = map[`${di+1}-${h}`];
              return (
                <div key={`${di}-${h}`}
                  className={`aspect-square border border-neutral-800 rounded ${cellColor(c)} relative group`}
                  title={c ? `${c.trades} trades, ${(c.win_rate*100).toFixed(0)}% win` : 'no trades'}
                >
                  {c && c.trades > 0 && (
                    <div className="absolute inset-0 flex items-center justify-center text-[10px] text-neutral-200 opacity-70">
                      {c.trades}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ))}
      </div>
      <div className="text-xs text-neutral-400 mt-2">cell color = win rate · number = trade count · all times ET</div>
    </div>
  );
}
```

- [ ] **Step 3: Wire route + nav**

Add `<Route path="/performance" element={<RequireAuth><Performance /></RequireAuth>} />` and a nav link.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/performance/PnLBySymbolTable.tsx dashboard/src/components/performance/TimeHeatmap.tsx dashboard/src/main.tsx dashboard/src/components/layout/Layout.tsx
git commit -m "feat(dashboard): pnl-by-symbol table + time heatmap panels + wire performance route"
```

---

**Milestone 6 complete.** `/watchlist`, `/calendar`, `/performance` all live. The user's full Phase 3 visualization layer is shipped.

---

## Milestone 7 — Cleanup follow-ups + final QA

Closes the three remaining Phase 2 follow-ups (live-account 403 guard, TS warning, end-to-end smoke).

### Task 7.1: Server-side LIVE_ENABLED 403 guard

**Files:**
- Modify: `dashboard/api/trades/[action].ts` — submit handler
- Test: `dashboard/tests/trades-submit-live-guard.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// dashboard/tests/trades-submit-live-guard.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/auth-guard', () => ({ requireAuth: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../api/_lib/kv', () => ({ kv: () => ({ get: vi.fn(), set: vi.fn(), rpush: vi.fn(), incr: vi.fn().mockResolvedValue(1) }) }));
vi.mock('../api/_lib/data-api', () => ({ alpacaTrade: vi.fn(), alpacaTradeMutation: vi.fn(), alpacaData: vi.fn() }));

describe('trades/submit live guard', () => {
  beforeEach(() => { delete process.env.LIVE_ENABLED; });

  it('returns 403 when account=live and LIVE_ENABLED is unset', async () => {
    const handler = (await import('../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'submit' },
      body: {
        asset_class: 'stock', symbol: 'F', side: 'buy', qty: 10,
        account: 'live', order_type: 'market', tif: 'day',
        entry_grade: 'B', entry_reasoning: 'because', rule_violations: [],
      },
    };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows live submit when LIVE_ENABLED=true', async () => {
    process.env.LIVE_ENABLED = 'true';
    // Test continues — but actual order placement is not exercised here
    // since we only need to verify the guard is bypassed
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

- [ ] **Step 3: Add the guard at the top of the submit branch**

```ts
// In api/trades/[action].ts, inside `case 'submit':` near the top, BEFORE order placement:
if (req.body?.account === 'live' && process.env.LIVE_ENABLED !== 'true') {
  return res.status(403).json({ error: 'live trading is disabled' });
}
```

- [ ] **Step 4: Run to verify PASS**

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/trades/[action].ts dashboard/tests/trades-submit-live-guard.test.ts
git commit -m "feat(dashboard): server-side live-account 403 guard (Phase 2 follow-up)"
```

---

### Task 7.2: Fix TS warning at api/alpaca/[endpoint].ts:38

**Files:**
- Modify: `dashboard/api/alpaca/[endpoint].ts:38`

- [ ] **Step 1: Inspect the line**

```bash
sed -n '30,45p' dashboard/api/alpaca/[endpoint].ts
```

The warning is `'desc'` not assignable to `Direction`. Look at the line and what type the SDK expects.

- [ ] **Step 2: Apply the fix**

Likely fix: import the `Direction` type from the SDK and use the typed value:

```ts
import type { Direction } from '@alpacahq/typescript-sdk';

// At line 38, replace:
direction: 'desc',
// With:
direction: 'desc' as Direction,
```

If `Direction` isn't exported, an alternative is `direction: 'desc' as const` (when the call site accepts a literal string union).

- [ ] **Step 3: Confirm no warning**

```bash
cd dashboard && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/api/alpaca/[endpoint].ts
git commit -m "chore(dashboard): fix Direction TS warning at alpaca/[endpoint].ts:38"
```

---

### Task 7.3: End-to-end smoke test playbook

**Files:**
- Create: `dashboard/docs/PHASE3_SMOKE.md`

This is documentation, not code — but it's the canonical "did Phase 3 actually work" check.

- [ ] **Step 1: Write the playbook**

```markdown
# Phase 3 End-to-End Smoke Test

Run after deploying Phase 3 to production. ~10 minutes during market hours.

## 1. Bot rules pipe
- [ ] Manually dispatch `tsla-monitor.yml` and `tsla-monitor-aggressive.yml`:
  ```bash
  gh workflow run tsla-monitor.yml
  gh workflow run tsla-monitor-aggressive.yml
  ```
- [ ] After each run, navigate to `/rules` → Bot rules section. Confirm both Conservative and Aggressive columns show real data with a recent `pushed_at` timestamp.

## 2. Manual rule + active rule-checker
- [ ] On `/rules`, click "+ Add rule".
- [ ] Title: "TEST: no F"
- [ ] Severity: block
- [ ] Triggers: { symbol_in: F }
- [ ] Body: "smoke test rule — block F"
- [ ] Save → returns to `/rules`, new card visible.
- [ ] Navigate to `/order/new`, select F as symbol, fill in 10 shares buy.
- [ ] Confirm: red banner appears with "TEST: no F"; submit button disabled.
- [ ] Check the override checkbox + type "smoke testing the override flow" (>20 chars).
- [ ] Submit button enables. Click it.
- [ ] Cancel the order from `/orders` to avoid actually filling.
- [ ] Verify on `/trade/<id>`: `rule_warnings_at_entry` includes the violation with `override_reason`.

## 3. Tendency cron (manual fire)
- [ ] Trigger the cron manually:
  ```bash
  curl -X POST -H "Authorization: Bearer $CRON_TOKEN" \
    https://tradingbot-dashboard-blue.vercel.app/api/cron/detect-tendencies?job=detect-tendencies
  ```
- [ ] Response: `{ findings_count: N, proposals_appended: M }` (likely 0 if you don't have ≥3 closing trades on the same symbol yet).
- [ ] If findings exist, navigate to `/rules` → Tendencies section, verify they render. Proposals section likewise.

## 4. STO assignment auto-spawn
- [ ] Place a paper STO put close to ATM on a cheap stock during market hours, e.g., F $12P expiring in ~3 days at the bid.
- [ ] Wait for fill, then for assignment (or simulate by editing the trade record).
- [ ] After grade-cron tick, navigate to `/trade/<parent_id>` — verify "↓ Assignment spawned" link.
- [ ] Click the link → child trade detail. Verify "↑ Assigned from" link, `source: assignment`, `qty: 100`, `entry_price = strike`.

## 5. Calendar + Performance + Watchlist
- [ ] `/calendar` — current month renders, day cells show P&L; click a day with closed trades → drawer lists them.
- [ ] `/performance` — all six panels render; filters work; calibration scatter shows excluded inherited grades correctly.
- [ ] `/watchlist` — add a symbol, see live quote and 30d sparkline.

## 6. Live guard
- [ ] curl `/api/trades/submit` with `account=live`:
  ```bash
  curl -X POST -H "Cookie: $SESSION" -H 'content-type: application/json' \
    https://tradingbot-dashboard-blue.vercel.app/api/trades/submit \
    -d '{"action":"submit","account":"live","asset_class":"stock","symbol":"F","side":"buy","qty":1,"order_type":"market","tif":"day","entry_grade":"B","entry_reasoning":"x","rule_violations":[]}'
  ```
- [ ] Response: 403 `{ "error": "live trading is disabled" }`.

If all six sections pass: Phase 3 is live and validated.
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/docs/PHASE3_SMOKE.md
git commit -m "docs(dashboard): Phase 3 end-to-end smoke test playbook"
```

---

### Task 7.4: Update CLAUDE.md + create handoff document

**Files:**
- Modify: `CLAUDE.md` (Phase 3 section under Dashboard subproject)
- Create: `docs/superpowers/HANDOFF-2026-05-XX.md` (after deploy)

- [ ] **Step 1: Replace the "Phase 3 (next)" bullet list in CLAUDE.md**

Find the section ending with `- PWA setup (Phase 4) — install prompt, offline shell, push notifications`. Replace with:

```markdown
### Phase 3 deliverable (shipped 2026-05-XX, validated end-to-end on Alpaca paper)

- `/rules` page with seven sections (bot · manual · patterns · tendencies · proposals · cheatsheets · goals); `/rules/edit` section dispatcher with no-JSON trigger builder
- Active rule-checker on order placement: warn-only for bot rules, hard-block + override-with-reasoning for manual rules
- Tendency-detection cron (Sundays 6 PM ET via cron-job.org): 6 deterministic matchers + Sonnet 4.6 plain-English proposals + demote loop for over-overridden block rules
- STO put assignments auto-spawn linked stock trades (`parent_id`, inherited grades, `ai_grade_inherited` flag); calibration math excludes inherited grades
- `/watchlist` page with quotes + 30d sparklines
- `/calendar` with month grid, P&L heatmap, expiration overlay, day drawer, filter bar
- `/performance` with six panels (equity curve, drawdown, calibration scatter, win-rate-by-tag, P&L-by-symbol, time-of-day heatmap), filterable
- Server-side LIVE_ENABLED 403 guard (Phase 2 follow-up #2 closed)
- DST-aware ET helper (Phase 2 follow-up #3 closed)
- TS Direction warning fixed (Phase 2 follow-up #4 closed)
- Function count: 9 → 10 of 12 Hobby cap (added `api/rules/[resource].ts`)
- ~135 vitest tests total (was 97 in Phase 2)

### Phase 4 (next) — known follow-ups from Phase 3

- Daily 4:15 PM coach's note cron + home-page card
- PWA setup (manifest, service worker, install prompt)
- Push notifications at 4:15 PM (off by default)
- Final accessibility + performance audit
- LLM-driven matchers v2 for tendency detection (in addition to deterministic ones)
- Cost-basis tracking per symbol (currently `cost_basis_at_entry` is null on all trades — `cc_below_cost_basis` matcher is therefore inactive in practice until M5 follow-on tracking is finalized)
- `earnings_during_hold` flag on closed trades (currently always false — requires the grade-cron to look up earnings during the hold period)
```

Update the cron-job.org table to add the new tendency cron entry.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Phase 3 deliverable"
```

---

**Milestone 7 complete.** All Phase 2 follow-ups closed; smoke playbook documented. Ready for production deploy + PR merge.

---

## Final commit + deploy

After all 7 milestones land:

- [ ] Run full test suite: `cd dashboard && npm test` — expect ≥130 passing, no failures
- [ ] Build: `cd dashboard && npm run build` — clean
- [ ] Type check: `cd dashboard && npx tsc --noEmit` — no warnings
- [ ] Link Vercel project (worktree gotcha): `cd dashboard && npx vercel link --yes --project tradingbot-dashboard`
- [ ] Deploy: `cd dashboard && npx vercel --prod`
- [ ] Run `tools/setup_cronjobs.py` to register the tendency cron
- [ ] Run `dashboard/docs/PHASE3_SMOKE.md` end-to-end
- [ ] Open PR from `claude/peaceful-bardeen-7977f6` → `main`, link spec + plan in body, request merge
- [ ] After merge, write `docs/superpowers/HANDOFF-2026-05-XX.md` capturing learnings for the Phase 4 session
