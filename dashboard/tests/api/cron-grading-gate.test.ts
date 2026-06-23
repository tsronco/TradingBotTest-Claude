// dashboard/tests/api/cron-grading-gate.test.ts
//
// Tests that AI grading is gated to gradeable accounts (manual + live) and
// that drainNeedsGrade correctly:
//   1. Drops non-gradeable (conservative) trades from the queue
//   2. Scopes the drain to the requested account when account= is set
//   3. Keeps other gradeable accounts' queued trades for their own run
//
// Setup: EMPTY open index (nothing to close-detect), pre-seeded needs-grade queue
// with m1 (manual_paper), l1 (live), c1 (conservative_paper).
// runGradeOpenTrades({ account: 'manual_paper', gradeBudget: MAX_SAFE_INTEGER })
//   should: grade only m1, keep l1 queued (other gradeable acct), drop c1.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KV_KEYS, tradeKey, gradeKey } from '../../api/_lib/kv-keys';

// ── KV mock ───────────────────────────────────────────────────────────────────
const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
const kvLrange = vi.fn();
const kvLrem = vi.fn().mockResolvedValue(1);
const kvRpush = vi.fn().mockResolvedValue(1);
const kvIncr = vi.fn().mockResolvedValue(1);
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({
    get: kvGet,
    set: kvSet,
    lrange: kvLrange,
    lrem: kvLrem,
    rpush: kvRpush,
    incr: kvIncr,
    del: vi.fn().mockResolvedValue(1),
  }),
}));

// ── Alpaca data/trade mocks ───────────────────────────────────────────────────
const alpacaTrade = vi.fn();
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade,
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn().mockResolvedValue({ bars: {} }),
}));

vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ orders: { get: vi.fn() } }),
}));

const gradeTrade = vi.fn();
vi.mock('../../api/_lib/grading', () => ({
  gradeTrade,
}));

vi.mock('../../api/_lib/proposal-prompts', () => ({
  proposeNewRule: vi.fn(),
  proposeDemote: vi.fn(),
}));

// Stub auto-import so it never fires alpacaTrade calls from runAutoImport
vi.mock('../../api/trades/[action]', () => ({
  runImport: vi.fn().mockResolvedValue({
    imported: 0,
    skipped_existing: 0,
    spread_pairs_found: 0,
    errors: [],
    created_trade_ids: [],
  }),
}));

// ── Fixture trades ────────────────────────────────────────────────────────────
function makeTrade(id: string, account: string): any {
  return {
    id,
    account,
    asset_class: 'stock',
    symbol: 'F',
    side: 'buy',
    qty: 1,
    filled_avg_price: 12.0,
    filled_at: '2026-06-20T18:00:00Z',
    submitted_at: '2026-06-20T17:00:00Z',
    alpaca_order_id: `order-${id}`,
    alpaca_close_order_id: null,
    closed_at: '2026-06-21T18:00:00Z',  // already closed
    closed_avg_price: 13.0,
    realized_pnl: 1.0,
    closed_by: 'manual',
    fill_confirmed: true,
    tags: [],
    entry_grade: 'B',
    entry_reasoning: 'test',
    greeks_at_entry: null,
    rule_warnings_at_entry: [],
    exposure_at_submit: 12,
    schema: 1,
  };
}

const tradeM1 = makeTrade('m1', 'manual_paper');
const tradeL1 = makeTrade('l1', 'live');
const tradeC1 = makeTrade('c1', 'conservative_paper');

function makeGrade(id: string): any {
  return { trade_id: id, entry: { letter: 'B', reasoning: 'r', ts: '' }, hindsight: null, history: [] };
}

describe('cron grading gate', () => {
  beforeEach(() => {
    kvGet.mockReset();
    kvSet.mockClear();
    kvLrange.mockReset();
    kvLrem.mockClear();
    kvRpush.mockClear();
    kvIncr.mockReset();
    kvIncr.mockResolvedValue(1);
    alpacaTrade.mockReset();
    gradeTrade.mockReset();

    // gradeTrade resolves a grade object
    gradeTrade.mockResolvedValue({
      letter: 'C',
      review: 'average',
      calibration: 'matched',
      tendencies_hit: [],
      model: 'm',
      usage: { input_tokens: 100, output_tokens: 50, cached_tokens: 0 },
      ts: '2026-06-21T18:00:00Z',
    });

    // Open index is EMPTY — no close detection needed
    kvLrange.mockImplementation(async (k: string) => {
      if (k === KV_KEYS.tradesIndexOpen) return [];
      if (k === 'trades:index:assignments-pending') return [];
      return [];
    });

    // Track the needs-grade queue so reads after a set() see the updated value.
    let needsGradeQueue: string[] = ['m1', 'l1', 'c1'];

    // kvSet: intercept writes to the needs-grade key to track current state
    kvSet.mockImplementation(async (k: string, v: unknown) => {
      if (k === KV_KEYS.tradesIndexNeedsGrade) {
        needsGradeQueue = v as string[];
      }
      return 'OK';
    });

    // kvGet: return per-key values, reflecting any kvSet writes to needs-grade
    kvGet.mockImplementation(async (k: string) => {
      // needs-grade queue — reflects latest kvSet write
      if (k === KV_KEYS.tradesIndexNeedsGrade) return [...needsGradeQueue];
      // Trade records
      if (k === tradeKey('m1')) return { ...tradeM1 };
      if (k === tradeKey('l1')) return { ...tradeL1 };
      if (k === tradeKey('c1')) return { ...tradeC1 };
      // Grade records (all ungraded)
      if (k === gradeKey('m1')) return makeGrade('m1');
      if (k === gradeKey('l1')) return makeGrade('l1');
      if (k === gradeKey('c1')) return makeGrade('c1');
      // Sweep cursor not needed (open index empty) but return 0 for safety
      if (k === KV_KEYS.tradesSweepCursor) return 0;
      return null;
    });
  });

  it('scoped grade drain: grades only the requested account, keeps other gradeable queued, drops non-gradeable', async () => {
    const { runGradeOpenTrades } = await import('../../api/cron/[job]');

    const r = await runGradeOpenTrades({ account: 'manual_paper', gradeBudget: Number.MAX_SAFE_INTEGER });

    // Only m1 should have been graded (manual_paper = gradeable, matches account filter)
    expect(gradeTrade).toHaveBeenCalledTimes(1);
    expect(r.ai_graded).toBe(1);

    // Queue after: l1 kept (live = gradeable, different account), c1 dropped (conservative = not gradeable)
    const finalQueue = kvSet.mock.calls
      .filter(([k]) => k === KV_KEYS.tradesIndexNeedsGrade)
      .at(-1)?.[1];
    expect(finalQueue).toEqual(['l1']);
    expect(r.grade_queue_remaining).toBe(1);
  });
});
