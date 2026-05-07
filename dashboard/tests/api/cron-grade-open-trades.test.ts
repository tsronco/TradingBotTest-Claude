// dashboard/tests/api/cron-grade-open-trades.test.ts
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

  it('marks unfilled-then-canceled entry orders as closed_by: canceled (skips AI grading)', async () => {
    const trade = {
      id: 'T-2026-05-04-002', account: 'conservative_paper', symbol: 'SNAP', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: null, exposure_at_submit: 22.90,
      alpaca_order_id: 'a-canceled-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-04T13:30Z', filled_at: null, closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'test', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'test', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Two calls now: syncFillData reads the order first (sees canceled, returns
    // trade unchanged since not filled), then detectClose Path 0 reads it again
    // and routes to the canceled close path. Returning the same response both
    // times is fine because the order genuinely hasn't changed between reads.
    alpacaTradeMock.mockResolvedValue({ id: 'a-canceled-1', status: 'canceled', canceled_at: '2026-05-04T13:35Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
    // Trade record updated with closed_by: canceled
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-04T13:35Z',
      closed_avg_price: 0,
      realized_pnl: 0,
      closed_by: 'canceled',
    }));
    // Removed from open index
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
    // AI grading was NOT called
    expect(gradeMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, graded: 1 }));
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
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // syncFillData walks the entry-order chain first (returns a single
    // already-filled order, no replacements), then detectClose fetches the
    // close order separately. Two alpacaTrade calls now, not one.
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/a1')) return Promise.resolve({ id: 'a1', status: 'filled', filled_avg_price: '319.85', filled_at: '2026-05-04T13:30Z' });
      if (path.endsWith('/a2')) return Promise.resolve({ id: 'a2', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' });
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B+', review: 'r', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.any(String), realized_pnl: expect.any(Number), closed_by: 'manual' }));
    expect(kvSet).toHaveBeenCalledWith(`grade:${trade.id}`, expect.objectContaining({ hindsight: expect.objectContaining({ letter: 'B+' }) }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('syncs delayed-fill data (filled_at + filled_avg_price) onto a still-open trade', async () => {
    // Limit order submitted yesterday at $0.08, filled today at $0.05. The
    // trade has no close order yet — it should stay in the open index but
    // gain its entry-price metadata so the timeline / chart / grading can
    // use the correct fill timestamp instead of submitted_at.
    const trade = {
      id: 'T-2026-05-07-001', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      strike: 11.0, expiration: '2026-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'a-delayed-fill', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      return Promise.resolve(null);
    });
    // syncFillData reads the entry order and sees filled. detectClose Path 0
    // skips because filled_at is now set. Path 1 doesn't apply (no close
    // order). Path 2 doesn't apply (option not yet expired).
    alpacaTradeMock.mockResolvedValue({
      id: 'a-delayed-fill', status: 'filled',
      filled_at: '2026-05-07T17:57:29Z', filled_avg_price: '0.05',
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
    // Trade record gets fill data written back
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: '2026-05-07T17:57:29Z',
      filled_avg_price: 0.05,
      closed_at: null,
      closed_by: null,
    }));
    // Stays in the open index — fill alone doesn't close the trade
    expect(kvLrem).not.toHaveBeenCalled();
    // No AI grading until close
    expect(gradeMock).not.toHaveBeenCalled();
  });

  it('syncFillData follows replaced_by chain and backfills modify_history', async () => {
    // User submits at $0.08 (id=A), modifies to $0.07 (id=B replaces A),
    // modifies again to $0.05 (id=C replaces B), C fills. Trade record
    // still points at A with no modify_history. syncFillData must walk
    // A→B→C, find C filled, pin alpaca_order_id to C, write the fill
    // data back, AND reconstruct modify_history from the chain hops.
    const trade = {
      id: 'T-2026-05-07-001', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      strike: 11.0, expiration: '2026-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'order-A', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/order-A')) return Promise.resolve({
        id: 'order-A', status: 'replaced', replaced_by: 'order-B', replaces: null,
        submitted_at: '2026-05-07T17:44Z', limit_price: '0.08', qty: '1',
      });
      if (path.endsWith('/order-B')) return Promise.resolve({
        id: 'order-B', status: 'replaced', replaced_by: 'order-C', replaces: 'order-A',
        submitted_at: '2026-05-07T17:50Z', limit_price: '0.07', qty: '1',
      });
      if (path.endsWith('/order-C')) return Promise.resolve({
        id: 'order-C', status: 'filled', replaces: 'order-B', replaced_by: null,
        filled_at: '2026-05-07T17:57:29Z', filled_avg_price: '0.05',
        submitted_at: '2026-05-07T17:55Z', limit_price: '0.05', qty: '1',
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'order-C',
      filled_at: '2026-05-07T17:57:29Z',
      filled_avg_price: 0.05,
      closed_at: null,
      modify_history: [
        expect.objectContaining({
          ts: '2026-05-07T17:50Z',
          prev_order_id: 'order-A',
          new_order_id: 'order-B',
          limit_price: 0.07,
          source: 'backfill',
        }),
        expect.objectContaining({
          ts: '2026-05-07T17:55Z',
          prev_order_id: 'order-B',
          new_order_id: 'order-C',
          limit_price: 0.05,
          source: 'backfill',
        }),
      ],
    }));
  });

  it('syncFillData pins alpaca_order_id to terminal id even when still pending', async () => {
    // Modified order whose replacement hasn't filled yet — we still want to
    // update the trade's order_id so we don't re-walk the chain every tick.
    const trade = {
      id: 'T-2026-05-07-003', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'order-A', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/order-A')) return Promise.resolve({
        id: 'order-A', status: 'replaced', replaced_by: 'order-B', replaces: null,
      });
      if (path.endsWith('/order-B')) return Promise.resolve({
        id: 'order-B', status: 'new', replaces: 'order-A', replaced_by: null,
        filled_at: null, filled_avg_price: null,
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    // Order id pinned to terminal but no fill data
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'order-B',
      filled_at: null,
      filled_avg_price: null,
    }));
  });

  it('syncFillData no-ops on still-pending entry orders', async () => {
    const trade = {
      id: 'T-2026-05-07-002', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      strike: 11.0, expiration: '2026-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'a-still-pending', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockResolvedValue({ id: 'a-still-pending', status: 'new', filled_at: null, filled_avg_price: null });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    // No write — neither the fill-sync nor the close-detect found anything to do
    expect(kvSet).not.toHaveBeenCalled();
    expect(kvLrem).not.toHaveBeenCalled();
  });
});
