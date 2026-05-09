import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth-guard so we can control session state per test
const requireAuth = vi.fn();
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet }),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('api/rules/[resource] dispatch', () => {
  beforeEach(() => {
    requireAuth.mockReset();
    kvGet.mockReset();
    kvSet.mockClear();
  });

  it('returns 401 when auth-guard rejects', async () => {
    requireAuth.mockImplementation((_req: any, res: any) => {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'manual' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 for unknown resource (when authed)', async () => {
    requireAuth.mockReturnValue({ user: 'tim' });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'unknown' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('GET manual returns empty array when KV has no entry', async () => {
    requireAuth.mockReturnValue({ user: 'tim' });
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'manual' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ rules: [] });
  });

  it('GET manual returns stored array when KV has entries', async () => {
    requireAuth.mockReturnValue({ user: 'tim' });
    kvGet.mockResolvedValueOnce([
      { id: 'r-1', title: 'No earnings week', severity: 'block' },
    ]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'manual' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].id).toBe('r-1');
  });

});
