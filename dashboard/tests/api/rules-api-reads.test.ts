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

describe('rules tendencies handler', () => {
  beforeEach(() => { kvGet.mockReset(); });

  it('GET returns empty array when KV has nothing', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'tendencies' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ tendencies: [] });
  });

  it('GET returns stored tendencies', async () => {
    kvGet.mockResolvedValueOnce([
      { id: 'te-1', matcher: 'cc_below_cost_basis', finding: 'three CCs below basis', evidence_trade_ids: [], detected_at: '...' },
    ]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'tendencies' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.tendencies).toHaveLength(1);
    expect(body.tendencies[0].matcher).toBe('cc_below_cost_basis');
  });

  it('returns 405 for non-GET methods', async () => {
    const handler = (await import('../../api/rules/[resource]')).default;
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const req: any = { method, query: { resource: 'tendencies' } };
      const res = mkRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    }
  });
});

describe('rules proposals handler (GET)', () => {
  beforeEach(() => { kvGet.mockReset(); });

  it('GET returns open proposals', async () => {
    kvGet.mockResolvedValueOnce([
      { id: 'p-1', status: 'open', proposed_at: '2026-05-01T00:00:00Z' },
    ]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'proposals' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].status).toBe('open');
  });

  it('GET filters dismissed/approved older than 30 days', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86400000).toISOString();
    const recent = new Date(now.getTime() - 5 * 86400000).toISOString();
    kvGet.mockResolvedValueOnce([
      { id: 'p-old',      status: 'dismissed', resolved_at: old,    proposed_at: old },
      { id: 'p-recent',   status: 'dismissed', resolved_at: recent, proposed_at: recent },
      { id: 'p-approved', status: 'approved',  resolved_at: recent, proposed_at: recent },
      { id: 'p-open',     status: 'open',                            proposed_at: recent },
    ]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'proposals' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    const ids = body.proposals.map((p: any) => p.id).sort();
    expect(ids).toEqual(['p-approved', 'p-open', 'p-recent']);
  });

  it('GET returns empty array when KV has nothing', async () => {
    kvGet.mockResolvedValueOnce(null);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'proposals' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ proposals: [] });
  });

  it('returns 405 for PATCH/DELETE/PUT', async () => {
    const handler = (await import('../../api/rules/[resource]')).default;
    for (const method of ['PATCH', 'DELETE', 'PUT'] as const) {
      const req: any = { method, query: { resource: 'proposals' } };
      const res = mkRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    }
  });
});

describe('rules bot handler', () => {
  beforeEach(() => { kvGet.mockReset(); });

  it('GET returns both modes from bot:rules:* keys', async () => {
    const manPayload  = { mode: 'manual', wheel: { otm_pct: 0.10 }, pushed_at: '...' };
    const livePayload = { mode: 'live',   wheel: { otm_pct: 0.10 }, pushed_at: '...' };
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'bot:rules:manual') return manPayload;
      if (k === 'bot:rules:live')   return livePayload;
      return null;
    });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'bot' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.manual.wheel.otm_pct).toBe(0.10);
    expect(body.live.wheel.otm_pct).toBe(0.10);
  });

  it('GET returns nulls when no modes have pushed', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = { method: 'GET', query: { resource: 'bot' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body).toEqual({ manual: null, live: null });
  });

  it('returns 405 for non-GET', async () => {
    const handler = (await import('../../api/rules/[resource]')).default;
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const req: any = { method, query: { resource: 'bot' } };
      const res = mkRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    }
  });
});
