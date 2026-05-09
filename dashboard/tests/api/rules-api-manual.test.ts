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

describe('rules manual CRUD', () => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockClear(); });

  it('POST creates a rule with generated id, source=manual, timestamps', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'manual' },
      body: {
        title: 'No earnings week',
        body: 'never trade through earnings',
        severity: 'block',
        triggers: [{ type: 'earnings_within_days', value: 7 }],
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toMatch(/^r-/);
    expect(written[0].source).toBe('manual');
    expect(written[0].title).toBe('No earnings week');
    expect(written[0].severity).toBe('block');
    expect(written[0].created_at).toBeDefined();
    expect(written[0].updated_at).toBe(written[0].created_at);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.rule.id).toBe(written[0].id);
  });

  it('POST appends to existing list (does not replace)', async () => {
    const existing = {
      id: 'r-old', title: 'old', body: 'b', severity: 'warn', triggers: [],
      source: 'manual', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    };
    kvGet.mockResolvedValueOnce([existing]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'manual' },
      body: { title: 'new', body: 'b2', severity: 'warn', triggers: [] },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(2);
    expect(written[0].id).toBe('r-old');
  });

  it('POST rejects payload missing required fields with 400', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const cases = [
      { body: 'b', severity: 'warn', triggers: [] },              // no title
      { title: 't', severity: 'warn', triggers: [] },             // no body
      { title: 't', body: 'b', triggers: [] },                    // no severity
      { title: 't', body: 'b', severity: 'invalid', triggers: [] }, // bad severity
      { title: 't', body: 'b', severity: 'warn' },                // no triggers
      { title: 't', body: 'b', severity: 'warn', triggers: 'not-array' }, // bad triggers
    ];
    for (const body of cases) {
      const req: any = { method: 'POST', query: { resource: 'manual' }, body };
      const res = mkRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('POST rejects invalid trigger structure with 400', async () => {
    kvGet.mockResolvedValue([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'manual' },
      body: { title: 't', body: 'b', severity: 'warn', triggers: [{ type: 'bogus' }] },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('PATCH updates an existing rule and bumps updated_at', async () => {
    const existing = {
      id: 'r-1', title: 'old', body: 'b', severity: 'warn', triggers: [],
      source: 'manual', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    };
    kvGet.mockResolvedValueOnce([existing]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'PATCH',
      query: { resource: 'manual' },
      body: { id: 'r-1', patch: { title: 'new title', severity: 'block' } },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const written = kvSet.mock.calls[0][1];
    expect(written[0].id).toBe('r-1');                       // id never overwritten
    expect(written[0].title).toBe('new title');
    expect(written[0].severity).toBe('block');
    expect(written[0].created_at).toBe('2026-04-01T00:00:00Z'); // preserved
    expect(written[0].updated_at).not.toBe('2026-04-01T00:00:00Z');
  });

  it('PATCH 404s when id not found', async () => {
    kvGet.mockResolvedValueOnce([{ id: 'r-1' }]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'PATCH',
      query: { resource: 'manual' },
      body: { id: 'r-missing', patch: { title: 'x' } },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('PATCH rejects invalid trigger in patch with 400', async () => {
    const existing = {
      id: 'r-1', title: 't', body: 'b', severity: 'warn', triggers: [],
      source: 'manual', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    };
    kvGet.mockResolvedValueOnce([existing]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'PATCH',
      query: { resource: 'manual' },
      body: { id: 'r-1', patch: { triggers: [{ type: 'bogus' }] } },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('DELETE removes a rule by id', async () => {
    const existing = [
      { id: 'r-1', title: 'a', source: 'manual' },
      { id: 'r-2', title: 'b', source: 'manual' },
    ];
    kvGet.mockResolvedValueOnce(existing);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'DELETE',
      query: { resource: 'manual' },
      body: { id: 'r-1' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const written = kvSet.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('r-2');
    const body = (res.json as any).mock.calls[0][0];
    expect(body.removed).toBe('r-1');
  });

  it('DELETE is idempotent (no-op when id missing)', async () => {
    kvGet.mockResolvedValueOnce([{ id: 'r-1' }]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'DELETE',
      query: { resource: 'manual' },
      body: { id: 'r-not-there' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    // Still wrote the (unchanged) list — that's fine. The test should be permissive.
  });

  it('returns 405 for unsupported method', async () => {
    kvGet.mockResolvedValueOnce([]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'PUT', query: { resource: 'manual' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
