// dashboard/tests/api/trades-exit-plan.test.ts — optional stop/target on stock trades (2026-11-03)
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvIncr = vi.fn();
const kvLpush = vi.fn();
const kvRpush = vi.fn();
const ruleCheckMock = vi.fn();
const dataMock = vi.fn();
const verifyTotpMock = vi.fn();
const alpacaTradeMutationMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, incr: kvIncr, lpush: kvLpush, rpush: kvRpush, sadd: vi.fn(), lrange: vi.fn(), lrem: vi.fn() }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({
  runStubRuleChecks: (...a: any[]) => ruleCheckMock(...a),
  runRuleChecks: (...a: any[]) => ruleCheckMock(...a),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
  alpacaTrade: vi.fn().mockResolvedValue([]),
  alpacaTradeMutation: (...a: any[]) => alpacaTradeMutationMock(...a),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: (...a: any[]) => verifyTotpMock(...a) }));
vi.mock('../../api/_lib/alpaca', () => ({
  modeFromQuery: () => 'manual',
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvIncr.mockReset(); kvLpush.mockReset(); kvRpush.mockReset();
  ruleCheckMock.mockReset(); dataMock.mockReset(); verifyTotpMock.mockReset();
  alpacaTradeMutationMock.mockReset();
  process.env.TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  delete process.env.LIVE_ENABLED;
});

function mockReq(body?: any): VercelRequest {
  return { method: 'POST', query: { action: 'submit' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

const base = {
  account: 'manual_paper', asset_class: 'stock', symbol: 'CMG',
  side: 'buy', qty: 4, order_type: 'limit', limit_price: 32.95,
  tif: 'day', entry_grade: 'C+', entry_reasoning: 'bounce off support', tags: [],
};

function ready() {
  kvGet.mockImplementation((k: string) =>
    k === 'config:totp_thresholds' ? Promise.resolve({ manual_paper: 100000, live: 100000 }) : Promise.resolve(null));
  ruleCheckMock.mockResolvedValue([]);
  dataMock.mockResolvedValue({ CMG: { latestQuote: { ap: 32.95, bp: 32.90 } } });
  kvIncr.mockResolvedValue(1);
  alpacaTradeMutationMock.mockResolvedValue({ id: 'alp-cmg', submitted_at: '2026-09-23T18:37:00Z' });
  kvSet.mockResolvedValue('OK');
}

async function submit(body: any) {
  const handler = (await import('../../api/trades/[action]')).default;
  const res = mockRes();
  await handler(mockReq(body), res);
  return res;
}

function savedTrade() {
  const call = kvSet.mock.calls.find((c: any[]) => String(c[0]).startsWith('trade:'));
  return call?.[1];
}

describe('exit plan on stock orders', () => {
  it('saves your stop and target on the trade record', async () => {
    ready();
    const res = await submit({ ...base, planned_stop: 29, planned_target: 40 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(savedTrade()).toEqual(expect.objectContaining({ planned_stop: 29, planned_target: 40 }));
  });

  it('is optional — no plan saves nulls and still submits', async () => {
    ready();
    const res = await submit(base);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(savedTrade()).toEqual(expect.objectContaining({ planned_stop: null, planned_target: null }));
  });

  it('only the stop, no target, is fine', async () => {
    ready();
    const res = await submit({ ...base, planned_stop: 29 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(savedTrade()).toEqual(expect.objectContaining({ planned_stop: 29, planned_target: null }));
  });

  it('rejects a stop at or above the target on a buy', async () => {
    ready();
    const res = await submit({ ...base, planned_stop: 40, planned_target: 29 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as any).mock.calls[0][0].validation_errors).toContain('planned_stop_must_be_below_target');
    expect(alpacaTradeMutationMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive stop', async () => {
    ready();
    const res = await submit({ ...base, planned_stop: 0 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as any).mock.calls[0][0].validation_errors).toContain('planned_stop_invalid');
  });

  it('never places an order at the planned prices (plan is not an order)', async () => {
    ready();
    await submit({ ...base, planned_stop: 29, planned_target: 40 });
    expect(alpacaTradeMutationMock).toHaveBeenCalledTimes(1);
    const body = alpacaTradeMutationMock.mock.calls[0][2].body;
    expect(JSON.stringify(body)).not.toContain('29');
    expect(JSON.stringify(body)).not.toContain('"40');
  });
});
