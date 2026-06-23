import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
const kvLrange = vi.fn();
const kvLrem = vi.fn().mockResolvedValue(1);
const kvRpush = vi.fn().mockResolvedValue(1);
const kvIncr = vi.fn().mockResolvedValue(1);
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem, rpush: kvRpush, incr: kvIncr, del: vi.fn().mockResolvedValue(1) }),
}));

vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: vi.fn().mockResolvedValue([]),
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../api/_lib/alpaca', () => ({}));

vi.mock('../../api/_lib/grading', () => ({
  gradeTrade: vi.fn(),
}));

vi.mock('../../api/_lib/proposal-prompts', () => ({
  proposeNewRule: vi.fn(),
  proposeDemote: vi.fn(),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

const parentPut = {
  id: 'T-2026-04-01-001',
  account: 'conservative_paper',
  asset_class: 'option',
  symbol: 'F',
  contract_symbol: 'F260415P00012000',
  contract_type: 'put',
  side: 'STO',
  strike: 12,
  qty: 1,
  filled_avg_price: 0.50,
  filled_at: '2026-04-01T13:00:00Z',
  submitted_at: '2026-04-01T13:00:00Z',
  alpaca_order_id: 'order-1',
  closed_at: '2026-04-15T20:00:00Z',
  alpaca_close_order_id: null,
  closed_by: 'assigned',
  closed_avg_price: 0,
  realized_pnl: 50,
  modify_history: [],
  tags: ['wheel'],
  entry_grade: 'B',
  entry_reasoning: 'wheel sell',
  greeks_at_entry: null,
  rule_warnings_at_entry: [],
  exposure_at_submit: 1200,
  schema: 1,
};

describe('grade-open-trades — assignment drain (M5.2)', () => {
  beforeEach(() => {
    kvGet.mockReset();
    kvSet.mockClear();
    kvRpush.mockClear();
    kvLrem.mockClear();
    kvLrange.mockReset();
    kvIncr.mockReset();
    kvIncr.mockResolvedValue(1);
    process.env.CRON_TOKEN = 'tok';
  });

  it('drain creates a linked stock trade with parent_id + inherited grades', async () => {
    // Upstash returns parsed objects on lrange — see assignment-spawn.ts.
    const pendingEntry = {
      parent_trade_id: parentPut.id,
      underlying: 'F',
      strike: 12,
      qty: 100,
      account: 'conservative_paper',
      detected_at: '2026-04-15T20:00:00Z',
    };

    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return [];
      if (k === 'trades:index:assignments-pending') return [pendingEntry];
      return [];
    });
    kvGet.mockImplementation(async (k: string) => {
      if (k === `trade:${parentPut.id}`) return parentPut;
      if (k === `grade:${parentPut.id}`) {
        return { trade_id: parentPut.id, hindsight: { letter: 'B+', review: 'r' } };
      }
      if (k === `assignment-child:${parentPut.id}`) return null;     // no child yet
      return null;
    });

    const handler = (await import('../../api/cron/[job]')).default;
    const req: any = { method: 'GET', query: { job: 'grade-open-trades' }, headers: { authorization: 'Bearer tok' } };
    const res = mkRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // A new trade record was written (any key starting with `trade:T-` other than the parent)
    const newTradeWrite = kvSet.mock.calls.find((c: any) =>
      typeof c[0] === 'string' && c[0].startsWith('trade:T-') && c[0] !== `trade:${parentPut.id}`,
    );
    expect(newTradeWrite).toBeDefined();
    const newTrade = newTradeWrite![1];
    expect(newTrade.parent_id).toBe(parentPut.id);
    expect(newTrade.source).toBe('assignment');
    expect(newTrade.asset_class).toBe('stock');
    expect(newTrade.symbol).toBe('F');
    expect(newTrade.qty).toBe(100);
    expect(newTrade.filled_avg_price).toBe(12);
    expect(newTrade.entry_grade).toBe('B');
    expect(newTrade.ai_grade_inherited).toBe(true);
    expect(newTrade.tags).toEqual(['wheel']);

    // Mapping written so a future drain doesn't double-spawn
    expect(kvSet).toHaveBeenCalledWith(
      `assignment-child:${parentPut.id}`,
      expect.any(String),
    );

    // Removed from pending
    expect(kvLrem).toHaveBeenCalledWith(
      'trades:index:assignments-pending', 1, pendingEntry,
    );

    // Added to open + month indexes
    expect(kvRpush).toHaveBeenCalledWith('trades:index:open', expect.any(String));
  });

  it('drain is idempotent — does not spawn a second child for same parent', async () => {
    const pendingEntry = {
      parent_trade_id: parentPut.id,
      underlying: 'F', strike: 12, qty: 100,
      account: 'conservative_paper',
      detected_at: '2026-04-15T20:00:00Z',
    };

    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return [];
      if (k === 'trades:index:assignments-pending') return [pendingEntry];
      return [];
    });
    // assignment-child:* already maps to an existing trade — drain should skip
    kvGet.mockImplementation(async (k: string) => {
      if (k === `trade:${parentPut.id}`) return parentPut;
      if (k === `assignment-child:${parentPut.id}`) return 'T-2026-04-15-002';
      return null;
    });

    const handler = (await import('../../api/cron/[job]')).default;
    const req: any = { method: 'GET', query: { job: 'grade-open-trades' }, headers: { authorization: 'Bearer tok' } };
    const res = mkRes();
    await handler(req, res);

    // No new trade record written
    const newTradeWrites = kvSet.mock.calls.filter((c: any) =>
      typeof c[0] === 'string' && c[0].startsWith('trade:T-') && c[0] !== `trade:${parentPut.id}`,
    );
    expect(newTradeWrites).toHaveLength(0);

    // But the entry is removed from pending (idempotent cleanup)
    expect(kvLrem).toHaveBeenCalled();
  });

  it('drain skips entries when parent trade is missing', async () => {
    const pendingEntry = {
      parent_trade_id: 'T-missing',
      underlying: 'F', strike: 12, qty: 100,
      account: 'conservative_paper',
      detected_at: '2026-04-15T20:00:00Z',
    };
    kvLrange.mockImplementation(async (k: string) => {
      if (k === 'trades:index:open') return [];
      if (k === 'trades:index:assignments-pending') return [pendingEntry];
      return [];
    });
    kvGet.mockResolvedValue(null);   // no parent trade

    const handler = (await import('../../api/cron/[job]')).default;
    const req: any = { method: 'GET', query: { job: 'grade-open-trades' }, headers: { authorization: 'Bearer tok' } };
    const res = mkRes();
    await handler(req, res);

    const newTradeWrites = kvSet.mock.calls.filter((c: any) =>
      typeof c[0] === 'string' && c[0].startsWith('trade:T-'),
    );
    expect(newTradeWrites).toHaveLength(0);
    expect(kvLrem).toHaveBeenCalled();   // still removed from pending
  });
});
