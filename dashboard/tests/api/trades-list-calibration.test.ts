import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const kvGet = vi.fn();
const kvSet = vi.fn();
// D4: readMonthIndex now calls lrange for trades:index:YYYY-MM keys.
// Route lrange for month-index keys through kvGet so existing test data works.
const lrange = vi.fn(async (k: string) => {
  if (/^trades:index:\d{4}-\d{2}$/.test(k)) {
    const val = await kvGet(k);
    return Array.isArray(val) ? val : [];
  }
  return [];
});
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange, del: vi.fn().mockResolvedValue(1), rpush: vi.fn().mockResolvedValue(1) }),
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

describe('trades/list — calibration excludes inherited grades', () => {
  beforeEach(() => { kvGet.mockReset(); });

  it('counts the parent put once, excludes the assignment-spawned stock trade', async () => {
    const parentPut = {
      id: 'T-2026-04-01-001',
      account: 'conservative_paper',
      asset_class: 'option',
      contract_type: 'put',
      side: 'STO',
      symbol: 'F',
      qty: 1,
      closed_at: '2026-04-15T20:00:00Z',
      realized_pnl: 50,
      tags: [],
      entry_grade: 'B',
      ai_grade_inherited: false,
      schema: 1,
    };
    const spawnedStock = {
      id: 'T-2026-04-15-001',
      account: 'conservative_paper',
      asset_class: 'stock',
      contract_type: null,
      side: 'buy',
      symbol: 'F',
      qty: 100,
      closed_at: null,
      realized_pnl: null,
      tags: [],
      entry_grade: 'B',
      ai_grade_inherited: true,
      parent_id: 'T-2026-04-01-001',
      source: 'assignment',
      schema: 1,
    };
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-2026-04-01-001') return parentPut;
      if (k === 'trade:T-2026-04-15-001') return spawnedStock;
      if (k === 'grade:T-2026-04-01-001') return {
        trade_id: 'T-2026-04-01-001',
        hindsight: { letter: 'C', calibration: 'over_1' },
      };
      if (k === 'grade:T-2026-04-15-001') return {
        trade_id: 'T-2026-04-15-001',
        hindsight: { letter: 'C', calibration: 'over_1' },
      };
      if (k.startsWith('trades:index:') && /\d{4}-\d{2}/.test(k)) {
        return ['T-2026-04-01-001', 'T-2026-04-15-001'];
      }
      return null;
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'list' } };
    const res = mkRes();
    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.summary.calibration.over).toBe(1);
    expect(body.summary.calibration.matched).toBe(0);
    expect(body.summary.calibration.under).toBe(0);
  });

  it('still counts non-inherited grades normally', async () => {
    const trade1 = {
      id: 'T-1', account: 'conservative_paper', asset_class: 'stock', side: 'buy',
      symbol: 'F', qty: 10, closed_at: '2026-04-15T20:00:00Z', realized_pnl: 50,
      tags: [], entry_grade: 'B', ai_grade_inherited: false, schema: 1,
    };
    const trade2 = { ...trade1, id: 'T-2' };
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'trade:T-1') return trade1;
      if (k === 'trade:T-2') return trade2;
      if (k === 'grade:T-1') return { trade_id: 'T-1', hindsight: { calibration: 'matched' } };
      if (k === 'grade:T-2') return { trade_id: 'T-2', hindsight: { calibration: 'over_1' } };
      if (k.startsWith('trades:index:') && /\d{4}-\d{2}/.test(k)) return ['T-1', 'T-2'];
      return null;
    });

    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = { method: 'GET', query: { action: 'list' } };
    const res = mkRes();
    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.summary.calibration.matched).toBe(1);
    expect(body.summary.calibration.over).toBe(1);
  });
});
