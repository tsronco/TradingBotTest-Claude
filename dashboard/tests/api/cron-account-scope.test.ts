// dashboard/tests/api/cron-account-scope.test.ts
//
// Tests that runGradeOpenTrades can be scoped to a single account:
//   1. Scoped run counts only the selected account's open trades.
//   2. Scoped run never touches the global rotating cursor.
//   3. Regression: an unscoped run still counts all accounts AND uses the cursor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KV_KEYS, tradeKey } from '../../api/_lib/kv-keys';

// ── KV mock ──────────────────────────────────────────────────────────────────
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

vi.mock('../../api/_lib/grading', () => ({
  gradeTrade: vi.fn().mockResolvedValue({
    letter: 'C',
    review: 'r',
    calibration: 'matched',
    tendencies_hit: [],
    model: 'm',
    usage: {},
    ts: '...',
  }),
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
// Two manual_paper trades and one conservative_paper trade.
// All three are filled options whose position is still present on Alpaca so
// detectClose returns null and nothing closes during this test.
function makeTrade(id: string, account: string): any {
  return {
    id,
    account,
    asset_class: 'option',
    symbol: 'AAPL',
    contract_symbol: `AAPL260101P00100000_${id}`,
    contract_type: 'put',
    side: 'STO',
    strike: 100,
    expiration: '2027-01-01', // far-future expiry → no path-2 close
    qty: 1,
    filled_avg_price: 2.0,
    filled_at: '2026-06-01T18:00:00Z',
    submitted_at: '2026-06-01T17:00:00Z',
    alpaca_order_id: `order-${id}`,
    alpaca_close_order_id: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    // Non-empty modify_history → syncFillData short-circuits (no Alpaca order fetch),
    // leaving the trade unchanged with its already-set filled_at.
    fill_confirmed: true,
    modify_history: [{ ts: '2026-06-01T18:00:00Z', prev_order_id: `prev-${id}`, new_order_id: `order-${id}`, source: 'backfill' }],
    tags: [],
    entry_grade: 'B',
    entry_reasoning: 'test',
    greeks_at_entry: null,
    rule_warnings_at_entry: [],
    exposure_at_submit: 1000,
    schema: 1,
  };
}

const tradeM1 = makeTrade('m1', 'manual_paper');
const tradeM2 = makeTrade('m2', 'manual_paper');
const tradeC1 = makeTrade('c1', 'conservative_paper');

// ── KV setup helper ───────────────────────────────────────────────────────────
// Sets up: open index = ['m1','m2','c1'], sweep cursor = 0,
// plus all three trade records. alpacaTrade returns a live position so
// detectExternalOptionClose (path 3) sees the position still present and
// returns null → detectClose returns null for every trade.
function setupKv() {
  kvLrange.mockImplementation(async (k: string) => {
    if (k === KV_KEYS.tradesIndexOpen) return ['m1', 'm2', 'c1'];
    if (k === 'trades:index:assignments-pending') return [];
    if (k === KV_KEYS.tradesIndexNeedsGrade) return [];
    return [];
  });
  kvGet.mockImplementation(async (k: string) => {
    if (k === tradeKey('m1')) return { ...tradeM1 };
    if (k === tradeKey('m2')) return { ...tradeM2 };
    if (k === tradeKey('c1')) return { ...tradeC1 };
    if (k === KV_KEYS.tradesSweepCursor) return 0;
    return null;
  });
  // alpacaTrade: for detectExternalOptionClose (path 3 in detectClose),
  // position check returns a live position → position IS present → returns null
  // (no close detected). This ensures all three trades stay open.
  alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
    // Path 3 calls /v2/positions/<occ_symbol> to check if option is gone
    if (path.includes('/v2/positions/')) {
      // Return a position object → positionExists returns true → no close
      return { symbol: 'AAPL', qty: '1', side: 'short' };
    }
    // Path 3 also checks /v2/account/activities for closing fills
    if (path.includes('/v2/account/activities')) {
      return [];
    }
    // Default: no match → no close
    return null;
  });
}

describe('runGradeOpenTrades account scoping', () => {
  beforeEach(() => {
    kvGet.mockReset();
    kvSet.mockClear();
    kvLrange.mockReset();
    kvLrem.mockClear();
    kvRpush.mockClear();
    kvIncr.mockReset();
    kvIncr.mockResolvedValue(1);
    alpacaTrade.mockReset();
    setupKv();
  });

  it('scopes remaining_open to the selected account, skips cursor, and regression: global sees all 3 + writes cursor', async () => {
    const { runGradeOpenTrades } = await import('../../api/cron/[job]');

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
  });
});
