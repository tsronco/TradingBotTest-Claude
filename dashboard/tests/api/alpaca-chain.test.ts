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

function mockReq(symbol: string, expiration?: string) {
  const query: Record<string, string> = { endpoint: 'chain', symbol, mode: 'conservative' };
  if (expiration) query.expiration = expiration;
  return {
    method: 'GET',
    query,
    headers: {},
  } as unknown as import('@vercel/node').VercelRequest;
}

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>;
  res.status = vi.fn(() => res as unknown as import('@vercel/node').VercelResponse);
  res.json = vi.fn(() => res as unknown as import('@vercel/node').VercelResponse);
  res.setHeader = vi.fn(() => res as unknown as import('@vercel/node').VercelResponse);
  return res;
}

function makeContracts(n: number, withOI = false) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: `AMD260508P${String(i).padStart(8, '0')}`,
    underlying_symbol: 'AMD',
    expiration_date: '2026-05-08',
    strike_price: String(300 + i),
    type: 'put' as const,
    ...(withOI ? { open_interest: String(100 + i) } : {}),
  }));
}

describe('chain endpoint — open interest', () => {
  it('merges open_interest from contracts into snapshots[sym].openInterest as number', async () => {
    const contracts = makeContracts(3, true); // open_interest = "100", "101", "102"
    alpacaTradeMock.mockResolvedValue({ option_contracts: contracts });
    alpacaDataMock.mockImplementation(async (_mode: string, _path: string, params: { symbols: string }) => {
      const syms = params.symbols.split(',');
      const snapshots: Record<string, unknown> = {};
      for (const s of syms) snapshots[s] = { latestQuote: { ap: 1, bp: 0.95 } };
      return { snapshots };
    });

    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq('AMD', '2026-05-08'), res as unknown as import('@vercel/node').VercelResponse);

    const payload = (res.json.mock.calls[0]?.[0] ?? {}) as { snapshots?: Record<string, { openInterest?: number; latestQuote?: unknown }> };
    expect(payload.snapshots?.[contracts[0].symbol].openInterest).toBe(100);
    expect(payload.snapshots?.[contracts[1].symbol].openInterest).toBe(101);
    expect(payload.snapshots?.[contracts[2].symbol].openInterest).toBe(102);
    // existing snapshot fields preserved
    expect(payload.snapshots?.[contracts[0].symbol].latestQuote).toEqual({ ap: 1, bp: 0.95 });
  });
});

describe('chain endpoint — per-expiration mode', () => {
  it('without expiration param: returns contracts but skips snapshots (cheap dropdown fetch)', async () => {
    const contracts = makeContracts(150);
    alpacaTradeMock.mockResolvedValue({ option_contracts: contracts });

    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq('AMD'), res as unknown as import('@vercel/node').VercelResponse);

    const payload = (res.json.mock.calls[0]?.[0] ?? {}) as { contracts?: unknown[]; snapshots?: Record<string, unknown> };
    expect(payload.contracts?.length).toBe(150);
    expect(payload.snapshots).toEqual({});
    // No snapshot calls should have been made
    const snapshotCalls = alpacaDataMock.mock.calls.filter(
      ([, path]) => path === '/v1beta1/options/snapshots',
    );
    expect(snapshotCalls.length).toBe(0);
  });

  it('with expiration param: fetches snapshots for that expiration only', async () => {
    const contracts = makeContracts(150);
    alpacaTradeMock.mockResolvedValue({ option_contracts: contracts });
    alpacaDataMock.mockImplementation(async (_mode: string, _path: string, params: { symbols: string }) => {
      const syms = params.symbols.split(',');
      const snapshots: Record<string, unknown> = {};
      for (const s of syms) snapshots[s] = { latestQuote: { ap: 1, bp: 0.95 } };
      return { snapshots };
    });

    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(
      {
        method: 'GET',
        query: { endpoint: 'chain', symbol: 'AMD', expiration: '2026-05-08', mode: 'conservative' },
        headers: {},
      } as unknown as import('@vercel/node').VercelRequest,
      res as unknown as import('@vercel/node').VercelResponse,
    );

    const payload = (res.json.mock.calls[0]?.[0] ?? {}) as { snapshots?: Record<string, unknown> };
    expect(Object.keys(payload.snapshots ?? {}).length).toBe(150);

    // The contracts query should pass expiration_date so Alpaca only returns that exp's contracts
    const contractsCall = alpacaTradeMock.mock.calls.find(([, path]) => path === '/v2/options/contracts');
    expect(contractsCall?.[2]).toMatchObject({ expiration_date: '2026-05-08' });
  });
});

describe('chain endpoint — snapshot batching', () => {
  it('chunks snapshot calls into batches of ≤100 symbols (Alpaca cap)', async () => {
    // 250 contracts: should produce 3 snapshot calls (100 + 100 + 50)
    const contracts = makeContracts(250);
    alpacaTradeMock.mockResolvedValue({ option_contracts: contracts });
    alpacaDataMock.mockImplementation(async (_mode: string, _path: string, params: { symbols: string }) => {
      const syms = params.symbols.split(',');
      const snapshots: Record<string, unknown> = {};
      for (const s of syms) {
        snapshots[s] = { latestQuote: { ap: 1, bp: 0.95 }, greeks: { delta: -0.3 }, impliedVolatility: 0.5 };
      }
      return { snapshots };
    });

    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq('AMD', '2026-05-08'), res as unknown as import('@vercel/node').VercelResponse);

    // Each snapshot call must be ≤100 symbols
    const snapshotCalls = alpacaDataMock.mock.calls.filter(
      ([, path]) => path === '/v1beta1/options/snapshots',
    );
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of snapshotCalls) {
      const params = call[2] as { symbols: string };
      const symCount = params.symbols.split(',').length;
      expect(symCount).toBeLessThanOrEqual(100);
    }
  });

  it('merges all chunked snapshot responses into a single snapshots map', async () => {
    const contracts = makeContracts(150);
    alpacaTradeMock.mockResolvedValue({ option_contracts: contracts });
    alpacaDataMock.mockImplementation(async (_mode: string, _path: string, params: { symbols: string }) => {
      const syms = params.symbols.split(',');
      const snapshots: Record<string, unknown> = {};
      for (const s of syms) snapshots[s] = { latestQuote: { ap: 1, bp: 0.95 } };
      return { snapshots };
    });

    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq('AMD', '2026-05-08'), res as unknown as import('@vercel/node').VercelResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json.mock.calls[0]?.[0] ?? {}) as { snapshots?: Record<string, unknown> };
    // All 150 contracts should have a snapshot (proves both chunks were merged)
    expect(Object.keys(payload.snapshots ?? {}).length).toBe(150);
    expect(payload.snapshots?.[contracts[0].symbol]).toBeDefined();
    expect(payload.snapshots?.[contracts[149].symbol]).toBeDefined();
  });

  it('returns partial snapshots if a single chunk fails (other chunks still succeed)', async () => {
    const contracts = makeContracts(150);
    alpacaTradeMock.mockResolvedValue({ option_contracts: contracts });
    let snapshotCallCount = 0;
    alpacaDataMock.mockImplementation(async (_mode: string, _path: string, params: { symbols: string }) => {
      snapshotCallCount++;
      // Fail the second chunk; succeed on the first
      if (snapshotCallCount === 2) throw new Error('alpaca data 500: bad gateway');
      const syms = params.symbols.split(',');
      const snapshots: Record<string, unknown> = {};
      for (const s of syms) snapshots[s] = { latestQuote: { ap: 1, bp: 0.95 } };
      return { snapshots };
    });

    const { default: handler } = await import('../../api/alpaca/[endpoint]');
    const res = mockRes();
    await handler(mockReq('AMD', '2026-05-08'), res as unknown as import('@vercel/node').VercelResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json.mock.calls[0]?.[0] ?? {}) as { snapshots?: Record<string, unknown> };
    // First chunk (100) succeeded; second (50) failed → partial result with 100 entries
    expect(Object.keys(payload.snapshots ?? {}).length).toBe(100);
  });
});
