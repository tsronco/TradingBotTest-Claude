import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: vi.fn(), set: vi.fn(), incr: vi.fn().mockResolvedValue(1), rpush: vi.fn(), lrange: vi.fn().mockResolvedValue([]) }),
}));

const alpacaTradeMutation = vi.fn();
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: vi.fn().mockResolvedValue([]),
  alpacaTradeMutation,
  alpacaData: vi.fn(),
}));

vi.mock('../../api/_lib/alpaca', () => ({}));

vi.mock('../../api/_lib/rule-check', () => ({
  runRuleChecks: vi.fn().mockResolvedValue([]),
  runStubRuleChecks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/_lib/grading', () => ({ gradeTrade: vi.fn() }));

vi.mock('../../api/_lib/totp', () => ({ verifyTotp: vi.fn().mockReturnValue(true) }));

vi.mock('../../api/_lib/exposure', () => ({
  computeExposure: vi.fn().mockReturnValue(500),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

const liveDraft = {
  account: 'live',
  asset_class: 'stock',
  symbol: 'F',
  side: 'buy',
  qty: 10,
  order_type: 'market',
  limit_price: null,
  tif: 'day',
  contract_symbol: null,
  strike: null,
  expiration: null,
  contract_type: null,
  greeks_at_entry: null,
  entry_grade: 'B',
  entry_reasoning: 'because reasons',
  tags: [],
};

describe('trades/submit — live account kill switch (live ON by default since 2026-09-08)', () => {
  const origLiveEnabled = process.env.LIVE_ENABLED;

  beforeEach(() => {
    delete process.env.LIVE_ENABLED;
    alpacaTradeMutation.mockReset();
    // Placement (POST /v2/orders) goes through alpacaTradeMutation — give it a
    // resolved order so a permitted path can complete past placement.
    alpacaTradeMutation.mockResolvedValue({ id: 'order-1', submitted_at: '2026-09-08T13:00:00Z' });
  });

  afterEach(() => {
    if (origLiveEnabled === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = origLiveEnabled;
  });

  it('does NOT 403 account=live when LIVE_ENABLED is unset (live is on by default)', async () => {
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'POST', query: { action: 'submit' }, body: liveDraft };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMutation).toHaveBeenCalled();
  });

  it('does NOT 403 account=live when LIVE_ENABLED is "true"', async () => {
    process.env.LIVE_ENABLED = 'true';
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'POST', query: { action: 'submit' }, body: liveDraft };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('returns 403 and never reaches Alpaca when account=live and LIVE_ENABLED is "false" (kill switch)', async () => {
    process.env.LIVE_ENABLED = 'false';
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'POST', query: { action: 'submit' }, body: liveDraft };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error).toBe('live_trading_disabled');
    expect(alpacaTradeMutation).not.toHaveBeenCalled();
  });

  it('kill switch also blocks a live spread submit', async () => {
    process.env.LIVE_ENABLED = 'false';
    const handler = (await import('../../api/trades/[action]')).default;
    const spread = {
      kind: 'spread',
      account: 'live',
      spread_type: 'put_credit',
      symbol: 'F',
      expiration: '2026-10-16',
      short_leg: { contract_symbol: 'F261016P00011000', strike: 11, side: 'sell' },
      long_leg: { contract_symbol: 'F261016P00010000', strike: 10, side: 'buy' },
      qty: 1,
      limit_price: -0.25,
      entry_grade: 'B',
      entry_reasoning: 'x',
      tags: [],
    };
    const req: any = { method: 'POST', query: { action: 'submit' }, body: spread };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(alpacaTradeMutation).not.toHaveBeenCalled();
  });

  it('does NOT 403 paper accounts even when the kill switch is on (gate is account=live only)', async () => {
    process.env.LIVE_ENABLED = 'false';
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'POST', query: { action: 'submit' }, body: { ...liveDraft, account: 'manual_paper' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
