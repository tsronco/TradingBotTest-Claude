import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
// D4: readMonthIndex now calls lrange for trades:index:YYYY-MM keys.
// Route lrange for month-index keys through kvGet so existing test data works.
const kvLrange = vi.fn(async (k: string) => {
  if (/^trades:index:\d{4}-\d{2}$/.test(k)) {
    const val = await kvGet(k);
    return Array.isArray(val) ? val : [];
  }
  return [];
});
const kvLrem = vi.fn().mockResolvedValue(1);
const kvRpush = vi.fn().mockResolvedValue(1);
const kvDel = vi.fn().mockResolvedValue(1);
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem, rpush: kvRpush, del: kvDel }),
}));

const proposeNewRule = vi.fn();
vi.mock('../../api/_lib/proposal-prompts', () => ({
  proposeNewRule,
  proposeDemote: vi.fn(),
}));

vi.mock('../../api/_lib/grading', () => ({
  gradeTrade: vi.fn(),
}));

vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade: vi.fn().mockResolvedValue([]),
  alpacaTradeMutation: vi.fn(),
  alpacaData: vi.fn(),
}));

vi.mock('../../api/_lib/alpaca', () => ({}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('cron/detect-tendencies', () => {
  beforeEach(() => {
    kvGet.mockReset(); kvSet.mockClear(); proposeNewRule.mockReset();
    kvLrange.mockReset(); kvDel.mockReset();
    // Re-apply month-index routing after reset
    kvLrange.mockImplementation(async (k: string) => {
      if (/^trades:index:\d{4}-\d{2}$/.test(k)) {
        const val = await kvGet(k);
        return Array.isArray(val) ? val : [];
      }
      return [];
    });
    kvDel.mockResolvedValue(1);
    process.env.CRON_TOKEN = 'tok';
  });

  it('rejects when bearer token is missing or wrong', async () => {
    const handler = (await import('../../api/cron/[job]')).default;
    for (const auth of ['', 'Bearer wrong', 'wrong-format']) {
      const req: any = { method: 'POST', query: { job: 'detect-tendencies' }, headers: { authorization: auth } };
      const res = mkRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('runs matchers and writes findings to rules:tendencies even with no proposals', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [];
      if (k === 'rules:manual') return [];
      if (k === 'rules:tendencies') return [];
      if (k.startsWith('trades:index:')) return [];
      return null;
    });
    const handler = (await import('../../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'detect-tendencies' }, headers: { authorization: 'Bearer tok' } };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    // tendencies write happens (even if empty list)
    expect(kvSet).toHaveBeenCalledWith('rules:tendencies', expect.any(Array));
    const body = (res.json as any).mock.calls[0][0];
    expect(body.findings_count).toBe(0);
    expect(body.proposals_appended).toBe(0);
  });

  it('generates proposals for actionable findings and writes to rules:proposals', async () => {
    const recentMonth = (() => {
      const d = new Date();
      return `trades:index:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })();
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [];
      if (k === 'rules:manual') return [];
      if (k === 'rules:tendencies') return [];
      if (k === 'trades:index:open') return [];
      if (k === recentMonth) return ['t1', 't2', 't3'];
      if (k.startsWith('trades:index:') && k !== 'trades:index:assignments-pending') {
        return [];
      }
      if (k.startsWith('trade:t')) {
        return {
          id: k.split(':')[1],
          symbol: 'F',
          asset_class: 'option',
          contract_type: 'put',
          side: 'STO',
          closed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
          realized_pnl: -100,
          entry_grade: 'B',
          tags: [],
          rule_warnings_at_entry: [],
          strike: 12,
          expiration: '2026-04-15',
        };
      }
      if (k.startsWith('grade:')) return null;
      return null;
    });
    proposeNewRule.mockResolvedValue({
      id: 'p-new',
      matcher: 'loss_concentration_by_symbol',
      proposed_rule: { title: 'No F', body: 'stop F', severity: 'warn', triggers: [] },
      reasoning: 'r',
      evidence_trade_ids: ['t1', 't2', 't3'],
      status: 'open',
      proposed_at: '2026-05-09T00:00:00Z',
    });

    const handler = (await import('../../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'detect-tendencies' }, headers: { authorization: 'Bearer tok' } };
    const res = mkRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(kvSet).toHaveBeenCalledWith('rules:tendencies', expect.any(Array));
    expect(kvSet).toHaveBeenCalledWith('rules:proposals', expect.any(Array));
    expect(proposeNewRule).toHaveBeenCalled();
    const body = (res.json as any).mock.calls[0][0];
    expect(body.findings_count).toBeGreaterThanOrEqual(1);
    expect(body.proposals_appended).toBeGreaterThanOrEqual(1);
  });

  it('does not re-propose a finding that already has an open proposal', async () => {
    const existingProposal = {
      id: 'p-existing',
      matcher: 'loss_concentration_by_symbol',
      proposed_rule: { title: 'x', body: 'y', severity: 'warn' as const,
                        triggers: [{ type: 'symbol_in' as const, symbols: ['F'] }] },
      reasoning: 'r',
      evidence_trade_ids: ['t1'],
      status: 'open' as const,
      proposed_at: '2026-04-01T00:00:00Z',
    };
    // Use a recent month key so we only get 3 trades total (under the
    // 5-trade threshold for the loss_concentration_by_side matcher).
    const recentMonth = (() => {
      const d = new Date();
      return `trades:index:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })();
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'rules:proposals') return [existingProposal];
      if (k === 'rules:manual') return [];
      if (k === 'rules:tendencies') return [];
      if (k === 'trades:index:open') return [];
      if (k === recentMonth) return ['t1', 't2', 't3'];
      if (k.startsWith('trades:index:')) return [];
      if (k.startsWith('trade:t')) {
        return {
          id: k.split(':')[1], symbol: 'F', asset_class: 'option',
          contract_type: 'put', side: 'STO',
          closed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
          realized_pnl: -100, entry_grade: 'B', tags: [], rule_warnings_at_entry: [],
          strike: 12, expiration: '2026-04-15',
        };
      }
      return null;
    });
    proposeNewRule.mockResolvedValue({});  // shouldn't be called

    const handler = (await import('../../api/cron/[job]')).default;
    const req: any = { method: 'POST', query: { job: 'detect-tendencies' }, headers: { authorization: 'Bearer tok' } };
    const res = mkRes();
    await handler(req, res);

    expect(proposeNewRule).not.toHaveBeenCalled();
    const body = (res.json as any).mock.calls[0][0];
    expect(body.proposals_appended).toBe(0);
  });
});
