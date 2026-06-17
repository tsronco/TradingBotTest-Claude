// dashboard/tests/api/cron-external-close-detect.test.ts
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
const gradeMock = vi.fn();
const dataMock = vi.fn();
const alpacaTradeMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem }) }));
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
  kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset();
  gradeMock.mockReset(); dataMock.mockReset(); alpacaTradeMock.mockReset();
  process.env.CRON_TOKEN = 'cron-token';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-25T12:00:00Z')); // before all expirations in this file
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

describe('detectClose Path 3 — external bot-close (option)', () => {
  it('NVTS case: bot bought-to-close a user-opened STO with no alpaca_close_order_id', async () => {
    // Trade: STO 2 NVTS260605P00020500 @ $2.12 on 2026-05-14
    // Alpaca: bought back 2 contracts @ $1.05 on 2026-05-21
    // Position is gone; activity stream has the matching BTC fill.
    const trade = {
      id: 'T-2026-05-14-003', account: 'manual_paper',
      asset_class: 'option', symbol: 'NVTS',
      side: 'STO', qty: 2,
      contract_symbol: 'NVTS260605P00020500',
      strike: 20.5, expiration: '2026-06-05', contract_type: 'put',
      filled_avg_price: 2.12, filled_at: '2026-05-14T17:00:00Z',
      alpaca_order_id: 'open-order-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-14T17:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      // non-empty modify_history short-circuits syncFillData so we don't
      // need to mock the entry-order fetch — Path 3 is what we want to test.
      modify_history: [{
        ts: 'x', prev_order_id: 'x', new_order_id: 'x',
        limit_price: null, stop_price: null, source: 'dashboard' as const,
      }],
      schema: 1,
    } as any;

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });
    // Position fetch → 404 (gone). Activity fetch → matching BTC fill.
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/NVTS260605P00020500: position not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve([
          {
            id: 'fill-close-1', activity_type: 'FILL',
            transaction_time: '2026-05-21T15:00:00Z',
            symbol: 'NVTS260605P00020500', side: 'buy',
            price: '1.05', qty: '2', order_id: 'btc-order-1',
          },
        ]);
      }
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { NVTS: [] } });
    gradeMock.mockResolvedValue({
      letter: 'A', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // Trade record updated to closed_by: 'bot_external'
    // realized_pnl: (entry_premium 2.12 - close_premium 1.05) * 100 * 2 = 214
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-21T15:00:00Z',
      closed_avg_price: 1.05,
      realized_pnl: expect.closeTo(214, 2),
      closed_by: 'bot_external',
      alpaca_close_order_id: 'btc-order-1',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('does NOT close trade when position still exists on Alpaca', async () => {
    const trade = {
      id: 'T-2026-05-14-004', account: 'manual_paper',
      asset_class: 'option', symbol: 'NVTS',
      side: 'STO', qty: 2, contract_symbol: 'NVTS260605P00020500',
      strike: 20.5, expiration: '2026-06-05', contract_type: 'put',
      filled_avg_price: 2.12, filled_at: '2026-05-14T17:00:00Z',
      alpaca_order_id: 'open-order-2', alpaca_close_order_id: null,
      submitted_at: '2026-05-14T17:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    // Position exists — alpacaTrade returns the position object.
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.resolve({ symbol: 'NVTS260605P00020500', qty: '-2' });
      }
      return Promise.resolve([]);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // Trade stays open — no trade-record write, no removal from open index.
    // (runAutoImport writes import:cursor:* keys as a side-effect — those are
    // expected and are not what this assertion guards against.)
    expect(kvSet).not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything());
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('does NOT close trade when position gone but no matching activity yet', async () => {
    const trade = {
      id: 'T-2026-05-14-005', account: 'manual_paper',
      asset_class: 'option', symbol: 'NVTS',
      side: 'STO', qty: 2, contract_symbol: 'NVTS260605P00020500',
      strike: 20.5, expiration: '2026-06-05', contract_type: 'put',
      filled_avg_price: 2.12, filled_at: '2026-05-14T17:00:00Z',
      alpaca_order_id: 'open-order-3', alpaca_close_order_id: null,
      submitted_at: '2026-05-14T17:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: position not found'));
      }
      if (path.includes('/v2/account/activities')) {
        // No matching closing fills — empty list
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());
    // Trade stays open — no trade-record write, no removal from open index.
    expect(kvSet).not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything());
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('AAL case: spread both legs closed externally', async () => {
    // Spread: STO AAL 12.5 P + BTO AAL 11.5 P at $0.25 net credit on 2026-05-14
    // Closed: BTC AAL 12.5 P @ $0.16 + STC AAL 11.5 P @ $0.02 on 2026-05-21
    // Net debit to close: 0.16 - 0.02 = 0.14. Realized: (0.25 - 0.14) * 100 = $11
    const trade = {
      id: 'T-2026-05-14-006', account: 'manual_paper',
      asset_class: 'spread', symbol: 'AAL',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-05-29', contract_type: null,
      filled_avg_price: 0.25, filled_at: '2026-05-14T18:00:00Z',
      alpaca_order_id: 'mleg-open-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-14T18:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        expiration: '2026-05-29',
        width: 1.0,
        net_credit: 0.25,
        max_loss: 0.75,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        // Both legs gone
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: position not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve([
          {
            id: 'fill-short-close', activity_type: 'FILL',
            transaction_time: '2026-05-21T16:00:00Z',
            symbol: 'AAL260529P00012500', side: 'buy',
            price: '0.16', qty: '1', order_id: 'mleg-close-1',
          },
          {
            id: 'fill-long-close', activity_type: 'FILL',
            transaction_time: '2026-05-21T16:00:00Z',
            symbol: 'AAL260529P00011500', side: 'sell',
            price: '0.02', qty: '1', order_id: 'mleg-close-1',
          },
        ]);
      }
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { AAL: [] } });
    gradeMock.mockResolvedValue({
      letter: 'B', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-21T16:00:00Z',
      closed_avg_price: expect.closeTo(0.14, 5),
      // (net_credit 0.25 - net_debit 0.14) * 100 * qty 1 = 11
      realized_pnl: expect.closeTo(11, 2),
      closed_by: 'bot_external',
      alpaca_close_order_id: 'mleg-close-1',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('does NOT close spread when only one leg is gone (orphan)', async () => {
    const trade = {
      id: 'T-2026-05-14-007', account: 'manual_paper',
      asset_class: 'spread', symbol: 'AAL',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-05-29', contract_type: null,
      filled_avg_price: 0.25, filled_at: '2026-05-14T18:00:00Z',
      alpaca_order_id: 'mleg-open-2', alpaca_close_order_id: null,
      submitted_at: '2026-05-14T18:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        expiration: '2026-05-29',
        width: 1.0, net_credit: 0.25, max_loss: 0.75,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/AAL260529P00012500')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      if (path.includes('/v2/positions/AAL260529P00011500')) {
        // Long leg still exists
        return Promise.resolve({ symbol: 'AAL260529P00011500', qty: '1' });
      }
      return Promise.resolve([]);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());
    // Trade stays open — orphan handler in the bot will deal with the survivor.
    // No trade-record write, no removal from open index.
    expect(kvSet).not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything());
    expect(kvLrem).not.toHaveBeenCalled();
  });
});

// ─── D13: findClosingFill pagination ─────────────────────────────────────────
// Verifies that findClosingFill paginates beyond the first 100 activities when
// the matching close fill is on a subsequent page, does not loop forever when
// no match exists, and caps at MAX_FILL_PAGES with a log when the cap is hit.
describe('D13 — findClosingFill pagination', () => {
  // Shared trade fixture for all D13 tests: STO NVTS option, open on 2026-05-14.
  function makeTrade(id: string): any {
    return {
      id,
      account: 'manual_paper',
      asset_class: 'option',
      symbol: 'NVTS',
      side: 'STO',
      qty: 1,
      contract_symbol: 'NVTS260605P00020500',
      strike: 20.5,
      expiration: '2026-06-05',
      contract_type: 'put',
      filled_avg_price: 2.12,
      filled_at: '2026-05-14T17:00:00Z',
      alpaca_order_id: 'open-order-d13',
      alpaca_close_order_id: null,
      submitted_at: '2026-05-14T17:00:00Z',
      closed_at: null,
      realized_pnl: null,
      closed_avg_price: null,
      closed_by: null,
      entry_grade: 'B',
      entry_reasoning: 'r',
      tags: [],
      rule_warnings_at_entry: [],
      // Non-empty modify_history short-circuits syncFillData so detectClose (Path 3) runs.
      modify_history: [{
        ts: 'x', prev_order_id: 'x', new_order_id: 'x',
        limit_price: null, stop_price: null, source: 'dashboard' as const,
      }],
      fill_confirmed: true,
      schema: 1,
    };
  }

  // Build an array of N non-matching FILL activities (wrong symbol).
  function nonMatchingFills(n: number, baseId: number): any[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `fill-noise-${baseId + i}`,
      activity_type: 'FILL',
      transaction_time: `2026-05-21T10:${String(i % 60).padStart(2, '0')}:00Z`,
      symbol: 'OTHER260605P00010000',
      side: 'buy',
      price: '0.50',
      qty: '1',
      order_id: `noise-order-${baseId + i}`,
    }));
  }

  it('D13a: matching closing fill on page 2 is found after pagination', async () => {
    // Page 1: 100 non-matching fills (different symbol).
    // Page 2: the real BTC fill for NVTS260605P00020500.
    // Expects: trade is closed, kvSet called with closed_by:'bot_external'.
    const trade = makeTrade('T-D13-001');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });

    const page1Fills = nonMatchingFills(100, 0);
    const page2Fills = [
      {
        id: 'fill-close-d13a',
        activity_type: 'FILL',
        transaction_time: '2026-05-21T15:00:00Z',
        symbol: 'NVTS260605P00020500',
        side: 'buy',
        price: '1.05',
        qty: '1',
        order_id: 'btc-order-d13a',
      },
    ];

    // Track how many times activities is fetched to assert pagination happened.
    let activitiesCallCount = 0;
    alpacaTradeMock.mockImplementation((_mode: any, path: string, params?: any) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/NVTS260605P00020500: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        activitiesCallCount++;
        // First call (no page_token or empty): return 100 non-matching fills.
        // Second call (page_token set to last fill id of page 1): return page 2 with the match.
        if (!params?.page_token) {
          return Promise.resolve(page1Fills);
        }
        return Promise.resolve(page2Fills);
      }
      return Promise.resolve(null);
    });

    dataMock.mockResolvedValue({ bars: { NVTS: [] } });
    gradeMock.mockResolvedValue({
      letter: 'A', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // Trade should be closed via the page-2 fill.
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-21T15:00:00Z',
      closed_avg_price: 1.05,
      realized_pnl: expect.closeTo(107, 2), // (2.12 - 1.05) * 100 * 1
      closed_by: 'bot_external',
      alpaca_close_order_id: 'btc-order-d13a',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
    // Pagination happened: activities fetched at least twice.
    expect(activitiesCallCount).toBeGreaterThanOrEqual(2);
  });

  it('D13b: no matching fill across all pages — returns null, does not loop forever', async () => {
    // Every page returns 100 non-matching fills. After MAX pages, function gives up.
    // Trade stays open.
    const trade = makeTrade('T-D13-002');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));

    let activitiesCallCount = 0;
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/NVTS260605P00020500: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        activitiesCallCount++;
        // Always return a full page of non-matching fills so the loop keeps going
        // until the page cap is hit (not until the page is < 100 items).
        return Promise.resolve(nonMatchingFills(100, activitiesCallCount * 100));
      }
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // Trade stays open — no close.
    expect(kvSet).not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything());
    expect(kvLrem).not.toHaveBeenCalled();
    // Loop stopped at or before the page cap (10 pages).
    expect(activitiesCallCount).toBeGreaterThanOrEqual(1);
    expect(activitiesCallCount).toBeLessThanOrEqual(10);
  });

  it('D13c: page cap is enforced and a log is emitted when the cap is hit', async () => {
    // Same as D13b but we spy on console.log to verify the cap-hit log fires.
    const trade = makeTrade('T-D13-003');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));

    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/NVTS260605P00020500: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        // Always full pages — never reaches end-of-data naturally.
        return Promise.resolve(nonMatchingFills(100, Math.random() * 1000 | 0));
      }
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq(), mockRes());

      // A log message mentioning the page cap must have been emitted.
      const capLogFired = logSpy.mock.calls.some(
        (args) => args.some((a) => typeof a === 'string' && a.includes('findClosingFill page cap'))
      );
      expect(capLogFired).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── D14: spread-close P&L deferred until fill is confirmed ──────────────────
// Gap: a legacy spread trade that has filled_at set (so detectClose Path 0 is
// bypassed) but fill_confirmed is absent and net_credit is the decision-time
// target mid. On such a trade, syncFillData hits the legacy guard (line 364:
// filled_at && modify_history.length > 0) and returns early without re-syncing
// the real fill credit. Then detectExternalSpreadClose computes realized P&L
// from the stale mid — a minor but real P&L inaccuracy.
//
// Fix: in detectExternalSpreadClose, if !fill_confirmed, defer the close
// (return null) so syncFillData can capture the real credit on the NEXT tick
// (which won't hit the legacy guard because modify_history was preserved).
// A 24h backstop overrides the defer to prevent indefinite deferral.
describe('D14 — spread close deferred until entry fill is confirmed', () => {
  // Base fixture: legacy spread — filled_at set, modify_history non-empty,
  // fill_confirmed absent, net_credit is the stale target mid (0.25).
  // In this state syncFillData hits the legacy guard and returns unchanged.
  function makeLegacySpread(id: string, overrides: any = {}): any {
    return {
      id,
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'GME',
      side: 'STO',
      qty: 1,
      contract_symbol: null,
      strike: null,
      expiration: '2026-06-20',
      contract_type: null,
      filled_avg_price: 0.25,
      filled_at: '2026-05-25T11:32:00Z',  // set — Path 0 bypassed
      fill_confirmed: undefined,            // absent — legacy pre-D7 trade
      alpaca_order_id: 'mleg-open-d14',
      alpaca_close_order_id: null,
      submitted_at: '2026-05-25T11:30:00Z',
      closed_at: null,
      realized_pnl: null,
      closed_avg_price: null,
      closed_by: null,
      entry_grade: 'B',
      entry_reasoning: 'r',
      tags: [],
      rule_warnings_at_entry: [],
      // Non-empty: triggers the legacy syncFillData guard, so no re-sync runs
      modify_history: [{
        ts: 't', prev_order_id: 'x', new_order_id: 'y',
        limit_price: null, stop_price: null, source: 'dashboard' as const,
      }],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'GME260620P00020000', strike: 20.0, entry_premium: 0.38, fill_price: 0.38, qty: 1 },
        long_leg:  { occ: 'GME260620P00019000', strike: 19.0, entry_premium: 0.13, fill_price: 0.13, qty: 1 },
        expiration: '2026-06-20',
        width: 1.0,
        net_credit: 0.25,  // stale target mid — real fill was 0.23 (not yet synced)
        max_loss: 0.75,
      },
      ...overrides,
    };
  }

  // Common mock for both legs gone + closing fills present
  function closingFillsMock() {
    return [
      {
        id: 'fill-short-d14', activity_type: 'FILL',
        transaction_time: '2026-05-25T11:55:00Z',
        symbol: 'GME260620P00020000', side: 'buy',
        price: '0.12', qty: '1', order_id: 'mleg-close-d14',
      },
      {
        id: 'fill-long-d14', activity_type: 'FILL',
        transaction_time: '2026-05-25T11:55:00Z',
        symbol: 'GME260620P00019000', side: 'sell',
        price: '0.02', qty: '1', order_id: 'mleg-close-d14',
      },
    ];
  }

  it('D14a: defers close booking when entry fill is NOT yet confirmed (legacy, fill_confirmed absent)', async () => {
    // Legacy spread: filled_at set, modify_history non-empty → syncFillData
    // hits legacy guard, returns unchanged (net_credit still stale 0.25).
    // Both legs gone, closing fills found.
    // Expected: close is DEFERRED (null returned) this tick.
    // Without the fix: would book with realized = (0.25 - 0.10) * 100 = $15
    //   (wrong — real fill credit was 0.23, so real realized is $13).
    // With the fix: return null, trade stays open until next tick when
    //   fill_confirmed will be set and net_credit will be 0.23.
    const trade = makeLegacySpread('T-D14-001');

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));

    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      // detectExternalSpreadClose: both legs gone
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve(closingFillsMock());
      }
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // Close MUST NOT be booked this tick — stale net_credit would give wrong P&L.
    expect(kvSet).not.toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ closed_at: expect.anything() }),
    );
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('D14b: confirmed spread (fill_confirmed true) books close normally, P&L from real fill', async () => {
    // fill_confirmed:true → syncFillData early-returns, net_credit is already
    // the real fill (0.23). detectExternalSpreadClose MUST book immediately.
    // D14 guard must NOT defer when fill is confirmed.
    const trade = makeLegacySpread('T-D14-002', {
      fill_confirmed: true,
      filled_avg_price: 0.23,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'GME260620P00020000', strike: 20.0, entry_premium: 0.38, fill_price: 0.36, qty: 1 },
        long_leg:  { occ: 'GME260620P00019000', strike: 19.0, entry_premium: 0.13, fill_price: 0.13, qty: 1 },
        expiration: '2026-06-20',
        width: 1.0,
        net_credit: 0.23,  // confirmed real fill — NOT the stale mid
        max_loss: 0.77,
      },
    });

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });

    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve(closingFillsMock());
      }
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { GME: [] } });
    gradeMock.mockResolvedValue({
      letter: 'B', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // Net debit = 0.12 - 0.02 = 0.10. Realized = (0.23 - 0.10) * 100 * 1 = $13
    // (uses the CONFIRMED net_credit of 0.23, not the stale target mid of 0.25)
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-25T11:55:00Z',
      closed_avg_price: expect.closeTo(0.10, 5),
      realized_pnl: expect.closeTo(13, 2),
      closed_by: 'bot_external',
      alpaca_close_order_id: 'mleg-close-d14',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('D14c: backstop — books close with warn after >24h even if still unconfirmed', async () => {
    // A legacy spread submitted >24h ago that still has no fill_confirmed should NOT
    // be deferred indefinitely. After the backstop, the close is booked from
    // whatever net_credit is stored (approximation) and a [D14] console.warn fires.
    // System time: 2026-05-25T12:00:00Z. submitted_at: 26h ago.
    const trade = makeLegacySpread('T-D14-003', {
      submitted_at: '2026-05-24T10:00:00Z', // 26h before frozen clock
    });

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });

    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve(closingFillsMock());
      }
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { GME: [] } });
    gradeMock.mockResolvedValue({
      letter: 'B', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq(), mockRes());

      // After >24h backstop: close IS booked (with stale net_credit approximation)
      expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
        closed_at: '2026-05-25T11:55:00Z',
        closed_by: 'bot_external',
      }));
      expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);

      // A console.warn noting the approximation must have fired
      const warnFired = warnSpy.mock.calls.some(
        (args) => args.some((a) => typeof a === 'string' && a.includes('[D14]'))
      );
      expect(warnFired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
