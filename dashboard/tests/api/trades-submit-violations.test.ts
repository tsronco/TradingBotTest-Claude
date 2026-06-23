import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn().mockReturnValue({ user: 'tim' });
vi.mock('../../api/_lib/auth-guard', () => ({ requireAuth, getSession: vi.fn() }));

const runRuleChecks = vi.fn().mockResolvedValue([]);
vi.mock('../../api/_lib/rule-check', () => ({
  runRuleChecks,
  runStubRuleChecks: runRuleChecks,
}));

const alpacaTradeMutation = vi.fn().mockResolvedValue({
  id: 'order-1',
  status: 'accepted',
  submitted_at: '2026-05-09T12:00:00Z',
  filled_at: null,
  filled_avg_price: null,
});
const alpacaTrade = vi.fn().mockResolvedValue([]);
const alpacaData = vi.fn().mockResolvedValue({
  snapshot: { latestQuote: { ap: 12.10, bp: 12.05 } },
});
vi.mock('../../api/_lib/data-api', () => ({
  alpacaTrade, alpacaTradeMutation, alpacaData,
}));

vi.mock('../../api/_lib/alpaca', () => ({}));

const kvGet = vi.fn();
const kvSet = vi.fn().mockResolvedValue('OK');
const kvIncr = vi.fn().mockResolvedValue(1);
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, incr: kvIncr, rpush: vi.fn() }),
}));

vi.mock('../../api/_lib/grading', () => ({
  gradeTrade: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../api/_lib/totp', () => ({
  verifyTotp: vi.fn().mockReturnValue(true),
}));

vi.mock('../../api/_lib/exposure', () => ({
  computeExposure: vi.fn().mockReturnValue(500),
}));

function mkRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

const goodDraft = {
  account: 'conservative_paper',
  asset_class: 'stock',
  symbol: 'F',
  side: 'buy',
  qty: 10,
  order_type: 'market',
  limit_price: null,
  tif: 'day',
  contract_symbol: null,
  strike: null,
  expiration: null,
  contract_type: null,
  greeks_at_entry: null,
  entry_grade: 'B',
  entry_reasoning: 'because reasons',
  tags: [],
};

describe('trades/submit — rule_violations handling', () => {
  beforeEach(() => {
    runRuleChecks.mockReset(); runRuleChecks.mockResolvedValue([]);
    kvGet.mockReset();
    kvSet.mockClear();
  });

  it('persists server-computed warn-only violations to rule_warnings_at_entry', async () => {
    runRuleChecks.mockResolvedValueOnce([
      { rule: 'r-1', severity: 'warn', message: 'large size' },
    ]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'submit' },
      body: { ...goodDraft, rule_violations: [] },
    };
    const res = mkRes();
    await handler(req, res);
    const tradeWritten = kvSet.mock.calls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith('trade:'))?.[1];
    expect(tradeWritten).toBeDefined();
    expect(tradeWritten.rule_warnings_at_entry).toHaveLength(1);
    expect(tradeWritten.rule_warnings_at_entry[0].severity).toBe('warn');
  });

  it('rejects with 400 when block-severity violation has no matching override_reason', async () => {
    runRuleChecks.mockResolvedValueOnce([
      { rule: 'r-block', severity: 'block', message: 'No earnings' },
    ]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'submit' },
      body: { ...goodDraft, rule_violations: [] },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);  });

  it('rejects with 400 when override_reason is shorter than 20 chars', async () => {
    runRuleChecks.mockResolvedValueOnce([
      { rule: 'r-block', severity: 'block', message: 'No earnings' },
    ]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'submit' },
      body: {
        ...goodDraft,
        rule_violations: [
          { rule: 'r-block', severity: 'block', override_reason: 'too short' },
        ],
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);  });

  it('accepts block-severity with valid override_reason and persists it on trade record', async () => {
    runRuleChecks.mockResolvedValueOnce([
      { rule: 'r-block', severity: 'block', message: 'No earnings' },
    ]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'submit' },
      body: {
        ...goodDraft,
        rule_violations: [
          { rule: 'r-block', severity: 'block',
            override_reason: 'IV crush already priced in based on last 4 cycles' },
        ],
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(400);
    const tradeWritten = kvSet.mock.calls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith('trade:'))?.[1];
    expect(tradeWritten.rule_warnings_at_entry).toHaveLength(1);
    expect(tradeWritten.rule_warnings_at_entry[0].rule).toBe('r-block');
    expect(tradeWritten.rule_warnings_at_entry[0].override_reason)
      .toBe('IV crush already priced in based on last 4 cycles');
  });

  it('drops override_reason for rules that no longer fire server-side', async () => {
    runRuleChecks.mockResolvedValueOnce([]);
    const handler = (await import('../../api/trades/[action]')).default;
    const req: any = {
      method: 'POST', query: { action: 'submit' },
      body: {
        ...goodDraft,
        rule_violations: [
          { rule: 'r-stale', severity: 'block',
            override_reason: 'override for a rule that no longer fires server-side' },
        ],
      },
    };
    const res = mkRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(400);
    const tradeWritten = kvSet.mock.calls.find((c: any) => typeof c[0] === 'string' && c[0].startsWith('trade:'))?.[1];
    expect(tradeWritten.rule_warnings_at_entry).toEqual([]);
  });
});
