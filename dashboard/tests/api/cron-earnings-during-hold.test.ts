// Cron populates trade.earnings_during_hold on first close transition.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrange = vi.fn();
const kvLrem = vi.fn();
const kvRpush = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
const alpacaTradeMock = vi.fn();
const fetchEarningsDatesMock = vi.fn();

vi.mock('../../api/_lib/kv', () => ({
  kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem, rpush: kvRpush }),
}));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
  alpacaTrade: (...a: any[]) => alpacaTradeMock(...a),
}));
vi.mock('../../api/_lib/fundamentals-fetch', async () => {
  const actual = await vi.importActual<any>('../../api/_lib/fundamentals-fetch');
  return {
    ...actual,
    fetchEarningsDates: (...a: any[]) => fetchEarningsDatesMock(...a),
  };
});

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset(); kvRpush.mockReset();
  gradeMock.mockReset(); dataMock.mockReset(); alpacaTradeMock.mockReset();
  fetchEarningsDatesMock.mockReset();
  process.env.CRON_TOKEN = 'cron-token';
  // Freeze the clock before the test option's 2026-06-20 expiry. Without this,
  // once the real date passes 2026-06-20 the option reads as past-expiry and
  // detectClose Path 2 (settlement) pre-empts the external-close path this suite
  // exercises — a date-sensitive failure unrelated to the code under test.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function mockReq(): VercelRequest {
  return {
    method: 'POST',
    query: { job: 'grade-open-trades' },
    headers: { authorization: 'Bearer cron-token' },
  } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function makeTrade(overrides: any = {}) {
  return {
    id: 'T-2026-05-14-001', account: 'manual_paper',
    asset_class: 'option', symbol: 'AAPL',
    side: 'STO', qty: 1,
    contract_symbol: 'AAPL260620C00200000',
    strike: 200, expiration: '2026-06-20', contract_type: 'call',
    filled_avg_price: 3.50, filled_at: '2026-05-01T14:00:00Z',
    alpaca_order_id: 'open-1', alpaca_close_order_id: null,
    submitted_at: '2026-05-01T14:00:00Z', closed_at: null,
    realized_pnl: null, closed_avg_price: null, closed_by: null,
    entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
    modify_history: [{
      ts: 'x', prev_order_id: 'x', new_order_id: 'x',
      limit_price: null, stop_price: null, source: 'dashboard' as const,
    }],
    schema: 1,
    ...overrides,
  };
}

function wireClosedByActivity(trade: any, closePx: string, closeTs: string) {
  alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
    if (path.includes('/v2/positions/')) {
      return Promise.reject(new Error('alpaca trade 404 on /v2/positions: position not found'));
    }
    if (path.includes('/v2/account/activities')) {
      return Promise.resolve([
        {
          id: 'fill-c', activity_type: 'FILL',
          transaction_time: closeTs,
          symbol: trade.contract_symbol, side: 'buy',
          price: closePx, qty: String(trade.qty), order_id: 'btc-1',
        },
      ]);
    }
    return Promise.resolve(null);
  });
}

describe('cron earnings_during_hold population', () => {
  it('sets earnings_during_hold=true when an earnings date falls inside the hold window', async () => {
    const trade = makeTrade();
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });
    wireClosedByActivity(trade, '1.50', '2026-05-20T15:00:00Z');
    fetchEarningsDatesMock.mockResolvedValue([{ date: '2026-05-10T20:00:00Z' }]);
    dataMock.mockResolvedValue({ bars: { AAPL: [] } });
    gradeMock.mockResolvedValue({
      letter: 'A', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      earnings_during_hold: true,
      closed_by: 'bot_external',
    }));
  });

  it('sets earnings_during_hold=false when no earnings date in window', async () => {
    const trade = makeTrade();
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });
    wireClosedByActivity(trade, '1.50', '2026-05-20T15:00:00Z');
    fetchEarningsDatesMock.mockResolvedValue([{ date: '2026-08-01T20:00:00Z' }]);
    dataMock.mockResolvedValue({ bars: { AAPL: [] } });
    gradeMock.mockResolvedValue({
      letter: 'A', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      earnings_during_hold: false,
      closed_by: 'bot_external',
    }));
  });

  it('defaults earnings_during_hold to false when fundamentals-fetch throws', async () => {
    const trade = makeTrade();
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({
        trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' },
        hindsight: null, history: [],
      });
      return Promise.resolve(null);
    });
    wireClosedByActivity(trade, '1.50', '2026-05-20T15:00:00Z');
    fetchEarningsDatesMock.mockRejectedValue(new Error('boom'));
    dataMock.mockResolvedValue({ bars: { AAPL: [] } });
    gradeMock.mockResolvedValue({
      letter: 'A', review: 'r', calibration: 'matched',
      tendencies_hit: [], model: 's',
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now',
    });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq(), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      earnings_during_hold: false,
      closed_by: 'bot_external',
    }));
  });
});
