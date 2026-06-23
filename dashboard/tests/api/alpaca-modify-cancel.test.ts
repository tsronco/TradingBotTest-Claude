import { describe, expect, it, vi, beforeEach } from 'vitest';

const alpacaTradeMutationMock = vi.fn();
const kvLrangeMock = vi.fn();
const kvGetMock = vi.fn();
const kvSetMock = vi.fn();
const kvLremMock = vi.fn();

vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ id: 'test-session' })),
}));
vi.mock('../../api/_lib/alpaca', () => ({
  modeFromQuery: vi.fn(() => 'conservative'),
  // liveGuard must be present (handler imports it). Conservative mode always
  // passes through — returning false unconditionally is correct for these tests.
  liveGuard: vi.fn(() => false),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTradeMutation: (...a: unknown[]) => alpacaTradeMutationMock(...a),
  alpacaTrade: vi.fn(),
  alpacaData: vi.fn(),
}));
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ lrange: kvLrangeMock, get: kvGetMock, set: kvSetMock, lrem: kvLremMock }),
}));
vi.mock('../../api/_lib/kv-keys', () => ({
  KV_KEYS: { tradesIndexOpen: 'trades:index:open' },
  tradeKey: (id: string) => `trade:${id}`,
}));

beforeEach(() => {
  alpacaTradeMutationMock.mockReset();
  kvLrangeMock.mockReset();
  kvGetMock.mockReset();
  kvSetMock.mockReset();
  kvLremMock.mockReset();
  // Default: no open trades
  kvLrangeMock.mockResolvedValue([]);
  vi.resetModules();
});

function mockReq(endpoint: string, method: string, body?: unknown) {
  return {
    method,
    query: { endpoint, mode: 'conservative' },
    body,
    headers: {},
  } as unknown as import('@vercel/node').VercelRequest;
}

function mockRes() {
  const res: Record<string, unknown> & {
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

describe('modify-order', () => {
  it('PATCHes the order with provided fields', async () => {
    alpacaTradeMutationMock.mockResolvedValue({ id: 'a1', qty: '5' });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('modify-order', 'POST', { order_id: 'a1', qty: 5, limit_price: 320 }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      'conservative',
      '/v2/orders/a1',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({ qty: 5, limit_price: 320 }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 400 without order_id', async () => {
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('modify-order', 'POST', {}),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(alpacaTradeMutationMock).not.toHaveBeenCalled();
  });
});

describe('cancel-order', () => {
  it('DELETEs the order and returns ok', async () => {
    alpacaTradeMutationMock.mockResolvedValue(null);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      mockReq('cancel-order', 'POST', { order_id: 'a1' }),
      res as unknown as import('@vercel/node').VercelResponse,
    );
    expect(alpacaTradeMutationMock).toHaveBeenCalledWith(
      'conservative',
      '/v2/orders/a1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
