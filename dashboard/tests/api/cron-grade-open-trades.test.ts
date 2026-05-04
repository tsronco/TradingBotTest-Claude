// dashboard/tests/api/cron-grade-open-trades.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrange = vi.fn();
const kvLrem = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
const alpacaGetOrder = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem }) }));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({ alpacaData: (...a: any[]) => dataMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ getOrder: (...a: any[]) => alpacaGetOrder(...a), getPositions: vi.fn() }),
  modeFromQuery: () => 'conservative',
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset();
  gradeMock.mockReset(); dataMock.mockReset(); alpacaGetOrder.mockReset();
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
    alpacaGetOrder
      .mockResolvedValueOnce({ id: 'a2', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' });
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
});
