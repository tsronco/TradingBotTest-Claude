// dashboard/tests/api/trades-refresh.test.ts
//
// Covers the POST /api/trades?action=refresh endpoint. Since the underlying
// loop (runGradeOpenTrades) is already exercised by the cron tests, this
// suite focuses on the action's wiring: auth gate, success shape, and the
// 500-on-failure path.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const runGradeOpenTradesMock = vi.fn();

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({
    get: vi.fn(), set: vi.fn(), incr: vi.fn(), rpush: vi.fn(),
    lrange: vi.fn(), lrem: vi.fn(),
  }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({
  runStubRuleChecks: vi.fn().mockResolvedValue([]),
  runRuleChecks: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: vi.fn(), alpacaTrade: vi.fn(), alpacaTradeMutation: vi.fn(),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: vi.fn(() => true) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: vi.fn() }),
  modeFromQuery: () => 'conservative',
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: vi.fn() }));

// Intercept the cron's runGradeOpenTrades — that function is unit-tested
// elsewhere; here we only care the refresh action forwards its result.
vi.mock('../../api/cron/[job]', () => ({
  runGradeOpenTrades: (...a: any[]) => runGradeOpenTradesMock(...a),
}));

beforeEach(() => {
  runGradeOpenTradesMock.mockReset();
});

function mockReq(query: Record<string, string> = {}): VercelRequest {
  return {
    method: 'POST',
    query: { action: 'refresh', ...query },
    body: {},
    headers: {},
  } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/refresh', () => {
  it('returns 200 with the runGradeOpenTrades result shape on success', async () => {
    runGradeOpenTradesMock.mockResolvedValueOnce({
      graded: 2,
      synced: 1,
      remaining_open: 5,
      assignments_spawned: 0,
      assignments_skipped: 0,
    });
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      drain: false,
      graded: 2,
      synced: 1,
      remaining_open: 5,
      assignments_spawned: 0,
      assignments_skipped: 0,
    });
    // Default mode → no drain options passed.
    expect(runGradeOpenTradesMock).toHaveBeenCalledWith();
  });

  it('mode=drain runs with no sweep cap, zero grade budget, and a time budget', async () => {
    runGradeOpenTradesMock.mockResolvedValueOnce({
      graded: 40, synced: 0, remaining_open: 12, assignments_spawned: 0, assignments_skipped: 0,
    });
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ mode: 'drain' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, drain: true, graded: 40 }));
    expect(runGradeOpenTradesMock).toHaveBeenCalledWith(expect.objectContaining({
      sweepBudget: Number.MAX_SAFE_INTEGER,
      gradeBudget: 0,
      timeBudgetMs: 45_000,
    }));
  });

  it('returns 500 with refresh_failed when runGradeOpenTrades throws', async () => {
    runGradeOpenTradesMock.mockRejectedValueOnce(new Error('alpaca down'));
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'refresh_failed', message: 'alpaca down' }),
    );
  });
});
