// dashboard/tests/api/cron-d11-settlement-backstop.test.ts
//
// D11 — Past-expiry STO mis-booking: assigned shares invisible / null-fill P&L=0
//
// Tests for the conservative backstop behaviour:
//
//   (1) past-backstop STO, settlement unconfirmed, underlying stock position
//       present in Alpaca with qty >= 100×contracts → booked 'assigned', spawn
//       enqueued. (Assignment-detected-via-positions path.)
//
//   (2) past-backstop STO, settlement unconfirmed, NO stock position present
//       → trade stays OPEN (detectClose returns null), warning logged.
//
//   (3) past-backstop STO, filled_avg_price null → trade stays OPEN (not
//       booked with P&L=0), warning logged.
//
//   (4) positively-confirmed expiry (resolveOptionSettlement returns 'expired')
//       → still books 'expired' correctly. (Regression guard — confirmed
//       expiry path must be untouched by D11 changes.)
//
// The heuristic for (1): when settlement is unconfirmed past the backstop,
// call /v2/positions/{underlying}. If a stock position with qty >= 100 * trade.qty
// is present, treat it as assignment evidence. Otherwise, leave the trade open
// and log a warning rather than fabricating an expired-worthless win.
//
// Important limitation documented at fix-time: the position check cannot
// distinguish a freshly-assigned position from a pre-existing one. If the user
// already holds ≥ 100×qty shares of the underlying before assignment, the check
// may produce a false-positive 'assigned' booking. This is accepted over the
// alternative (silently fabricating an expired-worthless win for a truly-assigned
// position) because the false-positive creates a visible spawn the user can
// delete, whereas the false-negative creates invisible real equity with a wrong
// P&L entry. The null-fill-price guard (D11b) is unambiguous and safe.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const alpacaTrade = vi.fn();
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade,
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn().mockResolvedValue({ bars: {} }),
}));

vi.mock('../../api/_lib/alpaca', () => ({}));

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

// Stub auto-import so it never fires alpacaTrade calls from runAutoImport,
// which would interfere with our assertions about which paths were taken.
vi.mock('../../api/trades/[action]', () => ({
  runImport: vi.fn().mockResolvedValue({
    imported: 0,
    skipped_existing: 0,
    spread_pairs_found: 0,
    errors: [],
    created_trade_ids: [],
  }),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

// STO put: filled at $1.80 (filled_avg_price=1.80), expiry 2026-05-15.
// Time is set to 2026-05-19T14:00Z (~3.75 days past expiry) so we are past
// the 3-day SETTLEMENT_BACKSTOP_MS.
// modify_history non-empty → syncFillData short-circuits (no Alpaca order fetch).
function makeStoTrade(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: 'T-D11-001',
    account: 'manual_paper',
    asset_class: 'option',
    symbol: 'SNAP',
    contract_symbol: 'SNAP260515P00007500',
    contract_type: 'put',
    side: 'STO',
    strike: 7.5,
    expiration: '2026-05-15',
    qty: 1,
    filled_avg_price: 1.80,
    filled_at: '2026-05-12T19:13:00Z',
    submitted_at: '2026-05-12T17:51:00Z',
    alpaca_order_id: 'order-d11',
    alpaca_close_order_id: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    modify_history: [{
      ts: '2026-05-12T19:13:00Z',
      prev_order_id: 'order-d11-prev',
      new_order_id: 'order-d11',
      source: 'backfill',
    }],
    tags: [],
    entry_grade: 'B',
    entry_reasoning: 'test',
    greeks_at_entry: null,
    rule_warnings_at_entry: [],
    exposure_at_submit: 750,
    schema: 1,
    ...overrides,
  };
}

const handlerReq = {
  method: 'POST',
  query: { job: 'grade-open-trades' },
  headers: { authorization: 'Bearer tok' },
} as any;

async function runHandler(trade: any) {
  const handler = (await import('../../api/cron/[job]')).default;
  const res = mkRes();
  await handler(handlerReq, res);
  return res;
}

function closedTradeWrite(tradeId: string) {
  // Find the write that carries closed_by (the actual close, not the
  // fill_confirmed:true convergence write from the legacy syncFillData guard).
  return kvSet.mock.calls.find(
    (c: any) => c[0] === `trade:${tradeId}` && c[1]?.closed_by != null,
  )?.[1] ?? null;
}

function spawnedStockWrite(parentTradeId: string) {
  return kvSet.mock.calls.find(
    (c: any) =>
      typeof c[0] === 'string' &&
      c[0].startsWith('trade:T-') &&
      c[0] !== `trade:${parentTradeId}`,
  )?.[1];
}

function setupKv(trade: any) {
  kvLrange.mockImplementation(async (k: string) => {
    if (k === 'trades:index:open') return [trade.id];
    if (k === 'trades:index:assignments-pending') {
      // Drain any enqueued assignments from kvRpush
      return kvRpush.mock.calls
        .filter((c: any) => c[0] === 'trades:index:assignments-pending')
        .map((c: any) => c[1]);
    }
    return [];
  });
  kvGet.mockImplementation(async (k: string) => {
    if (k === `trade:${trade.id}`) return { ...trade };
    if (k === `grade:${trade.id}`) {
      return { trade_id: trade.id, entry: { letter: 'B' }, hindsight: null };
    }
    return null;
  });
}

describe('D11 — past-backstop STO settlement: conservative posture', () => {
  beforeEach(() => {
    kvGet.mockReset();
    kvSet.mockClear();
    kvLrange.mockReset();
    kvLrem.mockClear();
    kvRpush.mockClear();
    kvIncr.mockReset();
    kvIncr.mockResolvedValue(1);
    alpacaTrade.mockReset();
    process.env.CRON_TOKEN = 'tok';
    vi.useFakeTimers();
    // 2026-05-19T14:00Z = ~3.75 days past 2026-05-15T20:00Z expiry → past 3-day backstop
    vi.setSystemTime(new Date('2026-05-19T14:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── D11a: unconfirmed past-backstop WITH assignment evidence (position exists) ──

  it('D11a: past-backstop, settlement unconfirmed, underlying position present with sufficient qty → booked "assigned" and spawn enqueued', async () => {
    // OPEXP/OPASN activity returns empty (unconfirmed settlement), BUT
    // the underlying SNAP stock position is present with 100 shares (= 100 × 1 contract)
    // → evidence of assignment → should book 'assigned' and enqueue the spawn.
    const trade = makeStoTrade();
    setupKv(trade);

    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        // No settlement activity posted yet
        return [];
      }
      if (path.includes('/v2/positions/SNAP')) {
        // Stock position present: 100 shares at $7.50 (assignment cost basis)
        return { symbol: 'SNAP', qty: '100', avg_entry_price: '7.50' };
      }
      return null;
    });

    await runHandler(trade);

    const closed = closedTradeWrite(trade.id);
    expect(closed).toBeDefined();
    expect(closed.closed_by).toBe('assigned');
    // Option leg P&L: premium kept = 1.80 * 100 * 1 = 180
    expect(closed.realized_pnl).toBeCloseTo(180, 2);
    expect(closed.closed_avg_price).toBe(0);

    // Spawn should be enqueued (assignment-spawn path fires on closed_by='assigned')
    const spawned = spawnedStockWrite(trade.id);
    expect(spawned).toBeDefined();
    expect(spawned.asset_class).toBe('stock');
    expect(spawned.symbol).toBe('SNAP');
    expect(spawned.qty).toBe(100); // 1 contract × 100
    expect(spawned.parent_id).toBe(trade.id);
  });

  // ─── D11b: unconfirmed past-backstop, NO assignment evidence (no position) ──

  it('D11b: past-backstop, settlement unconfirmed, no underlying position → trade stays OPEN, warning logged', async () => {
    // OPEXP/OPASN activity empty AND no stock position → can't confirm expiry or
    // assignment → must NOT book as expired (conservative: leave open + warn).
    const trade = makeStoTrade();
    setupKv(trade);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        return [];
      }
      if (path.includes('/v2/positions/SNAP')) {
        // Position does not exist (404)
        throw new Error('alpaca trade 404 on /v2/positions/SNAP: position not found');
      }
      return null;
    });

    await runHandler(trade);

    // Trade must NOT be closed — detectClose should return null
    const closed = closedTradeWrite(trade.id);
    expect(closed?.closed_by ?? null).toBeNull();
    expect(kvLrem).not.toHaveBeenCalledWith('trades:index:open', 0, trade.id);

    // No spawn
    const spawned = spawnedStockWrite(trade.id);
    expect(spawned).toBeUndefined();

    // A warning/log must have been emitted (visible in Vercel logs)
    const allLogs = [
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].filter((a) => typeof a === 'string');
    const warningFired = allLogs.some(
      (s) =>
        s.includes('settlement unconfirmed') ||
        s.includes('unconfirmed') ||
        s.includes('D11') ||
        s.includes('backstop'),
    );
    expect(warningFired).toBe(true);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── D11c: null filled_avg_price → must NOT book P&L=0 ─────────────────────

  it('D11c: null filled_avg_price at backstop → trade stays OPEN (not booked as P&L=0)', async () => {
    // If filled_avg_price is null when we would book the expiry, we must NOT
    // silently write realized_pnl=0 (which looks like a clean breakeven).
    // Prefer leaving the trade open / flagging it.
    const trade = makeStoTrade({ filled_avg_price: null, filled_at: '2026-05-12T19:13:00Z' });
    setupKv(trade);

    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        // No settlement activity — triggers the backstop path
        return [];
      }
      if (path.includes('/v2/positions/SNAP')) {
        // No stock position either
        throw new Error('alpaca trade 404 on /v2/positions/SNAP: position not found');
      }
      return null;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runHandler(trade);

    // Trade must NOT be closed with P&L=0
    const closed = closedTradeWrite(trade.id);
    expect(closed?.closed_by ?? null).toBeNull();
    expect(kvLrem).not.toHaveBeenCalledWith('trades:index:open', 0, trade.id);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── D11d: confirmed expiry still books correctly (regression guard) ─────────

  it('D11d: positively-confirmed OPEXP activity → still books "expired" correctly (no regression)', async () => {
    // When resolveOptionSettlement returns 'expired' (OPEXP activity found),
    // the existing confirmed-expiry path must be completely untouched.
    const trade = makeStoTrade();
    setupKv(trade);

    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        return [{
          id: 'act-opexp',
          activity_type: 'OPEXP',
          symbol: 'SNAP260515P00007500',
          qty: '1',
          date: '2026-05-15',
        }];
      }
      return null;
    });

    await runHandler(trade);

    const closed = closedTradeWrite(trade.id);
    expect(closed).toBeDefined();
    expect(closed.closed_by).toBe('expired');
    // Premium kept = 1.80 * 100 * 1 = 180
    expect(closed.realized_pnl).toBeCloseTo(180, 2);
    expect(closed.closed_avg_price).toBe(0);

    // No spawn (expired, not assigned)
    expect(spawnedStockWrite(trade.id)).toBeUndefined();
  });
});
