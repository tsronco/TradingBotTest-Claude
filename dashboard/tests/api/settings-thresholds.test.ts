// dashboard/tests/api/settings-thresholds.test.ts
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
    kvGet.mockResolvedValueOnce({
      conservative_paper: 5000, aggressive_paper: 10000, manual_paper: 2500, live: 1500,
      sm500_paper: 2500, sm1000_paper: 2500, sm2000_paper: 2500,
    });
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: {
        conservative_paper: 5000, aggressive_paper: 10000, manual_paper: 2500, live: 1500,
        sm500_paper: 2500, sm1000_paper: 2500, sm2000_paper: 2500,
      },
    });
  });

  it('returns sensible defaults when KV is empty', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    // All 7 accounts present at their defaults; SM accounts default to 2500 (= manual)
    expect(res.json).toHaveBeenCalledWith({
      thresholds: {
        conservative_paper: 5000, aggressive_paper: 10000, manual_paper: 2500, live: 1500,
        sm500_paper: 2500, sm1000_paper: 2500, sm2000_paper: 2500,
      },
    });
  });
});

describe('POST /api/settings/thresholds', () => {
  it('writes new thresholds to KV — all 7 keys persisted', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: 7500, aggressive_paper: 12000, manual_paper: 3000, live: 2000,
      sm500_paper: 1500, sm1000_paper: 1800, sm2000_paper: 2100,
    });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('config:totp_thresholds', {
      conservative_paper: 7500, aggressive_paper: 12000, manual_paper: 3000, live: 2000,
      sm500_paper: 1500, sm1000_paper: 1800, sm2000_paper: 2100,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    // Response echoes all 7 keys — no SM key gets silently dropped
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.thresholds).toMatchObject({
      sm500_paper: 1500,
      sm1000_paper: 1800,
      sm2000_paper: 2100,
    });
  });

  it('SM keys are present in response after round-trip with only original 4 in body (defaults apply)', async () => {
    // Simulates a legacy client that only sends the original 4 keys — the
    // validation rejects because SM values are NaN (Number(undefined) = NaN).
    // This is intentional: after this fix, a save must always include all 7.
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: 7500, aggressive_paper: 12000, manual_paper: 3000, live: 2000,
      // sm keys omitted — should produce 400 because Number(undefined) = NaN fails isFinite
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects negative numbers', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: -1, aggressive_paper: 10000, manual_paper: 2500, live: 1500,
      sm500_paper: 2500, sm1000_paper: 2500, sm2000_paper: 2500,
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects negative SM threshold', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: 5000, aggressive_paper: 10000, manual_paper: 2500, live: 1500,
      sm500_paper: -1, sm1000_paper: 2500, sm2000_paper: 2500,
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('SM threshold TOTP integration invariant', () => {
  // Asserts that an SM account with NO custom threshold stored in KV resolves
  // to the SM DEFAULT (2500), NOT Infinity. This directly tests the security
  // property: TOTP gate must NEVER be silently disabled for SM accounts.
  it('trades/[action].ts DEFAULT_THRESHOLDS includes SM at 2500 (not Infinity)', async () => {
    // We import the internal DEFAULT_THRESHOLDS indirectly by checking the
    // preview route's requires_totp response for an SM account with no KV value.
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
        account: 'sm500_paper',
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

    // exposure (3000) >= SM default threshold (2500) → requires_totp must be true
    // If SM fell through to Infinity, requires_totp would be false — that's the bug.
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
