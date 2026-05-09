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

const seedProposal = {
  id: 'p-1',
  matcher: 'cc_below_cost_basis',
  proposed_rule: {
    title: 'No CC below cost',
    body: 'do not sell covered calls below cost basis',
    severity: 'block',
    triggers: [{ type: 'strike_below_cost_basis' }],
  },
  reasoning: 'You did this 3 times and lost on 2.',
  evidence_trade_ids: ['T-1', 'T-2', 'T-3'],
  status: 'open',
  proposed_at: '2026-05-04T22:00:00Z',
} as const;

describe('proposals POST actions', () => {
  beforeEach(() => { kvGet.mockReset(); kvSet.mockClear(); });

  it('approve creates manual rule + marks proposal approved', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [seedProposal];
      if (k === 'rules:manual') return [];
      return null;
    });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-1' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);

    const setCalls = kvSet.mock.calls;
    const proposalsWritten = setCalls.find((c: any) => c[0] === 'rules:proposals')?.[1];
    expect(proposalsWritten[0].status).toBe('approved');
    expect(proposalsWritten[0].resolved_at).toBeDefined();
    const manualWritten = setCalls.find((c: any) => c[0] === 'rules:manual')?.[1];
    expect(manualWritten).toHaveLength(1);
    expect(manualWritten[0].title).toBe('No CC below cost');
    expect(manualWritten[0].severity).toBe('block');
    expect(manualWritten[0].source).toBe('tendency');
    expect(manualWritten[0].id).toMatch(/^r-/);
  });

  it('dismiss marks status=dismissed without creating a rule', async () => {
    kvGet.mockResolvedValueOnce([seedProposal]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'dismiss', proposal_id: 'p-1' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const proposalsWritten = kvSet.mock.calls.find((c: any) => c[0] === 'rules:proposals')?.[1];
    expect(proposalsWritten[0].status).toBe('dismissed');
    expect(proposalsWritten[0].resolved_at).toBeDefined();
    expect(kvSet.mock.calls.find((c: any) => c[0] === 'rules:manual')).toBeUndefined();
  });

  it('edit-and-approve uses edits over proposed_rule', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [seedProposal];
      if (k === 'rules:manual') return [];
      return null;
    });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: {
        action: 'edit-and-approve',
        proposal_id: 'p-1',
        edits: { title: 'Edited title', severity: 'warn' },
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const manualWritten = kvSet.mock.calls.find((c: any) => c[0] === 'rules:manual')?.[1];
    expect(manualWritten[0].title).toBe('Edited title');
    expect(manualWritten[0].severity).toBe('warn');
    expect(manualWritten[0].body).toBe(seedProposal.proposed_rule.body);
    expect(manualWritten[0].triggers).toEqual(seedProposal.proposed_rule.triggers);
  });

  it('approve on demote proposal patches target rule severity to warn', async () => {
    const demoteProposal = {
      ...seedProposal,
      id: 'p-2',
      demote_target_rule_id: 'r-existing',
      proposed_rule: { title: 'Demote: No CC', body: 'demote', severity: 'warn', triggers: [] },
    };
    const targetRule = {
      id: 'r-existing', title: 'No CC', body: 'b', severity: 'block', triggers: [],
      source: 'manual', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    };
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [demoteProposal];
      if (k === 'rules:manual') return [targetRule];
      return null;
    });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-2' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const manualWritten = kvSet.mock.calls.find((c: any) => c[0] === 'rules:manual')?.[1];
    expect(manualWritten).toHaveLength(1);
    expect(manualWritten[0].id).toBe('r-existing');
    expect(manualWritten[0].severity).toBe('warn');                    // demoted
    expect(manualWritten[0].created_at).toBe('2026-04-01T00:00:00Z'); // preserved
    expect(manualWritten[0].updated_at).not.toBe('2026-04-01T00:00:00Z');
  });

  it('approve on demote proposal 404s if target rule is missing', async () => {
    const demoteProposal = {
      ...seedProposal,
      id: 'p-2',
      demote_target_rule_id: 'r-gone',
    };
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [demoteProposal];
      if (k === 'rules:manual') return [];
      return null;
    });
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-2' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('edit-and-approve refuses to edit demote proposals (400)', async () => {
    const demoteProposal = {
      ...seedProposal,
      id: 'p-2',
      demote_target_rule_id: 'r-existing',
    };
    kvGet.mockResolvedValueOnce([demoteProposal]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'edit-and-approve', proposal_id: 'p-2', edits: { title: 'x' } },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 404 when proposal_id does not exist', async () => {
    kvGet.mockResolvedValueOnce([seedProposal]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-missing' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 409 when proposal is already resolved', async () => {
    const resolved = { ...seedProposal, status: 'approved', resolved_at: '...' };
    kvGet.mockResolvedValueOnce([resolved]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'approve', proposal_id: 'p-1' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 400 for unknown action', async () => {
    kvGet.mockResolvedValueOnce([seedProposal]);
    const handler = (await import('../../api/rules/[resource]')).default;
    const req: any = {
      method: 'POST',
      query: { resource: 'proposals' },
      body: { action: 'bogus', proposal_id: 'p-1' },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
