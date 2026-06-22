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

    // Trade stays open — legacy-guard convergence may write fill_confirmed:true
    // but must NOT write closed_at (the close itself must not fire).
    expect(kvSet).not.toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ closed_at: expect.anything() }),
    );
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
    // Trade stays open — legacy-guard convergence may write fill_confirmed:true
    // but must NOT write closed_at (the close itself must not fire).
    expect(kvSet).not.toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ closed_at: expect.anything() }),
    );
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
    // Legacy-guard convergence may write fill_confirmed:true but must NOT write
    // closed_at (the close itself must not fire because one leg is still present).
    expect(kvSet).not.toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ closed_at: expect.anything() }),
    );
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

  it('D14a: legacy guard convergence — fill_confirmed set by syncFillData, close booked immediately (not deferred)', async () => {
    // Legacy spread: filled_at set, modify_history non-empty, fill_confirmed absent.
    // With the legacy-guard fix, syncFillData stamps fill_confirmed:true and persists
    // the trade. detectExternalSpreadClose is then called with fill_confirmed:true
    // and books the close immediately on the SAME tick — no deferral needed.
    // Both legs gone, closing fills present.
    // net_credit stays 0.25 (stale mid — minor approximation accepted in exchange
    // for immediate booking rather than a 24h deferral).
    // Realized = (0.25 - 0.10) * 100 * 1 = $15.
    const trade = makeLegacySpread('T-D14-001');

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
      // detectExternalSpreadClose: both legs gone
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

    // fill_confirmed:true must be set (legacy guard convergence)
    expect(kvSet).toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ fill_confirmed: true }),
    );
    // Close IS booked on the same tick — no 24h deferral.
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-25T11:55:00Z',
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(15, 2),  // (0.25 - 0.10) * 100 = $15
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
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

  it('D14c: legacy guard convergence bypasses backstop — close books immediately, NO [D14] warn', async () => {
    // A legacy spread submitted >24h ago with fill_confirmed absent and filled_at set.
    // With the legacy-guard convergence fix, syncFillData stamps fill_confirmed:true
    // before detectExternalSpreadClose evaluates the D14 guard. So the D14 defer +
    // backstop path is never reached — close books immediately without the [D14] warn.
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

      // fill_confirmed:true was written by the legacy guard
      expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
        fill_confirmed: true,
      }));
      // Close IS booked immediately (legacy guard bypassed the 24h deferral path)
      expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
        closed_at: '2026-05-25T11:55:00Z',
        closed_by: 'bot_external',
      }));
      expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);

      // The [D14] backstop warn must NOT fire — legacy guard prevented it
      const warnFired = warnSpy.mock.calls.some(
        (args) => args.some((a) => typeof a === 'string' && a.includes('[D14]'))
      );
      expect(warnFired).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── D14d: legacy-guard convergence ───────────────────────────────────────────
  //
  // The root cause of D14 is that the legacy syncFillData guard fires on EVERY
  // tick for a trade with filled_at set AND non-empty modify_history, returning
  // BEFORE the code that writes fill_confirmed:true. So fill_confirmed is never
  // set, and D14's defer logic defers forever (until the 24h backstop).
  //
  // Fix: when the legacy guard fires, the fill IS already known (filled_at is
  // set) — stamp fill_confirmed:true, persist the trade, and return it. The next
  // tick hits the primary D7 sentinel and skips the guard entirely. As a result,
  // a legacy modify-history spread is NOT needlessly deferred by D14 from the
  // second tick onward.

  it('D14d: legacy guard sets fill_confirmed:true and persists — so D14 does NOT defer on next tick', async () => {
    // Tick 1: legacy spread (filled_at set, modify_history non-empty, fill_confirmed absent).
    // Expected after tick 1:
    //   - kvSet called with fill_confirmed:true on the trade record.
    // Tick 2 simulation: same trade but now with fill_confirmed:true (as if kvSet was applied).
    // Expected: D14 does NOT defer — both legs gone + closing fills → close is booked.

    // ── Tick 1: legacy guard should converge ────────────────────────────────
    const trade: any = {
      id: 'T-D14d-001',
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
      filled_at: '2026-05-25T11:32:00Z',
      fill_confirmed: undefined,       // absent — legacy pre-D7
      alpaca_order_id: 'mleg-open-d14d',
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
      // Non-empty: triggers the legacy syncFillData guard
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
        net_credit: 0.25,
        max_loss: 0.75,
      },
    };

    // Provide closing fills so if D14 fires (incorrectly without deferral on tick 1)
    // it would have something to work with. The key assertion is that fill_confirmed
    // gets written so the NEXT tick can proceed.
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve([
          { id: 'fill-s', activity_type: 'FILL', transaction_time: '2026-05-25T11:55:00Z',
            symbol: 'GME260620P00020000', side: 'buy', price: '0.12', qty: '1', order_id: 'mleg-close-d14d' },
          { id: 'fill-l', activity_type: 'FILL', transaction_time: '2026-05-25T11:55:00Z',
            symbol: 'GME260620P00019000', side: 'sell', price: '0.02', qty: '1', order_id: 'mleg-close-d14d' },
        ]);
      }
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // The legacy guard must have stamped fill_confirmed:true and persisted — this
    // is the key assertion. Without the fix, fill_confirmed stays unset and this
    // expect fails.
    expect(kvSet).toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ fill_confirmed: true }),
    );

    // ── Tick 2: with fill_confirmed:true, D14 must NOT defer ─────────────────
    // Reset mocks and simulate the next cron tick with the now-confirmed trade.
    kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset();
    gradeMock.mockReset(); dataMock.mockReset(); alpacaTradeMock.mockReset();

    const confirmedTrade = { ...trade, fill_confirmed: true };
    kvLrange.mockResolvedValueOnce([confirmedTrade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${confirmedTrade.id}`) return Promise.resolve(confirmedTrade);
      if (k === `grade:${confirmedTrade.id}`) return Promise.resolve({
        trade_id: confirmedTrade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve([
          { id: 'fill-s', activity_type: 'FILL', transaction_time: '2026-05-25T11:55:00Z',
            symbol: 'GME260620P00020000', side: 'buy', price: '0.12', qty: '1', order_id: 'mleg-close-d14d' },
          { id: 'fill-l', activity_type: 'FILL', transaction_time: '2026-05-25T11:55:00Z',
            symbol: 'GME260620P00019000', side: 'sell', price: '0.02', qty: '1', order_id: 'mleg-close-d14d' },
        ]);
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

    const handler2 = (await import('../../api/cron/[job]')).default;
    await handler2(mockReq(), mockRes());

    // With fill_confirmed set, D14 must NOT defer — close MUST be booked this tick.
    // Net debit to close = 0.12 - 0.02 = 0.10. Realized = (0.25 - 0.10) * 100 = $15.
    expect(kvSet).toHaveBeenCalledWith(`trade:${confirmedTrade.id}`, expect.objectContaining({
      closed_at: '2026-05-25T11:55:00Z',
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(15, 2),
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, confirmedTrade.id);
  });
});

// ─── D12: debit-spread close P&L sign correctness ────────────────────────────
//
// detectExternalSpreadClose previously used `(net_credit − netDebitToClose)` for
// ALL spread types. For debit spreads net_credit=0, so the formula collapsed to
// `−netDebitToClose` which ignores the net_debit basis and produces a wrong sign
// on the P&L (a winning debit spread closes as a loss, a losing one as a gain).
//
// Correct math:
//   credit spreads: realized = (net_credit  − netDebitToClose)  × 100 × qty
//   debit  spreads: realized = (netCreditToClose − net_debit)   × 100 × qty
//     where netCreditToClose = longPx − shortPx  (net received to close)
//
// Tests: four spread types × favorable/unfavorable close + credit regression
describe('D12 — debit-spread external-close P&L sign correctness', () => {
  // All expirations far in the future so Path 2/2b never fires
  function makeSpreadTrade(id: string, spreadOverrides: any, tradeOverrides: any = {}): any {
    return {
      id,
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'SPY',
      side: 'STO',
      qty: 1,
      contract_symbol: null,
      strike: null,
      expiration: '2026-12-19',
      contract_type: null,
      filled_avg_price: spreadOverrides.net_debit ?? spreadOverrides.net_credit ?? 0,
      filled_at: '2026-05-24T15:00:00Z',
      fill_confirmed: true,
      alpaca_order_id: `mleg-open-${id}`,
      alpaca_close_order_id: null,
      submitted_at: '2026-05-24T14:55:00Z',
      closed_at: null,
      realized_pnl: null,
      closed_avg_price: null,
      closed_by: null,
      entry_grade: 'B',
      entry_reasoning: 'r',
      tags: [],
      rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
      spread: spreadOverrides,
      ...tradeOverrides,
    };
  }

  function mockBothLegsClosed(shortOcc: string, longOcc: string, shortClosePrice: string, longClosePrice: string) {
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: position not found'));
      }
      if (path.includes('/v2/account/activities')) {
        return Promise.resolve([
          { id: 'fill-short', activity_type: 'FILL', transaction_time: '2026-05-25T15:30:00Z', symbol: shortOcc, side: 'buy', price: shortClosePrice, qty: '1', order_id: 'close-order-1' },
          { id: 'fill-long',  activity_type: 'FILL', transaction_time: '2026-05-25T15:30:00Z', symbol: longOcc,  side: 'sell', price: longClosePrice, qty: '1', order_id: 'close-order-1' },
        ]);
      }
      return Promise.resolve(null);
    });
  }

  // D12a: put_debit closed FAVORABLY (long put appreciated, net received > net_debit)
  // put_debit: BTO higher-strike put, STO lower-strike put.
  //   short_leg = lower strike (e.g. 450), long_leg = higher strike (e.g. 460)
  //   Opened for net_debit = $1.50/share (paid $150 per contract)
  //   Close: buy back short @ $0.20, sell long @ $2.00
  //   netCreditToClose = 2.00 - 0.20 = $1.80  (received more than paid)
  //   realized = (1.80 - 1.50) × 100 × 1 = +$30 (a WIN)
  it('D12a: put_debit closed favorably → positive realized P&L', async () => {
    const spread = {
      spread_type: 'put_debit',
      short_leg: { occ: 'SPY261219P00450000', strike: 450, entry_premium: 0.30, fill_price: 0.30, qty: 1 },
      long_leg:  { occ: 'SPY261219P00460000', strike: 460, entry_premium: 1.80, fill_price: 1.80, qty: 1 },
      expiration: '2026-12-19',
      width: 10,
      net_credit: 0,
      net_debit: 1.50,
      max_loss: 1.50,
      max_profit: 8.50,
    };
    const trade = makeSpreadTrade('T-D12-001', spread);

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    mockBothLegsClosed('SPY261219P00450000', 'SPY261219P00460000', '0.20', '2.00');
    dataMock.mockResolvedValue({ bars: { SPY: [] } });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(30, 2),   // (1.80 - 0.20 - 1.50) × 100 = +30
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12b: put_debit closed UNFAVORABLY (spread decayed, received less than debit)
  //   Close: buy back short @ $0.10, sell long @ $0.50
  //   netCreditToClose = 0.50 - 0.10 = $0.40
  //   realized = (0.40 - 1.50) × 100 × 1 = -$110 (a LOSS, max = -$150)
  it('D12b: put_debit closed unfavorably → negative realized P&L (bounded debit loss)', async () => {
    const spread = {
      spread_type: 'put_debit',
      short_leg: { occ: 'SPY261219P00450000', strike: 450, entry_premium: 0.30, fill_price: 0.30, qty: 1 },
      long_leg:  { occ: 'SPY261219P00460000', strike: 460, entry_premium: 1.80, fill_price: 1.80, qty: 1 },
      expiration: '2026-12-19',
      width: 10,
      net_credit: 0,
      net_debit: 1.50,
      max_loss: 1.50,
      max_profit: 8.50,
    };
    const trade = makeSpreadTrade('T-D12-002', spread);

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    mockBothLegsClosed('SPY261219P00450000', 'SPY261219P00460000', '0.10', '0.50');
    dataMock.mockResolvedValue({ bars: { SPY: [] } });
    gradeMock.mockResolvedValue({ letter: 'F', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(-110, 2),  // (0.40 - 1.50) × 100 = -110
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12c: call_debit closed FAVORABLY
  //   call_debit: BTO lower-strike call, STO higher-strike call.
  //   short_leg = higher strike (e.g. 510), long_leg = lower strike (e.g. 500)
  //   net_debit = $2.00/share. Close: buy back short @ $0.30, sell long @ $3.00
  //   netCreditToClose = 3.00 - 0.30 = $2.70
  //   realized = (2.70 - 2.00) × 100 × 1 = +$70
  it('D12c: call_debit closed favorably → positive realized P&L', async () => {
    const spread = {
      spread_type: 'call_debit',
      short_leg: { occ: 'SPY261219C00510000', strike: 510, entry_premium: 0.80, fill_price: 0.80, qty: 1 },
      long_leg:  { occ: 'SPY261219C00500000', strike: 500, entry_premium: 2.80, fill_price: 2.80, qty: 1 },
      expiration: '2026-12-19',
      width: 10,
      net_credit: 0,
      net_debit: 2.00,
      max_loss: 2.00,
      max_profit: 8.00,
    };
    const trade = makeSpreadTrade('T-D12-003', spread);

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    mockBothLegsClosed('SPY261219C00510000', 'SPY261219C00500000', '0.30', '3.00');
    dataMock.mockResolvedValue({ bars: { SPY: [] } });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(70, 2),   // (2.70 - 2.00) × 100 = +70
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12d: put_credit regression guard — existing math must not change
  //   net_credit = $0.25. Close: buy back short @ $0.10, sell long @ $0.03
  //   netDebitToClose = 0.10 - 0.03 = $0.07
  //   realized = (0.25 - 0.07) × 100 × 1 = +$18
  it('D12d: put_credit external close — realized P&L unchanged (regression guard)', async () => {
    const spread = {
      spread_type: 'put_credit',
      short_leg: { occ: 'SPY261219P00480000', strike: 480, entry_premium: 0.37, fill_price: 0.37, qty: 1 },
      long_leg:  { occ: 'SPY261219P00470000', strike: 470, entry_premium: 0.12, fill_price: 0.12, qty: 1 },
      expiration: '2026-12-19',
      width: 10,
      net_credit: 0.25,
      net_debit: 0,
      max_loss: 9.75,
      max_profit: 0.25,
    };
    const trade = makeSpreadTrade('T-D12-004', spread);

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    mockBothLegsClosed('SPY261219P00480000', 'SPY261219P00470000', '0.10', '0.03');
    dataMock.mockResolvedValue({ bars: { SPY: [] } });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(18, 2),   // (0.25 - 0.07) × 100 = +18
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12e: call_credit regression guard
  //   net_credit = $0.50. Close: buy back short @ $0.20, sell long @ $0.05
  //   netDebitToClose = 0.20 - 0.05 = $0.15
  //   realized = (0.50 - 0.15) × 100 × 1 = +$35
  it('D12e: call_credit external close — realized P&L unchanged (regression guard)', async () => {
    const spread = {
      spread_type: 'call_credit',
      short_leg: { occ: 'SPY261219C00500000', strike: 500, entry_premium: 0.70, fill_price: 0.70, qty: 1 },
      long_leg:  { occ: 'SPY261219C00510000', strike: 510, entry_premium: 0.20, fill_price: 0.20, qty: 1 },
      expiration: '2026-12-19',
      width: 10,
      net_credit: 0.50,
      net_debit: 0,
      max_loss: 9.50,
      max_profit: 0.50,
    };
    const trade = makeSpreadTrade('T-D12-005', spread);

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    mockBothLegsClosed('SPY261219C00500000', 'SPY261219C00510000', '0.20', '0.05');
    dataMock.mockResolvedValue({ bars: { SPY: [] } });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'bot_external',
      realized_pnl: expect.closeTo(35, 2),   // (0.50 - 0.15) × 100 = +35
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });
});

// ─── D12: Path 2b expiry geometry for debit spreads ──────────────────────────
//
// Path 2b (spread-past-expiry detectClose) uses the credit-spread OTM/ITM
// geometry for ALL spread types. For debit spreads the direction is inverted:
//   put_debit max profit → spot < short_leg.strike (both puts ITM)
//   put_debit max loss   → spot >= long_leg.strike (both puts OTM, worthless)
//   call_debit max profit → spot >= short_leg.strike (both calls ITM)
//   call_debit max loss   → spot < long_leg.strike (both calls OTM, worthless)
//
// These tests use future expirations but set fake time PAST them so Path 2b fires.
describe('D12 — Path 2b expiry geometry for debit spreads', () => {
  // For these tests we need fake time AFTER the expiration.
  // The base test file's beforeEach sets 2026-05-25 (before all test expirations).
  // Each it block overrides with its own vi.setSystemTime() call inside.

  function makeDebitSpreadTrade(id: string, spreadType: string, shortLeg: any, longLeg: any, netDebit: number, maxProfit: number): any {
    const width = Math.abs(shortLeg.strike - longLeg.strike);
    return {
      id,
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'SPY',
      side: 'STO',
      qty: 1,
      contract_symbol: null,
      strike: null,
      expiration: '2026-06-20',
      contract_type: null,
      filled_avg_price: netDebit,
      filled_at: '2026-05-24T15:00:00Z',
      fill_confirmed: true,
      alpaca_order_id: `mleg-open-${id}`,
      alpaca_close_order_id: null,
      submitted_at: '2026-05-24T14:55:00Z',
      closed_at: null,
      realized_pnl: null,
      closed_avg_price: null,
      closed_by: null,
      entry_grade: 'B',
      entry_reasoning: 'r',
      tags: [],
      rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
      spread: {
        spread_type: spreadType,
        short_leg: shortLeg,
        long_leg: longLeg,
        expiration: '2026-06-20',
        width,
        net_credit: 0,
        net_debit: netDebit,
        max_loss: netDebit,
        max_profit: maxProfit,
      },
    };
  }

  // D12f: put_debit expired fully ITM (max profit)
  //   put_debit: short_leg = lower strike 450, long_leg = higher strike 460
  //   spot = 440 < short_leg.strike 450 → both puts ITM → max profit
  //   net_debit = $1.50, max_profit = $8.50, width = $10
  //   realized = max_profit × 100 × qty = 8.50 × 100 = +$850
  it('D12f: put_debit expired fully ITM → max profit', async () => {
    const trade = makeDebitSpreadTrade(
      'T-D12-006', 'put_debit',
      { occ: 'SPY260620P00450000', strike: 450, entry_premium: 0.30, fill_price: 0.30, qty: 1 },
      { occ: 'SPY260620P00460000', strike: 460, entry_premium: 1.80, fill_price: 1.80, qty: 1 },
      1.50, 8.50,
    );

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Position check returns 404 for both legs (expired, gone from Alpaca)
    // No activity fills (they expired, not externally closed) → Path 2b fires
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      return Promise.resolve([]);
    });
    // Spot 440 — below short_leg.strike 450 → both puts ITM → max profit
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '440' } });
      return Promise.resolve({ bars: { SPY: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    vi.setSystemTime(new Date('2026-06-21T01:00:00Z')); // after 2026-06-20 expiry

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
      realized_pnl: expect.closeTo(850, 2),  // max_profit × 100 × qty = 8.50 × 100 = +850
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12g: put_debit expired fully OTM (max loss)
  //   spot = 470 >= long_leg.strike 460 → both puts OTM → worthless
  //   realized = -net_debit × 100 × qty = -1.50 × 100 = -$150
  it('D12g: put_debit expired fully OTM → max loss (full debit lost)', async () => {
    const trade = makeDebitSpreadTrade(
      'T-D12-007', 'put_debit',
      { occ: 'SPY260620P00450000', strike: 450, entry_premium: 0.30, fill_price: 0.30, qty: 1 },
      { occ: 'SPY260620P00460000', strike: 460, entry_premium: 1.80, fill_price: 1.80, qty: 1 },
      1.50, 8.50,
    );

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      return Promise.resolve([]);
    });
    // Spot 470 >= long_leg.strike 460 → both OTM → worthless
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '470' } });
      return Promise.resolve({ bars: { SPY: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'F', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    vi.setSystemTime(new Date('2026-06-21T01:00:00Z'));

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
      realized_pnl: expect.closeTo(-150, 2),  // -net_debit × 100 × qty = -1.50 × 100
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12h: call_debit expired fully ITM (max profit)
  //   call_debit: short_leg = higher strike 510, long_leg = lower strike 500
  //   spot = 525 >= short_leg.strike 510 → both calls ITM → max profit
  //   net_debit = $2.00, max_profit = $8.00
  //   realized = max_profit × 100 × qty = 8.00 × 100 = +$800
  it('D12h: call_debit expired fully ITM → max profit', async () => {
    const trade = makeDebitSpreadTrade(
      'T-D12-008', 'call_debit',
      { occ: 'SPY260620C00510000', strike: 510, entry_premium: 0.80, fill_price: 0.80, qty: 1 },
      { occ: 'SPY260620C00500000', strike: 500, entry_premium: 2.80, fill_price: 2.80, qty: 1 },
      2.00, 8.00,
    );

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      return Promise.resolve([]);
    });
    // Spot 525 >= short_leg.strike 510 → both calls ITM → max profit
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '525' } });
      return Promise.resolve({ bars: { SPY: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    vi.setSystemTime(new Date('2026-06-21T01:00:00Z'));

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
      realized_pnl: expect.closeTo(800, 2),  // max_profit × 100 × qty = 8.00 × 100 = +800
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12i: call_debit expired OTM (max loss)
  //   spot = 490 < long_leg.strike 500 → both calls OTM → worthless
  //   realized = -net_debit × 100 × qty = -2.00 × 100 = -$200
  it('D12i: call_debit expired fully OTM → max loss (full debit lost)', async () => {
    const trade = makeDebitSpreadTrade(
      'T-D12-009', 'call_debit',
      { occ: 'SPY260620C00510000', strike: 510, entry_premium: 0.80, fill_price: 0.80, qty: 1 },
      { occ: 'SPY260620C00500000', strike: 500, entry_premium: 2.80, fill_price: 2.80, qty: 1 },
      2.00, 8.00,
    );

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) {
        return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      }
      return Promise.resolve([]);
    });
    // Spot 490 < long_leg.strike 500 → both OTM → worthless
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '490' } });
      return Promise.resolve({ bars: { SPY: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'F', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    vi.setSystemTime(new Date('2026-06-21T01:00:00Z'));

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
      realized_pnl: expect.closeTo(-200, 2),  // -net_debit × 100 × qty = -2.00 × 100
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  // D12j: put_credit expired OTM (regression guard — existing behavior unchanged)
  //   put_credit: short_leg = higher strike 480, long_leg = lower strike 470
  //   spot = 490 >= short_leg.strike 480 → OTM → keep net_credit
  //   net_credit = 0.25, realized = 0.25 × 100 × 1 = +$25
  it('D12j: put_credit expired OTM (spot >= short.strike) → keep net_credit (regression)', async () => {
    const trade: any = {
      id: 'T-D12-010',
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'SPY',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-06-20', contract_type: null,
      filled_avg_price: 0.25, filled_at: '2026-05-24T15:00:00Z', fill_confirmed: true,
      alpaca_order_id: 'mleg-open-d12j', alpaca_close_order_id: null,
      submitted_at: '2026-05-24T14:55:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'SPY260620P00480000', strike: 480, entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg:  { occ: 'SPY260620P00470000', strike: 470, entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        expiration: '2026-06-20',
        width: 10,
        net_credit: 0.25,
        net_debit: 0,
        max_loss: 9.75,
        max_profit: 0.25,
      },
    };

    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error('alpaca trade 404 on /v2/positions/...: not found'));
      return Promise.resolve([]);
    });
    // Spot 490 >= short_leg.strike 480 → OTM → keep full credit
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '490' } });
      return Promise.resolve({ bars: { SPY: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    vi.setSystemTime(new Date('2026-06-21T01:00:00Z'));

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
      realized_pnl: expect.closeTo(25, 2),  // net_credit × 100 = 0.25 × 100
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });
});

// ─── Path 4: external STOCK close ────────────────────────────────────────────
// A dashboard/imported stock trade the user later sold (web UI / bot) never had
// a close order linked. Path 1/2/3 don't cover stocks, so the record sat "open"
// forever and bloated the open index. Path 4 closes the unambiguous case:
// position fully gone + a single closing fill of the exact same qty.
describe('detectClose Path 4 — external stock close', () => {
  function makeStockTrade(overrides: any = {}): any {
    return {
      id: 'T-2026-05-14-100', account: 'manual_paper',
      asset_class: 'stock', symbol: 'F',
      side: 'buy', qty: 100,
      contract_symbol: null, strike: null, expiration: null, contract_type: null,
      filled_avg_price: 11.00, filled_at: '2026-05-14T17:00:00Z',
      alpaca_order_id: 'stk-open-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-14T17:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      // fill_confirmed short-circuits syncFillData so Path 4 is what's tested.
      fill_confirmed: true,
      schema: 1,
      ...overrides,
    };
  }

  it('closes a long stock sold externally (position gone + exact-qty sell fill)', async () => {
    const trade = makeStockTrade();
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error('alpaca trade 404 on /v2/positions/F: not found'));
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'sell-1', activity_type: 'FILL', transaction_time: '2026-05-22T15:00:00Z',
          symbol: 'F', side: 'sell', price: '12.00', qty: '100', order_id: 'sell-order-1' },
      ]);
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { F: [] } });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // (12.00 - 11.00) * 100 shares = +$100
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-22T15:00:00Z',
      closed_avg_price: 12.00,
      realized_pnl: expect.closeTo(100, 2),
      closed_by: 'bot_external',
      alpaca_close_order_id: 'sell-order-1',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('closes a short stock covered externally (sell_short → buy fill)', async () => {
    const trade = makeStockTrade({ id: 'T-2026-05-14-101', side: 'sell_short', filled_avg_price: 12.00, qty: 50 });
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error('alpaca trade 404 on /v2/positions/F: not found'));
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'buy-1', activity_type: 'FILL', transaction_time: '2026-05-22T15:00:00Z',
          symbol: 'F', side: 'buy', price: '10.00', qty: '50', order_id: 'cover-order-1' },
      ]);
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { F: [] } });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    // short: (entry 12.00 - cover 10.00) * 50 = +$100
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      realized_pnl: expect.closeTo(100, 2),
      closed_by: 'bot_external',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('leaves a stock trade open when the position still exists', async () => {
    const trade = makeStockTrade({ id: 'T-2026-05-14-102' });
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: 'F', qty: '100' });
      return Promise.resolve([]);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.anything() }));
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('leaves a stock trade open when the closing fill qty does not match (FIFO ambiguity)', async () => {
    // Bought 100, but the only sell fill is 40 shares → ambiguous partial / multi-lot.
    const trade = makeStockTrade({ id: 'T-2026-05-14-103', qty: 100 });
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.reject(new Error('alpaca trade 404 on /v2/positions/F: not found'));
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'sell-1', activity_type: 'FILL', transaction_time: '2026-05-22T15:00:00Z',
          symbol: 'F', side: 'sell', price: '12.00', qty: '40', order_id: 'sell-order-1' },
      ]);
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.anything() }));
    expect(kvLrem).not.toHaveBeenCalled();
  });
});
