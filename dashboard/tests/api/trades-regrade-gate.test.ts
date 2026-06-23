// dashboard/tests/api/trades-regrade-gate.test.ts
//
// Tests that the regrade endpoint enforces the isGradeable gate:
//   - Returns 403 for non-gradeable (conservative) trades
//   - Allows regrade for manual_paper (gradeable) trades

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
const gradeTradeMock = vi.fn();
const dataMock = vi.fn();

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({
    get: kvGet,
    set: kvSet,
    incr: vi.fn(),
    lrange: vi.fn().mockResolvedValue([]),
    lrem: vi.fn().mockResolvedValue(1),
    rpush: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
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
  alpacaData: (...a: any[]) => dataMock(...a),
  alpacaTrade: vi.fn(),
  alpacaTradeMutation: vi.fn(),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: vi.fn(() => true) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: vi.fn() }),
  modeFromQuery: () => 'conservative',
}));
vi.mock('../../api/_lib/grading', () => ({
  gradeTrade: (...a: any[]) => gradeTradeMock(...a),
}));
vi.mock('../../api/cron/[job]', () => ({
  runGradeOpenTrades: vi.fn().mockResolvedValue({
    graded: 0, synced: 0, remaining_open: 0, ai_graded: 0, grade_queue_remaining: 0,
    assignments_spawned: 0, assignments_skipped: 0, auto_imported: {},
  }),
}));

function mockReq(body: Record<string, string>): VercelRequest {
  return {
    method: 'POST',
    query: { action: 'regrade' },
    body,
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

function makeClosedTrade(account: string): any {
  return {
    id: 'T-x',
    account,
    asset_class: 'stock',
    symbol: 'F',
    side: 'buy',
    qty: 10,
    filled_avg_price: 12,
    filled_at: '2026-06-20T18:00:00Z',
    submitted_at: '2026-06-20T17:00:00Z',
    alpaca_order_id: 'order-x',
    closed_at: '2026-06-21T18:00:00Z',
    closed_avg_price: 13,
    realized_pnl: 10,
    closed_by: 'manual',
    tags: [],
    entry_grade: 'B',
    entry_reasoning: 'r',
    schema: 1,
  };
}

const gradeRecord = {
  trade_id: 'T-x',
  entry: { letter: 'B', reasoning: 'r', ts: '' },
  hindsight: null,
  history: [],
};

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockClear();
  gradeTradeMock.mockReset();
  dataMock.mockReset();
  dataMock.mockResolvedValue({ bars: {} });
  gradeTradeMock.mockResolvedValue({
    letter: 'C',
    review: 'ok',
    calibration: 'matched',
    tendencies_hit: [],
    model: 'm',
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 },
    ts: '2026-06-21T18:00:00Z',
  });
});

describe('regrade grading gate', () => {
  it('refuses to regrade a non-gradeable (conservative) trade with 403', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-x') return makeClosedTrade('conservative_paper');
      if (k === 'grade:T-x') return { ...gradeRecord };
      return null;
    });

    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ id: 'T-x' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'grading_disabled_for_account' }),
    );
    // Should not have called gradeTrade or written to KV
    expect(gradeTradeMock).not.toHaveBeenCalled();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('allows regrade on a manual_paper trade', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-x') return makeClosedTrade('manual_paper');
      if (k === 'grade:T-x') return { ...gradeRecord };
      return null;
    });

    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ id: 'T-x' }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(gradeTradeMock).toHaveBeenCalledTimes(1);
  });
});
