// dashboard/tests/api/trades-import.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvIncr = vi.fn();
const kvRpush = vi.fn();
const alpacaTradeMock = vi.fn();

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, incr: kvIncr, rpush: kvRpush, lrange: vi.fn(), lrem: vi.fn() }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({
  runStubRuleChecks: vi.fn().mockResolvedValue([]),
  runRuleChecks: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: vi.fn(),
  alpacaTrade: (...a: any[]) => alpacaTradeMock(...a),
  alpacaTradeMutation: vi.fn(),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: vi.fn(() => true) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: vi.fn() }),
  modeFromQuery: () => 'conservative',
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: vi.fn() }));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvIncr.mockReset(); kvRpush.mockReset();
  alpacaTradeMock.mockReset();
  // Sequence counter for trade-id allocation
  let seq = 0;
  kvIncr.mockImplementation(() => Promise.resolve(++seq));
});

function mockReq(body: any): VercelRequest {
  return { method: 'POST', query: { action: 'import' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/import', () => {
  it('paginates when Alpaca returns a full page (>100 fills since `since`)', async () => {
    // Alpaca's /v2/account/activities caps page_size at 100. The runImport
    // worker walks pages via the `page_token` cursor until it gets a partial
    // page back. This test asserts the loop actually invokes alpacaTrade
    // multiple times and stops correctly.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `fill-${i}`,
      activity_type: 'FILL',
      transaction_time: '2026-05-20T13:30:00Z',
      symbol: 'AAPL', side: 'buy', price: '180.00', qty: '1', order_id: `o-${i}`,
    }));
    const partialPage = [{
      id: 'fill-last',
      activity_type: 'FILL',
      transaction_time: '2026-05-20T13:35:00Z',
      symbol: 'AAPL', side: 'buy', price: '180.00', qty: '1', order_id: 'o-last',
    }];
    alpacaTradeMock
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(partialPage);
    kvGet.mockImplementation((k: string) => {
      if (k.startsWith('trades:index:')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ account: 'manual_paper', since: '2026-05-01T00:00:00Z' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(alpacaTradeMock).toHaveBeenCalledTimes(3);
    // page_size must be 100 (Alpaca's max), not 500
    expect(alpacaTradeMock.mock.calls[0][2]).toMatchObject({ page_size: 100 });
    // Second + third calls carry a page_token (the prior page's last id)
    expect(alpacaTradeMock.mock.calls[1][2]).toMatchObject({ page_token: 'fill-99' });
    expect(alpacaTradeMock.mock.calls[2][2]).toMatchObject({ page_token: 'fill-99' });
  });

  it('rejects missing account or since', async () => {
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'account_and_since_required' }));
  });

  it('rejects live without LIVE_ENABLED', async () => {
    delete process.env.LIVE_ENABLED;
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ account: 'live', since: '2026-05-01T00:00:00Z' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('pairs a put credit spread (STO higher strike + BTO lower strike, same timestamp)', async () => {
    // AAL 2026-05-29: STO 12.5 @ $0.37 + BTO 11.5 @ $0.12 → $0.25 net credit
    alpacaTradeMock.mockResolvedValue([
      {
        id: 'fill-1', activity_type: 'FILL', transaction_time: '2026-05-14T13:30:00Z',
        symbol: 'AAL260529P00012500', side: 'sell', price: '0.37', qty: '1', order_id: 'mleg-order-1',
      },
      {
        id: 'fill-2', activity_type: 'FILL', transaction_time: '2026-05-14T13:30:00Z',
        symbol: 'AAL260529P00011500', side: 'buy', price: '0.12', qty: '1', order_id: 'mleg-order-1',
      },
    ]);
    // No existing trades in the month index
    kvGet.mockImplementation((k: string) => {
      if (k.startsWith('trades:index:')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ account: 'manual_paper', since: '2026-05-01T00:00:00Z' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.imported).toMatchObject({
      imported: 1,
      spread_pairs_found: 1,
      skipped_existing: 0,
    });
    // The trade record written should be a put_credit spread
    const tradeSetCall = kvSet.mock.calls.find((c: any[]) => c[0]?.startsWith('trade:'));
    expect(tradeSetCall).toBeDefined();
    expect(tradeSetCall![1]).toMatchObject({
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'AAL',
      side: 'STO',
      tags: ['imported'],
      spread: expect.objectContaining({
        spread_type: 'put_credit',
        short_leg: expect.objectContaining({ strike: 12.5, fill_price: 0.37 }),
        long_leg: expect.objectContaining({ strike: 11.5, fill_price: 0.12 }),
        net_credit: expect.closeTo(0.25, 5),
        width: expect.closeTo(1.0, 5),
        max_loss: expect.closeTo(0.75, 5),
      }),
    });
  });

  it('imports a single STO option fill that does not pair', async () => {
    alpacaTradeMock.mockResolvedValue([
      {
        id: 'fill-1', activity_type: 'FILL', transaction_time: '2026-05-14T13:30:00Z',
        symbol: 'NVTS260605P00020500', side: 'sell', price: '2.12', qty: '2', order_id: 'sto-order-1',
      },
    ]);
    kvGet.mockImplementation((k: string) => {
      if (k.startsWith('trades:index:')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ account: 'manual_paper', since: '2026-05-01T00:00:00Z' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.imported.imported).toBe(1);
    expect(body.imported.spread_pairs_found).toBe(0);

    const tradeSetCall = kvSet.mock.calls.find((c: any[]) => c[0]?.startsWith('trade:'));
    expect(tradeSetCall![1]).toMatchObject({
      account: 'manual_paper',
      asset_class: 'option',
      symbol: 'NVTS',
      side: 'STO',
      qty: 2,
      contract_symbol: 'NVTS260605P00020500',
      strike: 20.5,
      expiration: '2026-06-05',
      contract_type: 'put',
      filled_avg_price: 2.12,
      alpaca_order_id: 'sto-order-1',
      tags: ['imported'],
    });
  });

  it('skips fills whose order_id already exists on a trade record', async () => {
    alpacaTradeMock.mockResolvedValue([
      {
        id: 'fill-1', activity_type: 'FILL', transaction_time: '2026-05-14T13:30:00Z',
        symbol: 'NVTS260605P00020500', side: 'sell', price: '2.12', qty: '2', order_id: 'sto-already-imported',
      },
    ]);
    // The month index has a trade whose alpaca_order_id matches the fill's order_id
    kvGet.mockImplementation((k: string) => {
      if (k === 'trades:index:2026-05') return Promise.resolve(['T-2026-05-14-001']);
      if (k === 'trade:T-2026-05-14-001') return Promise.resolve({
        id: 'T-2026-05-14-001', account: 'manual_paper', asset_class: 'option',
        symbol: 'NVTS', alpaca_order_id: 'sto-already-imported',
      });
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ account: 'manual_paper', since: '2026-05-01T00:00:00Z' }), res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.imported.imported).toBe(0);
    expect(body.imported.skipped_existing).toBe(1);
  });

  it('does not pair fills whose timestamps are more than 5s apart', async () => {
    // Two option fills, same expiration + opposite sides, 10 seconds apart →
    // NOT a spread pair. Each becomes a single (singles are still openable
    // if they are STO/BTO).
    alpacaTradeMock.mockResolvedValue([
      {
        id: 'fill-1', activity_type: 'FILL', transaction_time: '2026-05-14T13:30:00Z',
        symbol: 'AAL260529P00012500', side: 'sell', price: '0.37', qty: '1', order_id: 'order-a',
      },
      {
        id: 'fill-2', activity_type: 'FILL', transaction_time: '2026-05-14T13:30:11Z',
        symbol: 'AAL260529P00011500', side: 'buy', price: '0.12', qty: '1', order_id: 'order-b',
      },
    ]);
    kvGet.mockImplementation((k: string) => {
      if (k.startsWith('trades:index:')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ account: 'manual_paper', since: '2026-05-01T00:00:00Z' }), res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.imported.spread_pairs_found).toBe(0);
    // Both fills imported as singles (one STO short, one BTO long)
    expect(body.imported.imported).toBe(2);
  });
});

describe('parseOcc + groupFillsIntoSpreadsAndSingles', () => {
  it('parses standard OCC option symbol', async () => {
    const { parseOcc } = await import('../../api/trades/[action]') as any;
    const out = parseOcc('AAL260529P00012500');
    expect(out).toEqual({
      underlying: 'AAL', expiration: '2026-05-29', type: 'put', strike: 12.5,
    });
  });

  it('returns null for non-option symbol', async () => {
    const { parseOcc } = await import('../../api/trades/[action]') as any;
    expect(parseOcc('NVTS')).toBeNull();
  });

  it('groups one spread pair + leaves stock fill as single', async () => {
    const { groupFillsIntoSpreadsAndSingles } = await import('../../api/trades/[action]') as any;
    const fills = [
      { symbol: 'AAL260529P00012500', side: 'sell', price: '0.37', qty: '1', transaction_time: '2026-05-14T13:30:00Z' },
      { symbol: 'AAL260529P00011500', side: 'buy', price: '0.12', qty: '1', transaction_time: '2026-05-14T13:30:01Z' },
      { symbol: 'NVTS', side: 'buy', price: '20.50', qty: '10', transaction_time: '2026-05-14T14:00:00Z' },
    ];
    const out = groupFillsIntoSpreadsAndSingles(fills);
    expect(out.pairs.length).toBe(1);
    expect(out.pairs[0].short_occ.strike).toBe(12.5);
    expect(out.pairs[0].long_occ.strike).toBe(11.5);
    expect(out.singles.length).toBe(1);
    expect(out.singles[0].symbol).toBe('NVTS');
  });
});
