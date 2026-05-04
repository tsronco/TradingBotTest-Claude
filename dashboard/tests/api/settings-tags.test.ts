// dashboard/tests/api/settings-tags.test.ts
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
  return res;
}

describe('/api/settings/tags', () => {
  it('GET returns the seeded tag list when KV is empty', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('GET', { resource: 'tags' });
    const res = mockRes();
    await handler(req, res);
    const call = (res.json as any).mock.calls[0][0];
    expect(call.tags).toContain('breakout');
    expect(call.tags).toContain('wheel');
  });

  it('POST adds a new tag, lowercased and trimmed', async () => {
    kvGet.mockResolvedValueOnce(['breakout']);
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'tags' }, { tag: '  Morning_Setup  ' });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('tags:list', ['breakout', 'morning_setup']);
  });

  it('POST is idempotent for existing tags', async () => {
    kvGet.mockResolvedValueOnce(['breakout', 'wheel']);
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('POST', { resource: 'tags' }, { tag: 'breakout' });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('DELETE removes a tag', async () => {
    kvGet.mockResolvedValueOnce(['breakout', 'wheel', 'pullback']);
    kvSet.mockResolvedValueOnce('OK');
    const handler = (await import('../../api/settings/[resource]')).default;
    const req = mockReq('DELETE', { resource: 'tags' }, { tag: 'wheel' });
    const res = mockRes();
    await handler(req, res);
    expect(kvSet).toHaveBeenCalledWith('tags:list', ['breakout', 'pullback']);
  });
});
