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
    kvGet.mockResolvedValueOnce({ conservative_paper: 5000, aggressive_paper: 10000, live: 1500 });
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: { conservative_paper: 5000, aggressive_paper: 10000, live: 1500 },
    });
  });

  it('returns sensible defaults when KV is empty', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'thresholds' });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      thresholds: { conservative_paper: 5000, aggressive_paper: 10000, live: 1500 },
    });
  });
});

describe('POST /api/settings/thresholds', () => {
  it('writes new thresholds to KV', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: 7500, aggressive_paper: 12000, live: 2000,
    });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('config:totp_thresholds', {
      conservative_paper: 7500, aggressive_paper: 12000, live: 2000,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects negative numbers', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'thresholds' }, {
      conservative_paper: -1, aggressive_paper: 10000, live: 1500,
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
