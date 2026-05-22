// dashboard/tests/api/settings-display-name.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet }) }));
const requireAuth = vi.fn(() => ({ logged_in_at: 0, last_active: 0 }));
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth }));

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
  requireAuth.mockReset();
  requireAuth.mockReturnValue({ logged_in_at: 0, last_active: 0 });
});

function mockReq(method: string, query: any, body?: any): VercelRequest {
  return { method, query, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('/api/settings/display-name', () => {
  it('GET returns "trader" default when KV is empty (no auth required)', async () => {
    kvGet.mockResolvedValueOnce(null);
    // requireAuth must NOT be called for GET — display name is public.
    requireAuth.mockImplementation(() => {
      throw new Error('requireAuth should not be called for public GET');
    });
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'display-name' });
    const res = mockRes();
    await handler(req, res);
    expect((res.json as any).mock.calls[0][0]).toEqual({ display_name: 'trader' });
  });

  it('GET returns the stored display name', async () => {
    kvGet.mockResolvedValueOnce('Pat');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'display-name' });
    const res = mockRes();
    await handler(req, res);
    expect((res.json as any).mock.calls[0][0]).toEqual({ display_name: 'Pat' });
  });

  it('POST saves a valid display name and requires auth', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'display-name' }, { display_name: 'Alex' });
    const res = mockRes();
    await handler(req, res);
    expect(requireAuth).toHaveBeenCalled();
    expect(kvSet).toHaveBeenCalledWith('config:display_name', 'Alex');
    expect((res.json as any).mock.calls[0][0]).toEqual({ ok: true, display_name: 'Alex' });
  });

  it('POST rejects an empty display name', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'display-name' }, { display_name: '   ' });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as any).mock.calls[0][0]).toEqual({ error: 'invalid_display_name' });
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('POST rejects a name starting with a non-letter', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'display-name' }, { display_name: '123abc' });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('POST rejects a name longer than 24 chars', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'display-name' }, { display_name: 'A'.repeat(25) });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('accepts spaces, underscores, hyphens, digits', async () => {
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'display-name' }, { display_name: 'Trader_42-A B' });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(kvSet).toHaveBeenCalledWith('config:display_name', 'Trader_42-A B');
  });

  it('returns 405 on unsupported methods', async () => {
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('DELETE', { resource: 'display-name' });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
