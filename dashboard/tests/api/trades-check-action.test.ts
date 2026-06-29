import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const runRuleChecks = vi.fn();
vi.mock('../../api/_lib/rule-check', () => ({
  runRuleChecks,
  runStubRuleChecks: runRuleChecks,
}));

const alpacaTrade = vi.fn();
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade,
  alpacaData: vi.fn().mockResolvedValue({}),
  alpacaTradeMutation: vi.fn(),
}));

const kvGet = vi.fn();
const kvSet = vi.fn();
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

describe('trades/check action', () => {
  beforeEach(() => {
    runRuleChecks.mockReset();
    alpacaTrade.mockReset();
    kvGet.mockReset();
    kvSet.mockClear();
  });

  it('forwards draft + positions to runRuleChecks and returns violations', async () => {
    alpacaTrade.mockResolvedValueOnce([
      { symbol: 'F', qty: '100', avg_entry_price: '12.00' },
      { symbol: 'TSLA', qty: '10', avg_entry_price: '200.00' },
    ]);
    runRuleChecks.mockResolvedValueOnce([
      { rule: 'r-1', severity: 'block', message: 'No earnings week' },
    ]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST',
      query: { action: 'check' },
      body: {
        asset_class: 'option',
        symbol: 'TSLA',
        side: 'STO',
        qty: 1,
        account: 'manual_paper',
        option_type: 'put',
        strike: 200,
        expiration: '2026-05-30',
        tags: ['wheel'],
      },
    };
    const res = mkRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].severity).toBe('block');

    // Confirm runRuleChecks was called with draft + parsed positions
    expect(runRuleChecks).toHaveBeenCalledTimes(1);
    const [draft, ctx] = runRuleChecks.mock.calls[0];
    expect(draft.symbol).toBe('TSLA');
    expect(draft.account).toBe('manual_paper');
    expect(draft.expiration).toBe('2026-05-30');
    expect(ctx.positions).toHaveLength(2);
    expect(ctx.positions[0]).toEqual({ symbol: 'F', qty: 100, avg_entry_price: 12 });

    // Confirm Alpaca was queried for positions on the right account
    expect(alpacaTrade).toHaveBeenCalledWith(expect.stringMatching(/manual/), '/v2/positions');
  });

  it('uses the manual mode for manual_paper account', async () => {
    alpacaTrade.mockResolvedValueOnce([]);
    runRuleChecks.mockResolvedValueOnce([]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST',
      query: { action: 'check' },
      body: {
        asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100,
        account: 'manual_paper',
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(alpacaTrade).toHaveBeenCalledWith('manual', '/v2/positions');
  });

  it('passes empty positions array when Alpaca call fails', async () => {
    alpacaTrade.mockRejectedValueOnce(new Error('alpaca down'));
    runRuleChecks.mockResolvedValueOnce([]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST',
      query: { action: 'check' },
      body: {
        asset_class: 'stock', symbol: 'F', side: 'buy', qty: 100,
        account: 'manual_paper',
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const [, ctx] = runRuleChecks.mock.calls[0];
    expect(ctx.positions).toEqual([]);
  });

  it('rejects non-POST methods with 405', async () => {
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'check' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('rejects when not authenticated with 401', async () => {
    requireAuth.mockImplementationOnce((_req: any, res: any) => {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'check' }, body: {},
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
