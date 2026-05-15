// dashboard/tests/api/trades-preview.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const ruleCheckMock = vi.fn();
const dataMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({ runStubRuleChecks: (...a: any[]) => ruleCheckMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
}));

beforeEach(() => { kvGet.mockReset(); ruleCheckMock.mockReset(); dataMock.mockReset(); });

function mockReq(query: any, body?: any): VercelRequest {
  return { method: 'POST', query, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/preview', () => {
  it('returns exposure, requires_totp=false when below threshold', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'config:totp_thresholds') {
        return Promise.resolve({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
      }
      return Promise.resolve(null);
    });
    ruleCheckMock.mockResolvedValueOnce([]);
    dataMock.mockResolvedValueOnce({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: [],
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.exposure).toBeCloseTo(3214, 2);
    expect(json.requires_totp).toBe(false);
    expect(json.validation_errors).toEqual([]);
  });

  it('returns requires_totp=true when at or above threshold', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'config:totp_thresholds') {
        return Promise.resolve({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
      }
      return Promise.resolve(null);
    });
    ruleCheckMock.mockResolvedValueOnce([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 4.30, bp: 4.20 } } });
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      account: 'conservative_paper', asset_class: 'option', symbol: 'TSLA',
      contract_symbol: 'TSLA260522P00280000', strike: 280, expiration: '2026-05-22',
      contract_type: 'put',
      side: 'STO', qty: 1, order_type: 'limit', limit_price: 4.25,
      tif: 'day', entry_grade: 'A-', entry_reasoning: 'wheel csp',
      tags: ['wheel'],
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.exposure).toBeCloseTo(28000, 2);
    expect(json.requires_totp).toBe(true);
  });

  it('previews a spread payload and returns spread exposure', async () => {
    kvGet.mockImplementation((key: string) => {
      if (key === 'config:totp_thresholds') {
        return Promise.resolve({ conservative_paper: 5000, aggressive_paper: 10000, manual_paper: 2500, live: 1500 });
      }
      return Promise.resolve(null);
    });
    ruleCheckMock.mockResolvedValueOnce([]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      kind: 'spread',
      account: 'manual_paper',
      symbol: 'AAL',
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
      expiration: '2026-05-29',
      qty: 1,
      limit_price: -0.25,
      entry_grade: 'B+',
      entry_reasoning: 'Bullish AAL above $12.50',
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    // width=1, credit=0.25, max_loss=0.75 → exposure = 0.75 * 100 * 1 = 75
    expect(json.exposure).toBeCloseTo(75, 2);
    expect(json.requires_totp).toBe(false);   // 75 < 2500 manual_paper threshold
    expect(Array.isArray(json.rule_warnings)).toBe(true);
    expect(json.draft).toBeDefined();
    expect(json.draft.kind).toBe('spread');
  });

  it('returns validation_errors for missing reasoning', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const req = mockReq({ action: 'preview' }, {
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: '', tags: [],
    });
    const res = mockRes();
    await handler(req, res);
    const json = (res.json as any).mock.calls[0][0];
    expect(json.validation_errors).toContain('entry_reasoning_required');
  });
});
