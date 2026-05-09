import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const kvGet = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: vi.fn(), lrange: vi.fn().mockResolvedValue([]) }),
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

describe('trades/performance', () => {
  beforeEach(() => { kvGet.mockReset(); });

  it('aggregates win-rate-by-tag, pnl-by-symbol, and calibration', async () => {
    const trades = [
      { id: 't1', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50,  tags: ['scalp'], account: 'conservative_paper', entry_grade: 'B', ai_grade_inherited: false },
      { id: 't2', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-16T18:00:00Z', realized_pnl: -25, tags: ['scalp'], account: 'conservative_paper', entry_grade: 'C', ai_grade_inherited: false },
      { id: 't3', symbol: 'TSLA', asset_class: 'option', closed_at: '2026-04-17T14:00:00Z', realized_pnl: 200, tags: ['wheel'], account: 'aggressive_paper', entry_grade: 'A', ai_grade_inherited: false },
    ];
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trades:index:2026-04') return ['t1', 't2', 't3'];
      if (k.startsWith('trades:index:')) return [];
      if (k === 'trade:t1') return trades[0];
      if (k === 'trade:t2') return trades[1];
      if (k === 'trade:t3') return trades[2];
      if (k === 'grade:t1') return { trade_id: 't1', hindsight: { letter: 'A' } };
      if (k === 'grade:t2') return { trade_id: 't2', hindsight: { letter: 'D' } };
      if (k === 'grade:t3') return null;
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'performance', date_range: 'ALL' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];

    expect(body.calibration).toHaveLength(2);
    expect(body.win_rate_by_tag.find((r: any) => r.tag === 'scalp')).toMatchObject({ trades: 2, wins: 1, total_pnl: 25 });
    expect(body.win_rate_by_tag.find((r: any) => r.tag === 'wheel')).toMatchObject({ trades: 1, wins: 1, total_pnl: 200 });
    const fSym = body.pnl_by_symbol.find((s: any) => s.symbol === 'F');
    expect(fSym.total_pnl).toBe(25);
  });

  it('excludes inherited grades from calibration', async () => {
    const trades = [
      { id: 't1', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50, tags: [], account: 'conservative_paper', entry_grade: 'B', ai_grade_inherited: false },
      { id: 't2', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-16T20:00:00Z', realized_pnl: 100, tags: [], account: 'conservative_paper', entry_grade: 'A', ai_grade_inherited: true },
    ];
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trades:index:2026-04') return ['t1', 't2'];
      if (k.startsWith('trades:index:')) return [];
      if (k === 'trade:t1') return trades[0];
      if (k === 'trade:t2') return trades[1];
      if (k === 'grade:t1') return { trade_id: 't1', hindsight: { letter: 'B' } };
      if (k === 'grade:t2') return { trade_id: 't2', hindsight: { letter: 'A' } };
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'performance', date_range: 'ALL' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.calibration).toHaveLength(1);
    expect(body.calibration[0].trade_id).toBe('t1');
  });

  it('filters by account, tag, asset_class', async () => {
    const trades = [
      { id: 't1', symbol: 'F', asset_class: 'stock', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50, tags: ['scalp'], account: 'conservative_paper', entry_grade: 'B' },
      { id: 't2', symbol: 'TSLA', asset_class: 'option', closed_at: '2026-04-15T20:00:00Z', realized_pnl: 100, tags: ['wheel'], account: 'aggressive_paper', entry_grade: 'A' },
    ];
    kvGet.mockImplementation(async (k: string) => {
      if (k.startsWith('trades:index:')) return ['t1', 't2'];
      if (k === 'trade:t1') return trades[0];
      if (k === 'trade:t2') return trades[1];
      return null;
    });
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'performance', date_range: 'ALL', account: 'conservative_paper' } };
    const res = mkRes();
    await handler(req, res);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.pnl_by_symbol.map((s: any) => s.symbol)).toEqual(['F']);
  });
});
