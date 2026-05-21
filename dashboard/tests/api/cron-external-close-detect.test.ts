// dashboard/tests/api/cron-external-close-detect.test.ts
//
// Path 3 of detectClose — external bot-close detection.
// Covers the NVTS case (bot bought-to-close a user-opened CSP via its own
// Alpaca client, no alpaca_close_order_id on the trade record) and a
// spread variant where both legs are closed externally.
import { describe, expect, it, vi, beforeEach } from 'vitest';
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

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset();
  gradeMock.mockReset(); dataMock.mockReset(); alpacaTradeMock.mockReset();
  process.env.CRON_TOKEN = 'cron-token';
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

    // Trade stays open — no kvSet, no kvLrem
    expect(kvSet).not.toHaveBeenCalled();
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
    expect(kvSet).not.toHaveBeenCalled();
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
    expect(kvSet).not.toHaveBeenCalled();
    expect(kvLrem).not.toHaveBeenCalled();
  });
});
