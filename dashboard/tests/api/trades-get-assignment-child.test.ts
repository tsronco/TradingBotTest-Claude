import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const kvGet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: vi.fn() }),
}));

vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: vi.fn(),
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn(),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('trades/get includes assignment_child_id', () => {
  beforeEach(() => { kvGet.mockReset(); });

  it('returns assignment_child_id when set', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-2026-04-01-001') return { id: 'T-2026-04-01-001', schema: 1 };
      if (k === 'grade:T-2026-04-01-001') return null;
      if (k === 'assignment-child:T-2026-04-01-001') return 'T-2026-04-15-001';
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'get', id: 'T-2026-04-01-001' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.assignment_child_id).toBe('T-2026-04-15-001');
  });

  it('returns null when no child exists', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-2026-05-01-001') return { id: 'T-2026-05-01-001', schema: 1 };
      if (k === 'grade:T-2026-05-01-001') return null;
      if (k === 'assignment-child:T-2026-05-01-001') return null;
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'get', id: 'T-2026-05-01-001' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.assignment_child_id).toBeNull();
  });
});
