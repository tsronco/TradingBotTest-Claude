// dashboard/tests/api/settings-thresholds.test.ts
//
// Two accounts since the 2026-06-29 sunset: manual (paper) + live (real money).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));

beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); });

function mockReq(method: string, query: any, body?: any): VercelRequest {
  return { method, query, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res as VercelResponse & { status: any; json: any };
}

describe('GET /api/settings/thresholds', () => {
  it('returns thresholds from KV', async () => {
    kvGet.mockResolvedValueOnce({ manual_paper: 2500, live: 1500 });
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: { manual_paper: 2500, live: 1500 },
    });
  });

  it('returns sensible defaults when KV is empty', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: { manual_paper: 2500, live: 1500 },
    });
  });
});

describe('POST /api/settings/thresholds', () => {
  it('writes new thresholds to KV — both keys persisted', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      manual_paper: 3000, live: 2000,
    });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('config:totp_thresholds', {
      manual_paper: 3000, live: 2000,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.thresholds).toMatchObject({ manual_paper: 3000, live: 2000 });
  });

  it('rejects when a key is omitted (Number(undefined) = NaN)', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      manual_paper: 3000, // live omitted
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects negative numbers', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      manual_paper: -1, live: 1500,
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('manual threshold TOTP integration invariant', () => {
  // A manual account with NO custom threshold stored in KV must resolve to the
  // manual DEFAULT (2500), NOT Infinity — the TOTP gate must never be silently
  // disabled.
  it('trades/[action].ts DEFAULT_THRESHOLDS includes manual at 2500 (not Infinity)', async () => {
    const kvGetLocal = vi.fn().mockResolvedValue(null); // KV returns null → use defaults
    vi.doMock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGetLocal, set: vi.fn() }) }));
    vi.doMock('../../api/_lib/auth-guard', () => ({
      requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
    }));
    vi.doMock('../../api/_lib/data-api', () => ({
      alpacaData: vi.fn().mockResolvedValue({ 'AAPL': { latestQuote: { ap: 200, bp: 199 } } }),
      alpacaTrade: vi.fn(),
      alpacaTradeMutation: vi.fn(),
    }));
    vi.doMock('../../api/_lib/rule-check', () => ({
      runStubRuleChecks: vi.fn().mockResolvedValue([]),
      runRuleChecks: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../api/_lib/exposure', () => ({
      computeExposure: vi.fn().mockReturnValue(3000), // > 2500 threshold → requires_totp
    }));

    const tradesHandler = (await import('../../api/trades/[action]')).default;

    const req = {
      method: 'POST',
      query: { action: 'preview' },
      body: {
        account: 'manual_paper',
        asset_class: 'stock',
        symbol: 'AAPL',
        side: 'buy',
        qty: 10,
        order_type: 'limit',
        limit_price: 200,
        tif: 'day',
        entry_grade: 'B',
        entry_reasoning: 'test',
        tags: [],
      },
      headers: {},
    } as unknown as VercelRequest;
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    res.setHeader = vi.fn(() => res);

    await tradesHandler(req, res);

    // exposure (3000) >= manual default threshold (2500) → requires_totp must be true
    const body = res.json.mock.calls[0]?.[0];
    expect(body).toBeDefined();
    expect(body.requires_totp).toBe(true);

    vi.doUnmock('../../api/_lib/kv');
    vi.doUnmock('../../api/_lib/auth-guard');
    vi.doUnmock('../../api/_lib/data-api');
    vi.doUnmock('../../api/_lib/rule-check');
    vi.doUnmock('../../api/_lib/exposure');
  });
});
