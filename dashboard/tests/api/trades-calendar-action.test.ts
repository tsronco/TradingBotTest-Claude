import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const kvGet = vi.fn();
// D4: readMonthIndex now calls lrange for trades:index:YYYY-MM keys.
// Route lrange for month-index keys through kvGet so existing test data works.
const kvLrange = vi.fn(async (k: string) => {
  if (/^trades:index:\d{4}-\d{2}$/.test(k)) {
    const val = await kvGet(k);
    return Array.isArray(val) ? val : [];
  }
  return [];
});
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: vi.fn(), lrange: kvLrange, del: vi.fn().mockResolvedValue(1), rpush: vi.fn().mockResolvedValue(1) }),
}));

vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: vi.fn(),
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn(),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('trades/calendar', () => {
  beforeEach(() => {
    kvGet.mockReset();
    kvLrange.mockReset();
    // D4: restore month-index routing after reset; non-month keys return [].
    kvLrange.mockImplementation(async (k: string) => {
      if (/^trades:index:\d{4}-\d{2}$/.test(k)) {
        const val = await kvGet(k);
        return Array.isArray(val) ? val : [];
      }
      return [];
    });
  });

  it('returns 400 for malformed month', async () => {
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'calendar', month: 'bad' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('aggregates closed-trade P&L by day', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trades:index:2026-04') return ['t1', 't2', 't3'];
      if (k === 'trade:t1') return { id: 't1', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50, account: 'conservative_paper', tags: [] };
      if (k === 'trade:t2') return { id: 't2', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-15T18:00:00Z', realized_pnl: -25, account: 'conservative_paper', tags: [] };
      if (k === 'trade:t3') return { id: 't3', symbol: 'TSLA', asset_class: 'option', closed_at: '2026-04-16T20:00:00Z', realized_pnl: 200, account: 'aggressive_paper', tags: [] };
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'calendar', month: '2026-04' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.days['2026-04-15'].realized_pnl).toBe(25);
    expect(body.days['2026-04-15'].trade_count).toBe(2);
    expect(body.days['2026-04-16'].realized_pnl).toBe(200);
    expect(body.month_total).toBe(225);
  });

  it('filters by account', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trades:index:2026-04') return ['t1', 't2'];
      if (k === 'trade:t1') return { id: 't1', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50, account: 'conservative_paper', tags: [] };
      if (k === 'trade:t2') return { id: 't2', symbol: 'TSLA', asset_class: 'option', closed_at: '2026-04-16T20:00:00Z', realized_pnl: 200, account: 'aggressive_paper', tags: [] };
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'calendar', month: '2026-04', account: 'conservative_paper' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.days['2026-04-16']).toBeUndefined();
    expect(body.days['2026-04-15']).toBeDefined();
  });

  it('overlays open option expirations on the day they expire', async () => {
    // D4: readMonthIndex uses lrange; the open-index lrange is also lrange.
    // Override to route by key so each call returns the right data.
    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return ['op1'];
      if (/^trades:index:\d{4}-\d{2}$/.test(k)) return [];
      return [];
    });
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:op1') return {
        id: 'op1', symbol: 'TSLA', asset_class: 'option', contract_type: 'put',
        strike: 200, expiration: '2026-04-30',
        closed_at: null, account: 'conservative_paper', tags: [],
      };
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'calendar', month: '2026-04' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.days['2026-04-30'].open_options_expiring).toHaveLength(1);
    expect(body.days['2026-04-30'].open_options_expiring[0].symbol).toBe('TSLA');
  });
});
