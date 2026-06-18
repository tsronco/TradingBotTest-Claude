// dashboard/tests/api/trades-delete.test.ts
//
// Covers POST /api/trades?action=delete — permanent trade deletion used to
// clean up duplicates / bad imports. Asserts index + record scrubbing.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrem = vi.fn();
const kvDel = vi.fn();

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({
    get: kvGet, set: kvSet, lrem: kvLrem, del: kvDel,
    incr: vi.fn(), rpush: vi.fn(), lrange: vi.fn(),
  }),
}));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/rule-check', () => ({
  runStubRuleChecks: vi.fn().mockResolvedValue([]),
  runRuleChecks: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: vi.fn(), alpacaTrade: vi.fn(), alpacaTradeMutation: vi.fn(),
}));
vi.mock('../../api/_lib/totp', () => ({ verifyTotp: vi.fn(() => true) }));
vi.mock('../../api/_lib/alpaca', () => ({
  alpacaFor: () => ({ createOrder: vi.fn() }),
  modeFromQuery: () => 'conservative',
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: vi.fn() }));
vi.mock('../../api/cron/[job]', () => ({ runGradeOpenTrades: vi.fn() }));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvLrem.mockReset(); kvDel.mockReset();
  kvLrem.mockResolvedValue(1); kvDel.mockResolvedValue(1); kvSet.mockResolvedValue('OK');
});

function mockReq(body: any): VercelRequest {
  return { method: 'POST', query: { action: 'delete' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/delete', () => {
  it('scrubs a trade from open + month indexes, drops records, returns 200', async () => {
    const id = 'T-2026-06-17-030';
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${id}`) return Promise.resolve({ id, account: 'manual_paper', asset_class: 'spread' });
      if (k === 'trades:index:needs_grade') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ id }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, deleted: id });
    // open index + this month's index both scrubbed
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, id);
    expect(kvLrem).toHaveBeenCalledWith('trades:index:2026-06', 0, id);
    // trade + grade records dropped
    expect(kvDel).toHaveBeenCalledWith(`trade:${id}`);
    expect(kvDel).toHaveBeenCalledWith(`grade:${id}`);
  });

  it('also removes the id from the needs-grade queue when present', async () => {
    const id = 'T-2026-06-17-030';
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${id}`) return Promise.resolve({ id, account: 'manual_paper' });
      if (k === 'trades:index:needs_grade') return Promise.resolve([id, 'T-2026-06-17-031']);
      return Promise.resolve(null);
    });

    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ id }), res);

    expect(kvSet).toHaveBeenCalledWith('trades:index:needs_grade', ['T-2026-06-17-031']);
  });

  it('returns 404 when the trade does not exist', async () => {
    kvGet.mockResolvedValue(null);
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ id: 'T-2026-06-17-999' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(kvDel).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed trade id', async () => {
    const mod = await import('../../api/trades/[action]');
    const res = mockRes() as VercelResponse;
    await mod.default(mockReq({ id: 'not-a-trade-id' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(kvDel).not.toHaveBeenCalled();
  });
});
