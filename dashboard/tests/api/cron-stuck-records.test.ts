// dashboard/tests/api/cron-stuck-records.test.ts
//
// Path 3 of detectClose — external bot-close detection.
// Covers the NVTS case (bot bought-to-close a user-opened CSP via its own
// Alpaca client, no alpaca_close_order_id on the trade record) and a
// spread variant where both legs are closed externally.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrange = vi.fn();
const kvLrem = vi.fn();
const kvDel = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
const alpacaTradeMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem, del: kvDel }) }));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
  alpacaTrade: (...a: any[]) => alpacaTradeMock(...a),
}));
// Stub the auto-import worker so runAutoImport() in gradeOpenTrades is a no-op.
// Without this, runAutoImport calls alpacaTrade with 'conservative' (and other
// modes) and writes import:cursor:* KV keys, which breaks tests that assert
// kvSet/kvLrem was not called.
vi.mock('../../api/trades/[action]', () => ({
  runImport: vi.fn().mockResolvedValue({ imported: 0, skipped_existing: 0, spread_pairs_found: 0, errors: [], created_trade_ids: [] }),
}));

// All trades in this file have option expirations in 2026-05/06 which are now
// past. Freeze time before all expirations so detectClose Path 2 (option past
// expiry / backstop) never fires and Path 3 (external close) is what gets tested.
beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset(); kvDel.mockReset();
  gradeMock.mockReset(); dataMock.mockReset(); alpacaTradeMock.mockReset();
  process.env.CRON_TOKEN = 'cron-token';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T18:00:00Z')); // after DIS (09-18) and SLV (10-23) expiry
});

afterEach(() => {
  vi.useRealTimers();
});

function mockReq(): VercelRequest {
  return {
    method: 'POST',
    query: { job: 'grade-open-trades' },
    headers: { authorization: 'Bearer cron-token' },
  } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

// Records that sat "open" forever before 2026-11-03:
//   - an option leg closed BEFORE expiry but only checked AFTER it (agent DIS /
//     SLV short call legs): Path 2's settlement lookup returned null and the
//     real closing fill (Path 3) was never consulted.
//   - a stock SALE recorded as its own trade (WMT sell 1, SNAP sell 5): Path 4
//     waited for a buy-to-cover that never comes.

function grade(id: string) {
  return { trade_id: id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] };
}

function seed(trade: any) {
  kvLrange.mockResolvedValueOnce([trade.id]);
  kvLrem.mockResolvedValue(1);
  kvSet.mockResolvedValue('OK');
  kvGet.mockImplementation((k: string) => {
    if (k === `trade:${trade.id}`) return Promise.resolve(trade);
    if (k === `grade:${trade.id}`) return Promise.resolve(grade(trade.id));
    return Promise.resolve(null);
  });
  dataMock.mockResolvedValue({ bars: {} });
  gradeMock.mockResolvedValue({
    letter: 'B', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's',
    usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
  });
}

async function run() {
  const handler = (await import('../../api/cron/[job]')).default;
  await handler(mockReq(), mockRes());
}

const DIS_OCC = 'DIS260918C00111000';
function disShortLeg(over: any = {}): any {
  return {
    id: 'T-2026-09-04-005', account: 'agent_paper',
    asset_class: 'option', symbol: 'DIS', side: 'STO', qty: 1,
    contract_symbol: DIS_OCC, strike: 111, expiration: '2026-09-18', contract_type: 'call',
    filled_avg_price: 0.62, filled_at: '2026-09-01T18:12:00Z',
    alpaca_order_id: 'dis-open', alpaca_close_order_id: null,
    submitted_at: '2026-09-01T18:12:00Z', closed_at: null,
    realized_pnl: null, closed_avg_price: null, closed_by: null,
    entry_grade: 'B', entry_reasoning: 'r', tags: ['imported', 'agent'], rule_warnings_at_entry: [],
    fill_confirmed: true, schema: 1, ...over,
  };
}

describe('option leg closed before expiry, checked after it', () => {
  it('books the real closing fill instead of waiting forever for OPEXP/OPASN', async () => {
    const trade = disShortLeg();
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string, params: any) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error(`alpaca trade 404 on ${path}: not found`));
      if (path.includes('/v2/account/activities')) {
        if (String(params?.activity_types ?? '').includes('FILL')) {
          return Promise.resolve([{ id: 'f1', activity_type: 'FILL', transaction_time: '2026-09-10T15:00:00Z',
            symbol: DIS_OCC, side: 'buy', price: '0.20', qty: '1', order_id: 'dis-close' }]);
        }
        return Promise.resolve([]); // no OPEXP/OPASN — it never expired, it was closed
      }
      return Promise.resolve(null);
    });

    await run();

    // sold at 0.62, bought back at 0.20 → +$42
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-09-10T15:00:00Z',
      closed_avg_price: 0.20,
      realized_pnl: expect.closeTo(42, 2),
      closed_by: 'bot_external',
      alpaca_close_order_id: 'dis-close',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('a genuine expiry (no closing fill) still settles via OPEXP — unchanged', async () => {
    const trade = disShortLeg({ id: 'T-2026-09-04-006' });
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string, params: any) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error(`alpaca trade 404 on ${path}: not found`));
      if (path.includes('/v2/account/activities')) {
        if (String(params?.activity_types ?? '').includes('OPEXP')) {
          return Promise.resolve([{ activity_type: 'OPEXP', symbol: DIS_OCC }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    await run();

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
      realized_pnl: expect.closeTo(62, 2),
    }));
  });
});

function saleRecord(over: any = {}): any {
  return {
    id: 'T-2026-09-08-001', account: 'live',
    asset_class: 'stock', symbol: 'WMT', side: 'sell', qty: 1,
    contract_symbol: null, strike: null, expiration: null, contract_type: null,
    filled_avg_price: 110.23, filled_at: '2026-09-08T15:00:00Z',
    alpaca_order_id: 'wmt-sell', alpaca_close_order_id: null,
    submitted_at: '2026-09-08T14:00:00Z', closed_at: null,
    realized_pnl: null, closed_avg_price: null, closed_by: null,
    entry_grade: 'C+', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
    fill_confirmed: true, schema: 1, ...over,
  };
}

describe('stock sale recorded as its own trade', () => {
  it('closes at its own fill with null P&L and no AI grade', async () => {
    const trade = saleRecord();
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error(`alpaca trade 404 on ${path}: not found`));
      return Promise.resolve([]);
    });

    await run();

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-09-08T15:00:00Z',
      closed_avg_price: 110.23,
      realized_pnl: null,
      closed_by: 'manual',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
    expect(gradeMock).not.toHaveBeenCalled();
  });

  it('closes even when you still hold some of the shares (a partial sale is still an exit)', async () => {
    const trade = saleRecord({ id: 'T-2026-07-17-001', symbol: 'SNAP', qty: 5, filled_avg_price: 4.65 });
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: 'SNAP', qty: '10' });
      return Promise.resolve([]);
    });

    await run();

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_by: 'manual', realized_pnl: null }));
  });

  it('leaves a genuine short position open (that is Path 4\'s job)', async () => {
    const trade = saleRecord({ id: 'T-2026-09-08-002' });
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: 'WMT', qty: '-1' });
      return Promise.resolve([]);
    });

    await run();

    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.anything() }));
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('a later re-buy of the same size is NOT booked as covering a short', async () => {
    const trade = saleRecord({ id: 'T-2026-09-08-003' });
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error(`alpaca trade 404 on ${path}: not found`));
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'b1', activity_type: 'FILL', transaction_time: '2026-10-01T15:00:00Z',
          symbol: 'WMT', side: 'buy', price: '100.00', qty: '1', order_id: 'wmt-rebuy' },
      ]);
      return Promise.resolve(null);
    });

    await run();

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'manual', realized_pnl: null, closed_avg_price: 110.23,
    }));
    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ alpaca_close_order_id: 'wmt-rebuy' }));
  });
});

// Phantom cleanup: an imported "STO" that was really the sale closing a long.
const SLV_OCC = 'SLV261023C00059500';
function slvPhantom(over: any = {}): any {
  return {
    id: 'T-2026-11-03-003', account: 'agent_paper',
    asset_class: 'option', symbol: 'SLV', side: 'STO', qty: 1,
    contract_symbol: SLV_OCC, strike: 59.5, expiration: '2026-10-23', contract_type: 'call',
    filled_avg_price: 0.78, filled_at: '2026-09-28T14:12:00Z',
    alpaca_order_id: 'slv-sell', alpaca_close_order_id: null,
    submitted_at: '2026-09-28T14:12:00Z', closed_at: null,
    realized_pnl: null, closed_avg_price: null, closed_by: null,
    entry_grade: 'B', entry_reasoning: 'r', tags: ['imported', 'agent'], rule_warnings_at_entry: [],
    fill_confirmed: true, schema: 1, ...over,
  };
}

describe('phantom sell-to-close records', () => {
  it('deletes the record when Alpaca shows the account was long the contract before the sale', async () => {
    const trade = slvPhantom();
    seed(trade);
    kvDel.mockResolvedValue(1);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'b', symbol: SLV_OCC, side: 'buy', qty: '1', transaction_time: '2026-09-17T13:13:00Z' },
        { id: 's', symbol: SLV_OCC, side: 'sell', qty: '1', transaction_time: '2026-09-28T14:12:00Z' },
      ]);
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq(), res);

    expect(kvDel).toHaveBeenCalledWith(`trade:${trade.id}`);
    expect(kvDel).toHaveBeenCalledWith(`grade:${trade.id}`);
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
    // filed under the FILL month (2026-09) as well as the id month (2026-11)
    expect(kvLrem).toHaveBeenCalledWith('trades:index:2026-09', 0, trade.id);
    expect(kvLrem).toHaveBeenCalledWith('trades:index:2026-11', 0, trade.id);
    // never "closed" with a fabricated P&L — it was never a trade
    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.anything());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ phantoms_removed: 1, remaining_open: 0 }));
  });

  it('keeps a genuine opening sale, flags it checked, and does not re-check it', async () => {
    const trade = slvPhantom({ id: 'T-2026-09-28-009' });
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 's', symbol: SLV_OCC, side: 'sell', qty: '1', transaction_time: '2026-09-28T14:12:00Z' },
      ]);
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: SLV_OCC, qty: '-1' });
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvDel).not.toHaveBeenCalled();
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ phantom_checked: true }));
  });

  it('skips the check for a record already flagged phantom_checked', async () => {
    const trade = slvPhantom({ id: 'T-2026-09-28-010', phantom_checked: true });
    seed(trade);
    const activityCalls: any[] = [];
    alpacaTradeMock.mockImplementation((_m: any, path: string, params: any) => {
      if (path.includes('/v2/account/activities')) { activityCalls.push(params); return Promise.resolve([]); }
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: SLV_OCC, qty: '-1' });
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvDel).not.toHaveBeenCalled();
    // no 120-day history walk (that query starts ~4 months before the fill)
    expect(activityCalls.some((p) => p?.after === '2026-05-31')).toBe(false);
  });
});

// One market order, several executions: live CMG, bought 4 @ 32.8567 on
// 2026-09-23, sold 4 at market on 2026-10-19 (avg 29.550175) as 3 + 1.
function cmgLot(over: any = {}): any {
  return {
    id: 'T-2026-09-23-001', account: 'live',
    asset_class: 'stock', symbol: 'CMG', side: 'buy', qty: 4,
    contract_symbol: null, strike: null, expiration: null, contract_type: null,
    filled_avg_price: 32.8567, filled_at: '2026-09-23T18:37:18Z',
    alpaca_order_id: 'cmg-buy', alpaca_close_order_id: null,
    submitted_at: '2026-09-23T18:37:00Z', closed_at: null,
    realized_pnl: null, closed_avg_price: null, closed_by: null,
    entry_grade: 'C+', entry_reasoning: 'r', tags: ['gut_feel'], rule_warnings_at_entry: [],
    fill_confirmed: true, schema: 1, ...over,
  };
}
const CMG_FILLS = [
  { id: 'e1', activity_type: 'FILL', transaction_time: '2026-10-19T13:33:32Z',
    symbol: 'CMG', side: 'sell', price: '29.55', qty: '3', order_id: 'cmg-sell' },
  { id: 'e2', activity_type: 'FILL', transaction_time: '2026-10-19T13:33:32Z',
    symbol: 'CMG', side: 'sell', price: '29.5507', qty: '1', order_id: 'cmg-sell' },
];

describe('stock lot sold by one order that filled in several executions', () => {
  it('closes at the order average when the ORDER matches the lot size', async () => {
    const trade = cmgLot();
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error(`alpaca trade 404 on ${path}: not found`));
      if (path.includes('/v2/account/activities')) return Promise.resolve(CMG_FILLS);
      if (path.endsWith('/v2/orders/cmg-sell')) return Promise.resolve({
        id: 'cmg-sell', status: 'filled', filled_qty: '4', filled_avg_price: '29.550175',
        filled_at: '2026-10-19T13:33:32Z',
      });
      return Promise.resolve(null);
    });

    await run();

    // (29.550175 − 32.8567) × 4 = −13.2261
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-10-19T13:33:32Z',
      closed_avg_price: 29.550175,
      realized_pnl: expect.closeTo(-13.2261, 3),
      closed_by: 'bot_external',
      alpaca_close_order_id: 'cmg-sell',
    }));
  });

  it('stays open when that order sold MORE than this lot (another lot mixed in)', async () => {
    const trade = cmgLot({ id: 'T-2026-09-23-002' });
    seed(trade);
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error(`alpaca trade 404 on ${path}: not found`));
      if (path.includes('/v2/account/activities')) return Promise.resolve(CMG_FILLS);
      if (path.endsWith('/v2/orders/cmg-sell')) return Promise.resolve({
        id: 'cmg-sell', status: 'filled', filled_qty: '6', filled_avg_price: '29.55',
      });
      return Promise.resolve(null);
    });

    await run();

    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.anything() }));
  });
});
