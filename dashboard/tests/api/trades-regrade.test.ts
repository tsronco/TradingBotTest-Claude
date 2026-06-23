// dashboard/tests/api/trades-regrade.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, incr: vi.fn() }) }));
vi.mock('../../api/_lib/auth-guard', () => ({
  requireAuth: vi.fn(() => ({ logged_in_at: 0, last_active: 0 })),
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({ alpacaData: (...a: any[]) => dataMock(...a) }));

beforeEach(() => { kvGet.mockReset(); kvSet.mockReset(); gradeMock.mockReset(); dataMock.mockReset(); });

function mockReq(body: any): VercelRequest {
  return { method: 'POST', query: { action: 'regrade' }, body, headers: {} } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/trades/regrade', () => {
  it('snapshots current hindsight to history before writing fresh', async () => {
    // Using manual_paper — regrade is only allowed on gradeable accounts (manual + live).
    // conservative_paper now returns 403 per the isGradeable gate.
    const trade = { id: 'T-2026-05-04-001', symbol: 'TSLA', account: 'manual_paper', filled_at: '2026-05-04T13:30Z', closed_at: '2026-05-04T20:00Z' } as any;
    const oldGrade = {
      trade_id: 'T-2026-05-04-001',
      entry: { letter: 'A', reasoning: 'r', ts: 'now' },
      hindsight: { letter: 'B+', review: 'old', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'old-ts' },
      history: [],
    };
    kvGet.mockImplementation((k: string) => {
      if (k.startsWith('trade:')) return Promise.resolve(trade);
      if (k.startsWith('grade:')) return Promise.resolve(oldGrade);
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: [] });
    gradeMock.mockResolvedValue({ letter: 'A-', review: 'fresh', calibration: 'matched', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 }, ts: 'new-ts' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ id: 'T-2026-05-04-001' }), res);
    expect(kvSet).toHaveBeenCalledWith(
      'grade:T-2026-05-04-001',
      expect.objectContaining({
        history: expect.arrayContaining([expect.objectContaining({ hindsight: expect.objectContaining({ letter: 'B+' }) })]),
        hindsight: expect.objectContaining({ letter: 'A-' }),
      })
    );
  });

  it('returns 404 when trade not found', async () => {
    kvGet.mockResolvedValue(null);
    const handler = (await import('../../api/trades/[action]')).default;
    const res = mockRes();
    await handler(mockReq({ id: 'missing' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
