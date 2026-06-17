// dashboard/tests/api/trades-submit-idempotency.test.ts
//
// D2 — No idempotency key on submit → retry double-places
//
// Tests:
//   1. submit stamps the provided idempotency_key as Alpaca client_order_id
//   2. A simulated duplicate-id rejection from Alpaca resolves the existing
//      order → exactly ONE trade record, no error surfaced (stock path)
//   3. submitSpread stamps the idempotency_key on the mleg body as client_order_id
//   4. A simulated spread duplicate-id rejection resolves the existing order →
//      exactly ONE trade record, no error surfaced
//   5. submit generates a deterministic fallback client_order_id (from the
//      pre-allocated trade id) when the client doesn't send one
//
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
const alpacaCreateOrder = vi.fn();
const alpacaTradeMutationMock = vi.fn();
const alpacaTradeMock = vi.fn();

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({
    get: kvGet,
    set: kvSet,
    incr: kvIncr,
    lpush: kvLpush,
    rpush: kvRpush,
    sadd: vi.fn(),
    lrange: vi.fn(),
    lrem: vi.fn(),
  }),
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
  alpacaTrade: (...a: any[]) => alpacaTradeMock(...a),
  alpacaTradeMutation: (...a: any[]) => alpacaTradeMutationMock(...a),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...a: any[]) => verifyTotpMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: (...a: any[]) => alpacaCreateOrder(...a) }),
  modeFromQuery: () => 'conservative',
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: vi.fn() }));
vi.mock('../../api/cron/[job]', () => ({ runGradeOpenTrades: vi.fn().mockResolvedValue({}) }));

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
  kvIncr.mockReset();
  kvLpush.mockReset();
  kvRpush.mockReset();
  ruleCheckMock.mockReset();
  dataMock.mockReset();
  verifyTotpMock.mockReset();
  alpacaCreateOrder.mockReset();
  alpacaTradeMutationMock.mockReset();
  alpacaTradeMock.mockReset();
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

  // Default thresholds: very high so TOTP never triggers in these tests
  kvGet.mockImplementation((k: string) =>
    k === 'config:totp_thresholds'
      ? Promise.resolve({ conservative_paper: 100000, aggressive_paper: 100000, manual_paper: 100000, live: 100000 })
      : Promise.resolve(null));
  // Rule checks: no warnings
  ruleCheckMock.mockResolvedValue([]);
  // Quote mock for stock submit
  dataMock.mockResolvedValue({ TSLA: { latestQuote: { ap: 321.45, bp: 321.35 } } });
  // Alpaca positions: empty
  alpacaTradeMock.mockResolvedValue([]);
  // Trade-id sequence counter
  let seq = 0;
  kvIncr.mockImplementation(() => Promise.resolve(++seq));
  kvSet.mockResolvedValue('OK');
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

const STOCK_DRAFT = {
  account: 'conservative_paper',
  asset_class: 'stock',
  symbol: 'TSLA',
  side: 'buy',
  qty: 10,
  order_type: 'limit',
  limit_price: 321.40,
  tif: 'day',
  entry_grade: 'A',
  entry_reasoning: 'breakout',
  tags: [],
};

const SPREAD_DRAFT = {
  kind: 'spread',
  account: 'manual_paper',
  symbol: 'AAL',
  spread_type: 'put_credit',
  short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
  long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
  expiration: '2026-05-29',
  qty: 1,
  limit_price: -0.25,
  entry_grade: 'B+',
  entry_reasoning: 'Bullish AAL above $12.50',
};

describe('D2 — idempotency key on order submit', () => {
  it('stamps the provided idempotency_key as Alpaca client_order_id on stock submit', async () => {
    alpacaCreateOrder.mockResolvedValue({ id: 'alp-abc-1', submitted_at: '2026-06-17T13:00:00Z' });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      ...STOCK_DRAFT,
      idempotency_key: 'dash-idem-key-abc123',
    }), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(502);
    expect(alpacaCreateOrder).toHaveBeenCalledOnce();
    const payload = alpacaCreateOrder.mock.calls[0][0];
    expect(payload.client_order_id).toBe('dash-idem-key-abc123');
  });

  it('stamps the idempotency_key as client_order_id on the mleg body for spread submit', async () => {
    alpacaTradeMutationMock.mockResolvedValue({
      id: 'alpaca-mleg-idem', status: 'new', submitted_at: '2026-06-17T13:00:00Z',
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      ...SPREAD_DRAFT,
      idempotency_key: 'dash-spread-idem-xyz',
    }), res);

    expect(alpacaTradeMutationMock).toHaveBeenCalledOnce();
    const [, , opts] = alpacaTradeMutationMock.mock.calls[0];
    expect(opts.body.client_order_id).toBe('dash-spread-idem-xyz');
  });

  it('generates a deterministic fallback client_order_id when none is provided (stock)', async () => {
    alpacaCreateOrder.mockResolvedValue({ id: 'alp-fallback-1', submitted_at: '2026-06-17T13:00:00Z' });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    // Send draft WITHOUT idempotency_key
    await handler(mockReq({ ...STOCK_DRAFT }), res);

    expect(alpacaCreateOrder).toHaveBeenCalledOnce();
    const payload = alpacaCreateOrder.mock.calls[0][0];
    // Must be present and non-empty even without a client-supplied key
    expect(typeof payload.client_order_id).toBe('string');
    expect(payload.client_order_id.length).toBeGreaterThan(0);
  });

  it('generates a deterministic fallback client_order_id when none is provided (spread)', async () => {
    alpacaTradeMutationMock.mockResolvedValue({
      id: 'alpaca-mleg-fallback', status: 'new', submitted_at: '2026-06-17T13:00:00Z',
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ ...SPREAD_DRAFT }), res);

    expect(alpacaTradeMutationMock).toHaveBeenCalledOnce();
    const [, , opts] = alpacaTradeMutationMock.mock.calls[0];
    expect(typeof opts.body.client_order_id).toBe('string');
    expect(opts.body.client_order_id.length).toBeGreaterThan(0);
  });

  it('on Alpaca 422 duplicate-id rejection, resolves existing order and creates exactly ONE trade record (stock)', async () => {
    // Simulate Alpaca rejecting the order as a duplicate — same pattern as the Python bot's R1
    const duplicateError = new Error(
      'alpaca trade 422 on /v2/orders: {"code":40010001,"message":"client_order_id must be unique"}',
    );
    alpacaCreateOrder.mockRejectedValueOnce(duplicateError);

    // The handler should then call alpacaTrade (GET /v2/orders:by_client_order_id)
    // to resolve the existing order. Return a plausible existing order.
    const existingOrder = { id: 'alp-existing-order', status: 'new', submitted_at: '2026-06-17T13:00:00Z' };
    // alpacaTradeMock is used for GET calls — mock GET /orders:by_client_order_id
    alpacaTradeMock
      .mockResolvedValueOnce([])  // first call: positions re-check (happens before order placement)
      .mockResolvedValueOnce(existingOrder); // second call: by_client_order_id lookup

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      ...STOCK_DRAFT,
      idempotency_key: 'dash-idem-duplicate-key',
    }), res);

    // Must succeed — no 502 error surfaced
    expect(res.status).not.toHaveBeenCalledWith(502);

    // Exactly ONE trade record must be written
    const tradeWriteCalls = kvSet.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].startsWith('trade:T-'),
    );
    expect(tradeWriteCalls).toHaveLength(1);

    // The trade record must reference the EXISTING order's Alpaca ID
    const tradeRecord = tradeWriteCalls[0][1];
    expect(tradeRecord.alpaca_order_id).toBe('alp-existing-order');

    // Response must return a trade id (not an error)
    const json = (res.json as any).mock.calls[0][0];
    expect(json.id ?? json.trade_id).toMatch(/^T-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(json.alpaca_order_id).toBe('alp-existing-order');
  });

  it('on Alpaca 422 duplicate-id rejection for spread, resolves existing order and creates exactly ONE trade record', async () => {
    // Simulate Alpaca rejecting the mleg order as a duplicate
    const duplicateError = new Error(
      'alpaca trade 422 on /v2/orders: {"code":40010001,"message":"client_order_id must be unique"}',
    );
    alpacaTradeMutationMock.mockRejectedValueOnce(duplicateError);

    // After duplicate rejection, handler fetches existing order by client_order_id
    const existingOrder = { id: 'alp-existing-mleg', status: 'new', submitted_at: '2026-06-17T13:00:00Z' };
    alpacaTradeMock
      .mockResolvedValueOnce([])           // positions re-check
      .mockResolvedValueOnce(existingOrder); // by_client_order_id lookup

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({
      ...SPREAD_DRAFT,
      idempotency_key: 'dash-spread-dup-key',
    }), res);

    // Must succeed — no error surfaced
    expect(res.status).not.toHaveBeenCalledWith(502);

    // Exactly ONE trade record
    const tradeWriteCalls = kvSet.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].startsWith('trade:T-'),
    );
    expect(tradeWriteCalls).toHaveLength(1);

    // Must reference the resolved existing order
    const tradeRecord = tradeWriteCalls[0][1];
    expect(tradeRecord.alpaca_order_id).toBe('alp-existing-mleg');

    const json = (res.json as any).mock.calls[0][0];
    expect(json.alpaca_order_id).toBe('alp-existing-mleg');
  });
});
