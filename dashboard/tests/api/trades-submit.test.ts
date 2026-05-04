// dashboard/tests/api/trades-submit.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvIncr = vi.fn();
const kvLpush = vi.fn();
const kvRpush = vi.fn();
const ruleCheckMock = vi.fn();
const dataMock = vi.fn();
const verifyTotpMock = vi.fn();
const alpacaCreateOrder = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, incr: kvIncr, lpush: kvLpush, rpush: kvRpush, sadd: vi.fn(), lrange: vi.fn(), lrem: vi.fn() }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({ runStubRuleChecks: (...a: any[]) => ruleCheckMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({ alpacaData: (...a: any[]) => dataMock(...a) }));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...a: any[]) => verifyTotpMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: (...a: any[]) => alpacaCreateOrder(...a) }),
  modeFromQuery: () => 'conservative',
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvIncr.mockReset(); kvLpush.mockReset(); kvRpush.mockReset();
  ruleCheckMock.mockReset(); dataMock.mockReset(); verifyTotpMock.mockReset(); alpacaCreateOrder.mockReset();
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
});

function mockReq(body?: any): VercelRequest {
  return { method: 'POST', query: { action: 'submit' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/submit', () => {
  it('rejects when validation fails', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: '', tags: [],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when TOTP required but missing/invalid', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 1000, aggressive_paper: 1000, live: 1500 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    verifyTotpMock.mockReturnValue(false);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: [],
      totp_code: 'wrong',
    }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('places Alpaca order, writes trade+grade records, indexes', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    kvIncr.mockResolvedValue(1);
    alpacaCreateOrder.mockResolvedValue({ id: 'alp-abc-123', submitted_at: '2026-05-04T13:30:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: ['breakout'],
    }), res);
    expect(alpacaCreateOrder).toHaveBeenCalled();
    const json = (res.json as any).mock.calls[0][0];
    expect(json.id).toMatch(/^T-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(json.alpaca_order_id).toBe('alp-abc-123');
    expect(kvSet).toHaveBeenCalledWith(expect.stringMatching(/^trade:T-/), expect.any(Object));
    expect(kvSet).toHaveBeenCalledWith(expect.stringMatching(/^grade:T-/), expect.any(Object));
    expect(kvRpush).toHaveBeenCalledWith('trades:index:open', expect.stringMatching(/^T-/));
  });
});
