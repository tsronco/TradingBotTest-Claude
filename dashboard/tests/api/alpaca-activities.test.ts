import { describe, it, expect, vi, beforeEach } from 'vitest';

const alpacaTradeMock = vi.fn();

vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ id: 'test-session' })),
}));
vi.mock('../../api/_lib/alpaca', () => ({
  modeFromQuery: vi.fn(() => 'live'),
  liveGuard: vi.fn(() => false),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: (...a: unknown[]) => alpacaTradeMock(...a),
  alpacaData: vi.fn(),
  alpacaTradeMutation: vi.fn(),
}));
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({}) }));
vi.mock('../../api/_lib/kv-keys', () => ({ KV_KEYS: {}, tradeKey: (id: string) => `trade:${id}` }));
vi.mock('../../api/_lib/order-pairing', () => ({
  pairOrders: vi.fn(() => ({ realizedByOrderId: new Map(), statusByOrderId: new Map() })),
}));

function mockRes() {
  const res: Record<string, ReturnType<typeof vi.fn>> & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  } = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('GET /api/alpaca/activities', () => {
  beforeEach(() => {
    alpacaTradeMock.mockReset();
    vi.resetModules();
  });

  it('returns CSD/CSW activities for the live account', async () => {
    alpacaTradeMock.mockResolvedValue([
      { id: '1', activity_type: 'CSD', net_amount: '1000', date: '2026-06-30' },
    ]);
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const req = {
      method: 'GET',
      query: { endpoint: 'activities', mode: 'live' },
      headers: {},
    } as unknown as import('@vercel/node').VercelRequest;
    const res = mockRes();
    await handler(req, res as unknown as import('@vercel/node').VercelResponse);
    expect(alpacaTradeMock).toHaveBeenCalledWith(
      'live',
      '/v2/account/activities',
      { activity_types: 'CSD,CSW', page_size: 50 },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      mode: 'live',
      activities: [{ id: '1', activity_type: 'CSD', net_amount: '1000', date: '2026-06-30' }],
    });
  });
});
