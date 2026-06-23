// dashboard/tests/api/trades-submit.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvIncr = vi.fn();
const kvLpush = vi.fn();
const kvRpush = vi.fn();
const ruleCheckMock = vi.fn();
const dataMock = vi.fn();
const verifyTotpMock = vi.fn();
const alpacaTradeMutationMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, incr: kvIncr, lpush: kvLpush, rpush: kvRpush, sadd: vi.fn(), lrange: vi.fn(), lrem: vi.fn() }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({
  runStubRuleChecks: (...a: any[]) => ruleCheckMock(...a),
  runRuleChecks: (...a: any[]) => ruleCheckMock(...a),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
  alpacaTrade: vi.fn().mockResolvedValue([]),
  alpacaTradeMutation: (...a: any[]) => alpacaTradeMutationMock(...a),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...a: any[]) => verifyTotpMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  modeFromQuery: () => 'conservative',
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvIncr.mockReset(); kvLpush.mockReset(); kvRpush.mockReset();
  ruleCheckMock.mockReset(); dataMock.mockReset(); verifyTotpMock.mockReset();
  alpacaTradeMutationMock.mockReset();
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  delete process.env.LIVE_ENABLED;
});

function mockReq(body?: any): VercelRequest {
  return { method: 'POST', query: { action: 'submit' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/submit', () => {
  it('rejects when validation fails', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: '', tags: [],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects when TOTP required but missing/invalid', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 1000, aggressive_paper: 1000, live: 1500 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    verifyTotpMock.mockReturnValue(false);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: [],
      totp_code: 'wrong',
    }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('sets position_intent=sell_to_open for STO option orders', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ snapshots: { 'PLTR260605P00100000': { latestQuote: { ap: 1.55, bp: 1.50 }, greeks: { delta: -0.30, gamma: 0.04, theta: -0.05, vega: 0.10, implied_volatility: 0.65 } } } });
    kvIncr.mockResolvedValue(1);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alp-opt-1', submitted_at: '2026-05-06T14:00:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'option', symbol: 'PLTR',
      contract_symbol: 'PLTR260605P00100000', strike: 100, expiration: '2026-06-05', contract_type: 'put',
      side: 'STO', qty: 1, order_type: 'limit', limit_price: 1.50,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'wheel csp 10% otm', tags: [],
    }), res);
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      '/v2/orders',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ side: 'sell', position_intent: 'sell_to_open' }),
      }),
    );
  });

  it('sets position_intent=buy_to_open for BTO option orders', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ snapshots: { 'TSLA260605C00400000': { latestQuote: { ap: 2.05, bp: 2.00 } } } });
    kvIncr.mockResolvedValue(2);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alp-opt-2', submitted_at: '2026-05-06T14:00:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'option', symbol: 'TSLA',
      contract_symbol: 'TSLA260605C00400000', strike: 400, expiration: '2026-06-05', contract_type: 'call',
      side: 'BTO', qty: 1, order_type: 'limit', limit_price: 2.00,
      tif: 'day', entry_grade: 'B', entry_reasoning: 'long call directional', tags: [],
    }), res);
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      '/v2/orders',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ side: 'buy', position_intent: 'buy_to_open' }),
      }),
    );
  });

  it('returns 502 with Alpaca error message when createOrder fails', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ snapshots: { 'PLTR260605P00100000': { latestQuote: { ap: 1.55, bp: 1.50 } } } });
    alpacaTradeMutationMock.mockRejectedValue(new Error('alpaca trade 422: insufficient_buying_power'));
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'option', symbol: 'PLTR',
      contract_symbol: 'PLTR260605P00100000', strike: 100, expiration: '2026-06-05', contract_type: 'put',
      side: 'STO', qty: 1, order_type: 'limit', limit_price: 1.50,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'wheel csp', tags: [],
    }), res);
    expect(res.status).toHaveBeenCalledWith(502);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.error).toBe('alpaca_order_failed');
    expect(body.detail).toMatch(/insufficient_buying_power/);
  });

  it('places Alpaca order, writes trade+grade records, indexes', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    kvIncr.mockResolvedValue(1);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alp-abc-123', submitted_at: '2026-05-04T13:30:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'conservative_paper', asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 10, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'breakout', tags: ['breakout'],
    }), res);
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      'conservative',
      '/v2/orders',
      expect.objectContaining({ method: 'POST' }),
    );
    const json = (res.json as any).mock.calls[0][0];
    expect(json.id).toMatch(/^T-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(json.alpaca_order_id).toBe('alp-abc-123');
    expect(kvSet).toHaveBeenCalledWith(expect.stringMatching(/^trade:T-/), expect.any(Object));
    expect(kvSet).toHaveBeenCalledWith(expect.stringMatching(/^grade:T-/), expect.any(Object));
    expect(kvRpush).toHaveBeenCalledWith('trades:index:open', expect.stringMatching(/^T-/));
  });

  // --- LIVE single-leg placement must NOT use the SDK ---
  // The @alpacahq/typescript-sdk preview ignores paper:false and routes every
  // trading request to paper-api.alpaca.markets. A live order sent through it
  // carries live keys to the paper host → 40110000 "request is not authorized".
  // Single-leg placement must go through alpacaTradeMutation (POST /v2/orders),
  // which honors tradingBase(mode) → api.alpaca.markets for live. Mirrors the
  // spread path. Reproduces the real failed "BUY 1 F @ 13.30 on live" order.
  it('places a LIVE single-leg order via alpacaTradeMutation, never the SDK', async () => {
    process.env.LIVE_ENABLED = 'true';
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ F: { latestQuote: { ap: 14.62, bp: 14.60 } } });
    kvIncr.mockResolvedValue(1);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alp-live-1', submitted_at: '2026-06-23T14:00:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account: 'live', asset_class: 'stock', symbol: 'F',
      side: 'buy', qty: 1, order_type: 'limit', limit_price: 13.30,
      tif: 'day', entry_grade: 'B', entry_reasoning: 'live account smoke test — 1 share', tags: [],
    }), res);
    // Placement goes through the direct trading-API helper, routed to live.
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      'live',
      '/v2/orders',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ symbol: 'F', side: 'buy', type: 'limit' }),
      }),
    );
    const json = (res.json as any).mock.calls[0][0];
    expect(json.alpaca_order_id).toBe('alp-live-1');
  });

  it('submits a spread payload, builds mleg order, writes trade record', async () => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, manual_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    kvIncr.mockResolvedValue(99);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alpaca-mleg-1', status: 'new', submitted_at: '2026-05-14T14:00:00Z' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      kind: 'spread',
      account: 'manual_paper',
      symbol: 'AAL',
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
      expiration: '2026-05-29',
      qty: 1,
      limit_price: -0.25,
      entry_grade: 'B+',
      entry_reasoning: 'Bullish AAL above $12.50',
    }), res);

    // Response shape
    const json = (res.json as any).mock.calls[0][0];
    expect(json.trade_id ?? json.id).toMatch(/^T-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(json.alpaca_order_id).toBe('alpaca-mleg-1');

    // Alpaca mleg order body
    expect(alpacaTradeMutationMock).toHaveBeenCalledTimes(1);
    const [, path, opts] = alpacaTradeMutationMock.mock.calls[0];
    expect(path).toBe('/v2/orders');
    expect(opts.method).toBe('POST');
    expect(opts.body.order_class).toBe('mleg');
    expect(opts.body.qty).toBe('1');
    expect(opts.body.type).toBe('limit');
    expect(opts.body.legs).toHaveLength(2);
    expect(opts.body.legs[0]).toMatchObject({
      symbol: 'AAL260529P00012500',
      side: 'sell',
      position_intent: 'sell_to_open',
    });
    expect(opts.body.legs[1]).toMatchObject({
      symbol: 'AAL260529P00011500',
      side: 'buy',
      position_intent: 'buy_to_open',
    });

    // Trade record written to KV
    const tradeWrite = kvSet.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].startsWith('trade:T-'));
    expect(tradeWrite).toBeDefined();
    const tradeRecord = tradeWrite![1];
    expect(tradeRecord.asset_class).toBe('spread');
    expect(tradeRecord.filled_at).toBeNull();
    expect(tradeRecord.spread.short_leg.strike).toBe(12.5);
    expect(tradeRecord.spread.long_leg.strike).toBe(11.5);
    expect(tradeRecord.spread.net_credit).toBeCloseTo(0.25, 6);
    expect(tradeRecord.spread.max_loss).toBeCloseTo(0.75, 6);
    expect(tradeRecord.spread.width).toBeCloseTo(1, 6);

    // Open index push
    expect(kvRpush).toHaveBeenCalledWith('trades:index:open', expect.stringMatching(/^T-/));
  });

  // --- SM cross-account routing (Phase 6.x critical fix) ---
  // modeFromAccount() in trades/[action].ts MUST route SM accounts to their
  // own Alpaca creds — the spread submit path calls
  // alpacaTradeMutation(modeFromAccount(p.account), ...). A regression here
  // would silently place an SM spread on the conservative paper account.
  it.each([
    ['sm500_paper', 'sm500'],
    ['sm1000_paper', 'sm1000'],
    ['sm2000_paper', 'sm2000'],
  ])('routes %s spread submit to mode %s, not conservative', async (account, expectedMode) => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, manual_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    kvIncr.mockResolvedValue(1);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alpaca-sm-1', status: 'new', submitted_at: '2026-05-16T14:00:00Z' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      kind: 'spread',
      account,
      symbol: 'AAL',
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
      long_leg:  { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
      expiration: '2026-05-29',
      qty: 1,
      limit_price: -0.25,
      entry_grade: 'B+',
      entry_reasoning: 'SM small-account spread routing test',
    }), res);

    // The mleg order + the server-side positions re-check both go through the
    // SM mode, never conservative.
    expect(alpacaTradeMutationMock).toHaveBeenCalledTimes(1);
    expect(alpacaTradeMutationMock.mock.calls[0][0]).toBe(expectedMode);
    expect(alpacaTradeMutationMock.mock.calls[0][0]).not.toBe('conservative');
  });

  // Stock submit path: modeFromAccount feeds getQuote (alpacaData) + the
  // positions re-check (alpacaTrade). Assert the quote call gets the SM mode.
  it.each([
    ['sm500_paper', 'sm500'],
    ['sm1000_paper', 'sm1000'],
    ['sm2000_paper', 'sm2000'],
  ])('routes %s stock submit quote to mode %s, not conservative', async (account, expectedMode) => {
    kvGet.mockImplementation((k: string) =>
      k === 'config:totp_thresholds'
        ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, manual_paper: 100000, live: 100000 })
        : Promise.resolve(null));
    ruleCheckMock.mockResolvedValue([]);
    dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
    verifyTotpMock.mockReturnValue(true);
    kvIncr.mockResolvedValue(1);
    alpacaTradeMutationMock.mockResolvedValue({ id: 'alp-sm-stk-1', submitted_at: '2026-05-16T14:00:00Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      account, asset_class: 'stock', symbol: 'TSLA',
      side: 'buy', qty: 5, order_type: 'limit', limit_price: 321.40,
      tif: 'day', entry_grade: 'A', entry_reasoning: 'SM routing', tags: [],
    }), res);
    // getQuote(symbol, asset_class, modeFromAccount(account)) → alpacaData(mode, ...)
    expect(dataMock).toHaveBeenCalled();
    const quoteModes = dataMock.mock.calls.map((c: any[]) => c[0]);
    expect(quoteModes).toContain(expectedMode);
    expect(quoteModes).not.toContain('conservative');
    // Placement routes to the SM mode too — never conservative.
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      expectedMode,
      '/v2/orders',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
