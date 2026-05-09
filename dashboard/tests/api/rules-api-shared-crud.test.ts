import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
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

const PATTERN_BODY = {
  name: 'Wheel TSLA',
  environment: 'high IV post-earnings',
  variables: ['IV rank > 50'],
  legs: ['STO put -10% OTM 14-28 DTE'],
  rules: ['exit at 50% profit', 'roll if breached'],
  win_rate: 0.65,
};

const CHEATSHEET_BODY = {
  title: 'Greeks 101',
  body: 'delta = directional exposure; theta = time decay; vega = IV sensitivity',
};

const GOAL_BODY = {
  body: 'Sell 1 wheel contract per week consistently',
  target: '52 contracts/year',
  due: '2026-12-31',
};

describe.each([
  { resource: 'patterns', goodBody: PATTERN_BODY,    idPrefix: 'p' as const },
  { resource: 'cheatsheets', goodBody: CHEATSHEET_BODY, idPrefix: 'c' as const },
  { resource: 'goals', goodBody: GOAL_BODY,          idPrefix: 'g' as const },
])('rules $resource CRUD', ({ resource, goodBody, idPrefix }) => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockClear(); });

  it('GET returns empty array when KV has no entry', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.items).toEqual([]);
  });

  it('GET returns stored items', async () => {
    kvGet.mockResolvedValueOnce([{ id: 'x-1', name: 'foo' }]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.items).toHaveLength(1);
  });

  it('POST creates item with prefixed id + timestamps', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'POST', query: { resource }, body: goodBody };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toMatch(new RegExp(`^${idPrefix}-`));
    expect(written[0].created_at).toBeDefined();
    expect(written[0].updated_at).toBe(written[0].created_at);
  });

  it('POST rejects body that fails validation with 400', async () => {
    kvGet.mockResolvedValue([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'POST', query: { resource }, body: {} };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('PATCH updates an existing item', async () => {
    const existing = {
      ...goodBody,
      id: `${idPrefix}-1`,
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    };
    kvGet.mockResolvedValueOnce([existing]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const patch: Record<string, unknown> =
      resource === 'patterns'    ? { environment: 'low IV trending' }
    : resource === 'cheatsheets' ? { body: 'updated body' }
    : /* goals */                  { body: 'updated goal' };
    const req: any = {
      method: 'PATCH',
      query: { resource },
      body: { id: `${idPrefix}-1`, patch },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const written = kvSet.mock.calls[0][1];
    expect(written[0].id).toBe(`${idPrefix}-1`);
    expect(written[0].created_at).toBe('2026-04-01T00:00:00Z');
    expect(written[0].updated_at).not.toBe('2026-04-01T00:00:00Z');
  });

  it('PATCH 404s when id not found', async () => {
    kvGet.mockResolvedValueOnce([{ id: `${idPrefix}-1`, ...goodBody }]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'PATCH',
      query: { resource },
      body: { id: `${idPrefix}-missing`, patch: { name: 'x' } },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('DELETE removes item by id', async () => {
    kvGet.mockResolvedValueOnce([
      { id: `${idPrefix}-1`, ...goodBody },
      { id: `${idPrefix}-2`, ...goodBody },
    ]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'DELETE',
      query: { resource },
      body: { id: `${idPrefix}-1` },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe(`${idPrefix}-2`);
  });

  it('returns 405 for unsupported method', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'PUT', query: { resource } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
