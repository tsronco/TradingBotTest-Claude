import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
const kvLrange = vi.fn();
const kvLrem = vi.fn().mockResolvedValue(1);
const kvRpush = vi.fn().mockResolvedValue(1);
const kvIncr = vi.fn().mockResolvedValue(1);
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem, rpush: kvRpush, incr: kvIncr, del: vi.fn().mockResolvedValue(1) }),
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
    letter: 'C', review: 'r', calibration: 'matched',
    tendencies_hit: [], model: 'm', usage: {}, ts: '...',
  }),
}));

vi.mock('../../api/_lib/proposal-prompts', () => ({
  proposeNewRule: vi.fn(),
  proposeDemote: vi.fn(),
}));
// Stub the auto-import worker so runAutoImport() in gradeOpenTrades is a no-op.
// Without this, runAutoImport calls alpacaTrade with 'conservative' (and other
// modes) and writes import:cursor:* KV keys, which causes 'conservative' to
// appear in the modes used and breaks cross-account routing assertions.
vi.mock('../../api/trades/[action]', () => ({
  runImport: vi.fn().mockResolvedValue({ imported: 0, skipped_existing: 0, spread_pairs_found: 0, errors: [], created_trade_ids: [] }),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

// A filled STO put with no close order. modify_history non-empty so
// syncFillData short-circuits (no Alpaca order fetch) and detectClose is
// the only thing that hits alpacaTrade.
const stoPut = {
  id: 'T-2026-05-12-001',
  account: 'manual_paper',
  asset_class: 'option',
  symbol: 'SNAP',
  contract_symbol: 'SNAP260515P00007500',
  contract_type: 'put',
  side: 'STO',
  strike: 7.5,
  expiration: '2026-05-15',
  qty: 1,
  filled_avg_price: 1.8,
  filled_at: '2026-05-12T19:13:00Z',
  submitted_at: '2026-05-12T17:51:00Z',
  alpaca_order_id: 'order-1',
  alpaca_close_order_id: null,
  closed_at: null,
  closed_avg_price: null,
  realized_pnl: null,
  closed_by: null,
  modify_history: [{ ts: '2026-05-12T19:13:00Z', prev_order_id: 'order-0', new_order_id: 'order-1', source: 'backfill' }],
  tags: ['test_buy'],
  entry_grade: 'F',
  entry_reasoning: 'forcing an assignment to test stage 2',
  greeks_at_entry: null,
  rule_warnings_at_entry: [],
  exposure_at_submit: 750,
  schema: 1,
};

const handlerReq = {
  method: 'GET',
  query: { job: 'grade-open-trades' },
  headers: { authorization: 'Bearer tok' },
} as any;

async function runHandler() {
  const handler = (await import('../../api/cron/[job]')).default;
  const res = mkRes();
  await handler(handlerReq, res);
  return res;
}

function closedTradeWrite() {
  // Find the write that carries closed_by (the actual close, not the
  // fill_confirmed:true convergence write from the legacy syncFillData guard).
  return kvSet.mock.calls.find(
    (c: any) => c[0] === `trade:${stoPut.id}` && c[1]?.closed_by != null,
  )?.[1] ?? null;
}

function spawnedStockWrite() {
  return kvSet.mock.calls.find(
    (c: any) =>
      typeof c[0] === 'string'
      && c[0].startsWith('trade:T-')
      && c[0] !== `trade:${stoPut.id}`,
  )?.[1];
}

describe('grade-open-trades — STO put close: assigned vs expired', () => {
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
    vi.setSystemTime(new Date('2026-05-16T14:00:00Z')); // ~18h past 5/15 expiry

    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return [stoPut.id];
      if (k === 'trades:index:assignments-pending') {
        return kvRpush.mock.calls
          .filter((c: any) => c[0] === 'trades:index:assignments-pending')
          .map((c: any) => c[1]);
      }
      return [];
    });
    kvGet.mockImplementation(async (k: string) => {
      if (k === `trade:${stoPut.id}`) return { ...stoPut };
      if (k === `grade:${stoPut.id}`) {
        return { trade_id: stoPut.id, entry: { letter: 'F' }, hindsight: null };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('OPASN activity → closed_by "assigned" and spawns the follow-on stock trade', async () => {
    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        return [{
          id: 'act-1',
          activity_type: 'OPASN',
          symbol: 'SNAP260515P00007500',
          qty: '1',
          date: '2026-05-15',
        }];
      }
      return null;
    });

    const res = await runHandler();
    expect(res.status).toHaveBeenCalledWith(200);

    const closed = closedTradeWrite();
    expect(closed).toBeDefined();
    expect(closed.closed_by).toBe('assigned');
    // Premium is still fully kept on the option leg regardless of assignment.
    expect(closed.realized_pnl).toBe(180);
    expect(closed.closed_avg_price).toBe(0);

    const spawned = spawnedStockWrite();
    expect(spawned).toBeDefined();
    expect(spawned.asset_class).toBe('stock');
    expect(spawned.symbol).toBe('SNAP');
    expect(spawned.qty).toBe(100);
    expect(spawned.parent_id).toBe(stoPut.id);
    expect(spawned.source).toBe('assignment');
  });

  it('OPEXP activity → closed_by "expired", no spawn', async () => {
    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        return [{
          id: 'act-1',
          activity_type: 'OPEXP',
          symbol: 'SNAP260515P00007500',
          qty: '1',
          date: '2026-05-15',
        }];
      }
      return null;
    });

    const res = await runHandler();
    expect(res.status).toHaveBeenCalledWith(200);

    const closed = closedTradeWrite();
    expect(closed.closed_by).toBe('expired');
    expect(closed.realized_pnl).toBe(180);
    expect(spawnedStockWrite()).toBeUndefined();
  });

  it('no activity yet, within 3 days of expiry → trade left open (not closed)', async () => {
    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) return [];
      return null;
    });

    const res = await runHandler();
    expect(res.status).toHaveBeenCalledWith(200);

    // detectClose returned null → no close write, still in open index.
    const closed = closedTradeWrite();
    expect(closed?.closed_by ?? null).toBeNull();
    expect(kvLrem).not.toHaveBeenCalledWith('trades:index:open', 0, stoPut.id);
  });

  // D11 (2026-06-17): the old "backstop closes as 'expired'" behavior was replaced
  // with a conservative posture that cross-checks the underlying position before
  // booking. Without activity AND without a stock position, the trade now stays
  // open (so a silently-wrong "expired" win is never fabricated for a truly-assigned
  // contract). See dashboard/tests/api/cron-d11-settlement-backstop.test.ts for
  // the full D11 matrix.
  it('D11: no activity, >3 days past expiry, no stock position → trade stays OPEN (conservative backstop)', async () => {
    vi.setSystemTime(new Date('2026-05-19T14:00:00Z')); // ~3.75 days past 5/15
    alpacaTrade.mockImplementation(async (_mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) return [];
      if (path.includes('/v2/positions/')) {
        // No stock position — no assignment evidence
        throw new Error('alpaca trade 404 on /v2/positions/SNAP: position not found');
      }
      return null;
    });

    const res = await runHandler();
    expect(res.status).toHaveBeenCalledWith(200);

    // Conservative D11 posture: trade stays OPEN, no false-win booking.
    const closed = closedTradeWrite();
    expect(closed?.closed_by ?? null).toBeNull();
    expect(kvLrem).not.toHaveBeenCalledWith('trades:index:open', 0, stoPut.id);
    expect(spawnedStockWrite()).toBeUndefined();
  });
});

// Phase-6 cross-account routing guard. main's resolveOptionSettlement narrowed
// its mode param to 'conservative' | 'aggressive' | 'manual'; combined with the
// SM-aware modeFromAccount() this branch added, an SM (or live) trade's
// settlement-activity fetch must hit its OWN account's Alpaca creds, NOT silently
// coerce to conservative. This asserts the mode threaded through
// detectClose → resolveOptionSettlement → alpacaTrade('/v2/account/activities')
// is the real per-trade SM mode.
describe('grade-open-trades — STO settlement routes to the correct live account creds', () => {
  // Same STO put, but on the live account.
  const smStoPut = { ...stoPut, id: 'T-2026-05-12-099', account: 'live' };

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
    vi.setSystemTime(new Date('2026-05-16T14:00:00Z')); // ~18h past 5/15 expiry

    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return [smStoPut.id];
      if (k === 'trades:index:assignments-pending') {
        return kvRpush.mock.calls
          .filter((c: any) => c[0] === 'trades:index:assignments-pending')
          .map((c: any) => c[1]);
      }
      return [];
    });
    kvGet.mockImplementation(async (k: string) => {
      if (k === `trade:${smStoPut.id}`) return { ...smStoPut };
      if (k === `grade:${smStoPut.id}`) {
        return { trade_id: smStoPut.id, entry: { letter: 'F' }, hindsight: null };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes mode "live" (not "manual") to the settlement-activity fetch', async () => {
    const activityModes: string[] = [];
    alpacaTrade.mockImplementation(async (mode: string, path: string) => {
      if (path.includes('/v2/account/activities')) {
        activityModes.push(mode);
        return [{
          id: 'act-1',
          activity_type: 'OPEXP',
          symbol: 'SNAP260515P00007500',
          qty: '1',
          date: '2026-05-15',
        }];
      }
      return null;
    });

    const res = await runHandler();
    expect(res.status).toHaveBeenCalledWith(200);

    // The settlement fetch ran, and it ran against the live account's creds.
    expect(activityModes.length).toBeGreaterThan(0);
    expect(activityModes).toContain('live');
    expect(activityModes).not.toContain('manual');

    // And the trade still closes correctly (settlement logic unchanged for SM).
    // Use the write that carries closed_by (the actual close, not the
    // fill_confirmed:true convergence write from the legacy syncFillData guard).
    const closed = kvSet.mock.calls.find(
      (c: any) => c[0] === `trade:${smStoPut.id}` && c[1]?.closed_by != null,
    )?.[1];
    expect(closed.closed_by).toBe('expired');
    expect(closed.realized_pnl).toBe(180);
  });
});
