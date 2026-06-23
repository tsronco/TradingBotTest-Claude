/**
 * D1 — LIVE_ENABLED gate on modify-order and cancel-order (writes only).
 *
 * After the decouple decision (2026-06-17): the gate applies ONLY to the
 * two money-moving write endpoints (modify-order, cancel-order). GET read
 * endpoints (account, positions, equity-history, etc.) are intentionally
 * ungated — live monitoring must keep working without LIVE_ENABLED.
 *
 * Write-guard tests: when mode=live and LIVE_ENABLED is not 'true', the
 * endpoint returns 403 and makes NO Alpaca mutation call.
 * When LIVE_ENABLED='true' the write path passes through.
 * Paper modes (conservative) always pass through regardless of LIVE_ENABLED.
 *
 * Read-passthrough tests: mode=live GET reads MUST call Alpaca regardless
 * of LIVE_ENABLED (reads are accepted as Low risk: single-user, read-only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies before any imports ─────────────────────────────────────

const alpacaTradeMutationMock = vi.fn();
const alpacaTradeMock = vi.fn();
const alpacaDataMock = vi.fn();
const kvLrangeMock = vi.fn();
const kvGetMock = vi.fn();
const kvSetMock = vi.fn();
const kvLremMock = vi.fn();

// modeFromQuery needs to be controllable — each test drives it via the
// mock implementation (see helpers below).
const modeFromQueryMock = vi.fn((q: unknown) => q);

vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ id: 'test-session' })),
}));

vi.mock('../../api/_lib/alpaca', () => ({
  modeFromQuery: (...a: unknown[]) => modeFromQueryMock(...a),
  // liveGuard is the real implementation inlined here so the handler's
  // import resolves correctly without pulling in @alpacahq/typescript-sdk.
  // Semantics match alpaca.ts exactly: 'live' + LIVE_ENABLED !== 'true' → 403.
  liveGuard: (
    mode: string,
    res: { status: (code: number) => { json: (body: unknown) => void } },
  ): boolean => {
    if (mode === 'live' && process.env.LIVE_ENABLED !== 'true') {
      res.status(403).json({ error: 'live_trading_disabled' });
      return true;
    }
    return false;
  },
}));

vi.mock('../../api/_lib/data-api', () => ({
  alpacaTradeMutation: (...a: unknown[]) => alpacaTradeMutationMock(...a),
  alpacaTrade: (...a: unknown[]) => alpacaTradeMock(...a),
  alpacaData: (...a: unknown[]) => alpacaDataMock(...a),
}));

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({
    lrange: kvLrangeMock,
    get: kvGetMock,
    set: kvSetMock,
    lrem: kvLremMock,
  }),
}));

vi.mock('../../api/_lib/kv-keys', () => ({
  KV_KEYS: { tradesIndexOpen: 'trades:index:open' },
  tradeKey: (id: string) => `trade:${id}`,
}));

vi.mock('../../api/_lib/order-pairing', () => ({
  pairOrders: vi.fn(() => ({
    realizedByOrderId: new Map(),
    statusByOrderId: new Map(),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(endpoint: string, method: string, modeValue: string, body?: unknown) {
  return {
    method,
    query: { endpoint, mode: modeValue },
    body: body ?? {},
    headers: {},
  } as unknown as import('@vercel/node').VercelRequest;
}

function mockRes() {
  const res: Record<string, ReturnType<typeof vi.fn>> & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  } = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

const origLiveEnabled = process.env.LIVE_ENABLED;

beforeEach(() => {
  alpacaTradeMutationMock.mockReset();
  alpacaTradeMock.mockReset();
  alpacaDataMock.mockReset();
  kvLrangeMock.mockReset().mockResolvedValue([]);
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset();
  kvLremMock.mockReset();
  delete process.env.LIVE_ENABLED;
  vi.resetModules();
});

afterEach(() => {
  if (origLiveEnabled === undefined) delete process.env.LIVE_ENABLED;
  else process.env.LIVE_ENABLED = origLiveEnabled;
});

// ── modify-order ──────────────────────────────────────────────────────────────

describe('alpaca/[endpoint] — modify-order — live guard (D1)', () => {
  it('returns 403 and does NOT call Alpaca when mode=live and LIVE_ENABLED is unset', async () => {
    modeFromQueryMock.mockReturnValue('live');
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('modify-order', 'POST', 'live', { order_id: 'ord-123', qty: 5 }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ error: 'live_trading_disabled' });
    expect(alpacaTradeMutationMock).not.toHaveBeenCalled();
  });

  it('returns 403 and does NOT call Alpaca when mode=live and LIVE_ENABLED="false"', async () => {
    process.env.LIVE_ENABLED = 'false';
    modeFromQueryMock.mockReturnValue('live');
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('modify-order', 'POST', 'live', { order_id: 'ord-123', qty: 5 }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(alpacaTradeMutationMock).not.toHaveBeenCalled();
  });

  it('passes through (calls Alpaca) when mode=live and LIVE_ENABLED="true"', async () => {
    process.env.LIVE_ENABLED = 'true';
    modeFromQueryMock.mockReturnValue('live');
    alpacaTradeMutationMock.mockResolvedValue({ id: 'new-ord-999', qty: '5' });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('modify-order', 'POST', 'live', { order_id: 'ord-123', qty: 5 }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(alpacaTradeMutationMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('passes through when mode=conservative regardless of LIVE_ENABLED', async () => {
    // LIVE_ENABLED is unset (deleted in beforeEach)
    modeFromQueryMock.mockReturnValue('conservative');
    alpacaTradeMutationMock.mockResolvedValue({ id: 'a1', qty: '5' });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('modify-order', 'POST', 'conservative', { order_id: 'a1', qty: 5 }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMutationMock).toHaveBeenCalled();
  });
});

// ── cancel-order ──────────────────────────────────────────────────────────────

describe('alpaca/[endpoint] — cancel-order — live guard (D1)', () => {
  it('returns 403 and does NOT call Alpaca when mode=live and LIVE_ENABLED is unset', async () => {
    modeFromQueryMock.mockReturnValue('live');
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('cancel-order', 'POST', 'live', { order_id: 'ord-456' }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ error: 'live_trading_disabled' });
    expect(alpacaTradeMutationMock).not.toHaveBeenCalled();
  });

  it('returns 403 and does NOT call Alpaca when mode=live and LIVE_ENABLED="false"', async () => {
    process.env.LIVE_ENABLED = 'false';
    modeFromQueryMock.mockReturnValue('live');
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('cancel-order', 'POST', 'live', { order_id: 'ord-456' }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(alpacaTradeMutationMock).not.toHaveBeenCalled();
  });

  it('passes through (calls Alpaca) when mode=live and LIVE_ENABLED="true"', async () => {
    process.env.LIVE_ENABLED = 'true';
    modeFromQueryMock.mockReturnValue('live');
    alpacaTradeMutationMock.mockResolvedValue(null);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('cancel-order', 'POST', 'live', { order_id: 'ord-456' }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(alpacaTradeMutationMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ ok: true });
  });

  it('passes through when mode=conservative regardless of LIVE_ENABLED', async () => {
    modeFromQueryMock.mockReturnValue('conservative');
    alpacaTradeMutationMock.mockResolvedValue(null);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('cancel-order', 'POST', 'conservative', { order_id: 'a1' }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMutationMock).toHaveBeenCalled();
  });
});

// ── GET reads (positions) — decouple: reads are NOT gated ────────────────────
//
// After the 2026-06-17 decouple decision, live GET reads must pass through
// regardless of LIVE_ENABLED. The guard only applies to write endpoints.

describe('alpaca/[endpoint] — GET positions — live reads ungated (D1 decouple)', () => {
  it('passes through (calls Alpaca) when mode=live and LIVE_ENABLED is unset', async () => {
    // LIVE_ENABLED is unset (deleted in beforeEach) — reads must still work
    modeFromQueryMock.mockReturnValue('live');
    alpacaTradeMock.mockResolvedValue([]);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('positions', 'GET', 'live'),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('passes through when mode=live and LIVE_ENABLED="false"', async () => {
    process.env.LIVE_ENABLED = 'false';
    modeFromQueryMock.mockReturnValue('live');
    alpacaTradeMock.mockResolvedValue([]);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('positions', 'GET', 'live'),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('passes through when mode=conservative regardless of LIVE_ENABLED', async () => {
    modeFromQueryMock.mockReturnValue('conservative');
    alpacaTradeMock.mockResolvedValue([]);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('positions', 'GET', 'conservative'),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMock).toHaveBeenCalled();
  });
});

// ── GET reads (account) — decouple: reads are NOT gated ──────────────────────

describe('alpaca/[endpoint] — GET account — live reads ungated (D1 decouple)', () => {
  it('passes through (calls Alpaca) when mode=live and LIVE_ENABLED is unset', async () => {
    modeFromQueryMock.mockReturnValue('live');
    alpacaTradeMock.mockResolvedValue({ equity: '1000' });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('account', 'GET', 'live'),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ── GET reads (equity-history) — decouple: reads are NOT gated ───────────────

describe('alpaca/[endpoint] — GET equity-history — live reads ungated (D1 decouple)', () => {
  it('passes through (calls Alpaca) when mode=live and LIVE_ENABLED is unset', async () => {
    modeFromQueryMock.mockReturnValue('live');
    alpacaTradeMock.mockResolvedValue({ timestamp: [], equity: [] });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('equity-history', 'GET', 'live'),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(alpacaTradeMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
