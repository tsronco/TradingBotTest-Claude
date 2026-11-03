import { describe, expect, it, vi, beforeEach } from 'vitest';

const alpacaTradeMock = vi.fn();
const alpacaDataMock = vi.fn();

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
  alpacaTrade: (...a: unknown[]) => alpacaTradeMock(...a),
  alpacaData: (...a: unknown[]) => alpacaDataMock(...a),
  alpacaTradeMutation: vi.fn(),
}));
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({}) }));
vi.mock('../../api/_lib/kv-keys', () => ({ KV_KEYS: {}, tradeKey: (id: string) => `trade:${id}` }));

beforeEach(() => {
  alpacaTradeMock.mockReset();
  alpacaDataMock.mockReset();
  vi.resetModules();
});

function mockReq(query: Record<string, string>) {
  return { method: 'GET', query: { endpoint: 'quote', mode: 'live', ...query }, headers: {} } as unknown as
    import('@vercel/node').VercelRequest;
}
function mockRes() {
  const res = {} as Record<string, ReturnType<typeof vi.fn>>;
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('quote endpoint — batched ?symbols=', () => {
  it('makes ONE snapshot call for many symbols (deduped, uppercased)', async () => {
    alpacaDataMock.mockResolvedValue({ BAC: { latestTrade: { p: 49.57 } }, TSLA: { latestTrade: { p: 400 } } });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq({ symbols: 'bac,TSLA,BAC' }), res as never);
    expect(alpacaDataMock).toHaveBeenCalledTimes(1);
    expect(alpacaDataMock.mock.calls[0][1]).toBe('/v2/stocks/snapshots');
    expect(alpacaDataMock.mock.calls[0][2]).toEqual({ symbols: 'BAC,TSLA' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].symbols).toEqual(['BAC', 'TSLA']);
  });

  it('rejects a bad symbol without calling Alpaca', async () => {
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq({ symbols: 'BAC,bad sym!' }), res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(alpacaDataMock).not.toHaveBeenCalled();
  });

  it('rejects an empty list', async () => {
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq({ symbols: ' , ' }), res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('single ?symbol= form is unchanged', async () => {
    alpacaDataMock.mockResolvedValue({ BAC: {} });
    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq({ symbol: 'BAC' }), res as never);
    expect(res.json.mock.calls[0][0].symbol).toBe('BAC');
  });
});
