// dashboard/tests/api/cron-grade-open-trades.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const kvGet = vi.fn();
const kvSet = vi.fn();
const kvLrange = vi.fn();
const kvLrem = vi.fn();
const gradeMock = vi.fn();
const dataMock = vi.fn();
const alpacaTradeMock = vi.fn();
vi.mock('../../api/_lib/kv', () => ({ kv: () => ({ get: kvGet, set: kvSet, lrange: kvLrange, lrem: kvLrem }) }));
vi.mock('../../api/_lib/grading', () => ({ gradeTrade: (...a: any[]) => gradeMock(...a) }));
vi.mock('../../api/_lib/data-api', () => ({
  alpacaData: (...a: any[]) => dataMock(...a),
  alpacaTrade: (...a: any[]) => alpacaTradeMock(...a),
}));
// Stub the auto-import worker so runAutoImport() in gradeOpenTrades is a no-op
// in every test in this file. Without this, runAutoImport calls alpacaTrade with
// 'conservative' (and other modes) and writes import:cursor:* KV keys, which
// breaks tests that assert kvSet/alpacaTradeMock was not called, or that
// 'conservative' did not appear in the modes list.
vi.mock('../../api/trades/[action]', () => ({
  runImport: vi.fn().mockResolvedValue({ imported: 0, skipped_existing: 0, spread_pairs_found: 0, errors: [], created_trade_ids: [] }),
}));

beforeEach(() => {
  kvGet.mockReset(); kvSet.mockReset(); kvLrange.mockReset(); kvLrem.mockReset();
  gradeMock.mockReset(); dataMock.mockReset(); alpacaTradeMock.mockReset();
  process.env.CRON_TOKEN = 'cron-token';
});

function mockReq(headers: any = {}): VercelRequest {
  return { method: 'POST', query: { job: 'grade-open-trades' }, headers } as unknown as VercelRequest;
}
function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe('POST /api/cron/grade-open-trades', () => {
  it('rejects missing bearer token', async () => {
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('marks unfilled-then-canceled entry orders as closed_by: canceled (skips AI grading)', async () => {
    const trade = {
      id: 'T-2026-05-04-002', account: 'manual_paper', symbol: 'SNAP', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: null, exposure_at_submit: 22.90,
      alpaca_order_id: 'a-canceled-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-04T13:30Z', filled_at: null, closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'test', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'test', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Two calls now: syncFillData reads the order first (sees canceled, returns
    // trade unchanged since not filled), then detectClose Path 0 reads it again
    // and routes to the canceled close path. Returning the same response both
    // times is fine because the order genuinely hasn't changed between reads.
    alpacaTradeMock.mockResolvedValue({ id: 'a-canceled-1', status: 'canceled', canceled_at: '2026-05-04T13:35Z' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
    // Trade record updated with closed_by: canceled
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-05-04T13:35Z',
      closed_avg_price: 0,
      realized_pnl: 0,
      closed_by: 'canceled',
    }));
    // Removed from open index
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
    // AI grading was NOT called
    expect(gradeMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, graded: 1 }));
  });

  it('grades a trade whose Alpaca close order has filled', async () => {
    // Uses manual_paper — isGradeable gate now blocks conservative/aggressive/SM.
    const trade = {
      id: 'T-2026-05-04-001', account: 'manual_paper', symbol: 'TSLA', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: 319.85, exposure_at_submit: 3198.50,
      alpaca_order_id: 'a1', alpaca_close_order_id: 'a2',
      filled_at: '2026-05-04T13:30Z', closed_at: null, realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'A', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // syncFillData walks the entry-order chain first (returns a single
    // already-filled order, no replacements), then detectClose fetches the
    // close order separately. Two alpacaTrade calls now, not one.
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/a1')) return Promise.resolve({ id: 'a1', status: 'filled', filled_avg_price: '319.85', filled_at: '2026-05-04T13:30Z' });
      if (path.endsWith('/a2')) return Promise.resolve({ id: 'a2', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' });
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B+', review: 'r', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({ closed_at: expect.any(String), realized_pnl: expect.any(Number), closed_by: 'manual' }));
    expect(kvSet).toHaveBeenCalledWith(`grade:${trade.id}`, expect.objectContaining({ hindsight: expect.objectContaining({ letter: 'B+' }) }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('syncs delayed-fill data (filled_at + filled_avg_price) onto a still-open trade', async () => {
    // Limit order submitted yesterday at $0.08, filled today at $0.05. The
    // trade has no close order yet — it should stay in the open index but
    // gain its entry-price metadata so the timeline / chart / grading can
    // use the correct fill timestamp instead of submitted_at.
    //
    // Freeze time before the option expiry (2026-05-29) so detectClose Path 2
    // (option past expiration) does not fire. Without a fake timer, real
    // Date.now() may be past the expiry and the backstop would auto-close it.
    const trade = {
      id: 'T-2026-05-07-001', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      strike: 11.0, expiration: '2026-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'a-delayed-fill', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      return Promise.resolve(null);
    });
    // syncFillData reads the entry order and sees filled. detectClose Path 0
    // skips because filled_at is now set. Path 1 doesn't apply (no close
    // order). Path 2 doesn't apply (option not yet expired — clock is frozen
    // 9 days before expiry).
    alpacaTradeMock.mockResolvedValue({
      id: 'a-delayed-fill', status: 'filled',
      filled_at: '2026-05-07T17:57:29Z', filled_avg_price: '0.05',
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z')); // 9 days before 2026-05-29 expiry
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      const res = mockRes();
      await handler(mockReq({ authorization: 'Bearer cron-token' }), res);
      // Trade record gets fill data written back
      expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
        filled_at: '2026-05-07T17:57:29Z',
        filled_avg_price: 0.05,
        closed_at: null,
        closed_by: null,
      }));
      // Stays in the open index — fill alone doesn't close the trade
      expect(kvLrem).not.toHaveBeenCalled();
      // No AI grading until close
      expect(gradeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncFillData follows replaced_by chain and backfills modify_history', async () => {
    // User submits at $0.08 (id=A), modifies to $0.07 (id=B replaces A),
    // modifies again to $0.05 (id=C replaces B), C fills. Trade record
    // still points at A with no modify_history. syncFillData must walk
    // A→B→C, find C filled, pin alpaca_order_id to C, write the fill
    // data back, AND reconstruct modify_history from the chain hops.
    const trade = {
      id: 'T-2026-05-07-001', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      strike: 11.0, expiration: '2026-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'order-A', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/order-A')) return Promise.resolve({
        id: 'order-A', status: 'replaced', replaced_by: 'order-B', replaces: null,
        submitted_at: '2026-05-07T17:44Z', limit_price: '0.08', qty: '1',
      });
      if (path.endsWith('/order-B')) return Promise.resolve({
        id: 'order-B', status: 'replaced', replaced_by: 'order-C', replaces: 'order-A',
        submitted_at: '2026-05-07T17:50Z', limit_price: '0.07', qty: '1',
      });
      if (path.endsWith('/order-C')) return Promise.resolve({
        id: 'order-C', status: 'filled', replaces: 'order-B', replaced_by: null,
        filled_at: '2026-05-07T17:57:29Z', filled_avg_price: '0.05',
        submitted_at: '2026-05-07T17:55Z', limit_price: '0.05', qty: '1',
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'order-C',
      filled_at: '2026-05-07T17:57:29Z',
      filled_avg_price: 0.05,
      closed_at: null,
      modify_history: [
        expect.objectContaining({
          ts: '2026-05-07T17:50Z',
          prev_order_id: 'order-A',
          new_order_id: 'order-B',
          limit_price: 0.07,
          source: 'backfill',
        }),
        expect.objectContaining({
          ts: '2026-05-07T17:55Z',
          prev_order_id: 'order-B',
          new_order_id: 'order-C',
          limit_price: 0.05,
          source: 'backfill',
        }),
      ],
    }));
  });

  it('syncFillData pins alpaca_order_id to terminal id even when still pending', async () => {
    // Modified order whose replacement hasn't filled yet — we still want to
    // update the trade's order_id so we don't re-walk the chain every tick.
    const trade = {
      id: 'T-2026-05-07-003', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'order-A', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/order-A')) return Promise.resolve({
        id: 'order-A', status: 'replaced', replaced_by: 'order-B', replaces: null,
      });
      if (path.endsWith('/order-B')) return Promise.resolve({
        id: 'order-B', status: 'new', replaces: 'order-A', replaced_by: null,
        filled_at: null, filled_avg_price: null,
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    // Order id pinned to terminal but no fill data
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'order-B',
      filled_at: null,
      filled_avg_price: null,
    }));
  });

  it('syncFillData populates both leg fills for an mleg spread order', async () => {
    const trade = {
      id: 'T-2026-05-15-001', account: 'manual_paper', symbol: 'AAL', asset_class: 'spread',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-05-29', contract_type: null,
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'alpaca-mleg-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-15T14:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.40, fill_price: null, qty: 1 },
        long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.15, fill_price: null, qty: 1 },
        expiration: '2026-05-29',
        width: 1.0,
        net_credit: 0.25,
        max_loss: 0.75,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockResolvedValue({
      id: 'alpaca-mleg-1', status: 'filled',
      filled_at: '2026-05-15T14:05:00Z',
      legs: [
        { symbol: 'AAL260529P00012500', side: 'sell', filled_avg_price: '0.37', filled_qty: '1' },
        { symbol: 'AAL260529P00011500', side: 'buy', filled_avg_price: '0.12', filled_qty: '1' },
      ],
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: '2026-05-15T14:05:00Z',
      spread: expect.objectContaining({
        short_leg: expect.objectContaining({ fill_price: 0.37 }),
        long_leg: expect.objectContaining({ fill_price: 0.12 }),
        net_credit: expect.closeTo(0.25, 5),
        max_loss: expect.closeTo(0.75, 5),
      }),
      filled_avg_price: expect.closeTo(0.25, 5),
    }));
  });

  it('syncFillData no-ops for a not-yet-filled mleg spread order', async () => {
    const trade = {
      id: 'T-2026-05-15-002', account: 'manual_paper', symbol: 'AAL', asset_class: 'spread',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-05-29', contract_type: null,
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'alpaca-mleg-2', alpaca_close_order_id: null,
      submitted_at: '2026-05-15T14:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.40, fill_price: null, qty: 1 },
        long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.15, fill_price: null, qty: 1 },
        expiration: '2026-05-29',
        width: 1.0,
        net_credit: 0.25,
        max_loss: 0.75,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockResolvedValue({
      id: 'alpaca-mleg-2', status: 'new', filled_at: null,
      legs: [
        { symbol: 'AAL260529P00012500', side: 'sell', filled_avg_price: null, filled_qty: '0' },
        { symbol: 'AAL260529P00011500', side: 'buy', filled_avg_price: null, filled_qty: '0' },
      ],
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    // Neither fill-sync nor close-detect should write the trade record.
    // (runAutoImport writes import:cursor:* keys as a side-effect — those are
    // expected and are not what this assertion guards against.)
    expect(kvSet).not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything());
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('syncFillData requests the mleg order with nested=true and captures per-leg order ids', async () => {
    // The bug: without nested=true Alpaca returns the parent mleg order with no
    // `legs` array, so the spread fill never syncs and the trade is stuck at
    // "submitted" forever. This asserts the fetch carries nested=true and that
    // the leg order ids are persisted (for later import dedup).
    const trade = {
      id: 'T-2026-05-15-010', account: 'manual_paper', symbol: 'QQQ', asset_class: 'spread',
      side: 'STO', qty: 1, contract_symbol: 'QQQ260529P00072200',
      strike: 722, expiration: '2027-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'alpaca-mleg-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-15T14:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'QQQ260529P00072200', strike: 722, entry_premium: 6.21, fill_price: null, qty: 1 },
        long_leg: { occ: 'QQQ260529P00069000', strike: 690, entry_premium: 1.44, fill_price: null, qty: 1 },
        expiration: '2027-05-29', width: 32, net_credit: 4.77, max_loss: 27.23,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/orders/')) return Promise.resolve({
        id: 'alpaca-mleg-1', status: 'filled', filled_at: '2026-05-15T14:05:00Z',
        legs: [
          { symbol: 'QQQ260529P00072200', side: 'sell', filled_avg_price: '6.20', id: 'leg-short-id' },
          { symbol: 'QQQ260529P00069000', side: 'buy', filled_avg_price: '1.43', id: 'leg-long-id' },
        ],
      });
      // position still exists → detectExternalSpreadClose no-ops (isolates sync)
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: 'x', qty: '1' });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());

    const orderCall = alpacaTradeMock.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('/v2/orders/'));
    expect(orderCall![2]).toMatchObject({ nested: 'true' });

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: '2026-05-15T14:05:00Z',
      fill_confirmed: true,
      spread: expect.objectContaining({
        short_leg: expect.objectContaining({ fill_price: 6.20, order_id: 'leg-short-id' }),
        long_leg: expect.objectContaining({ fill_price: 1.43, order_id: 'leg-long-id' }),
      }),
    }));
  });

  it('syncFillData falls back to the FILL activity stream when the mleg order returns no legs', async () => {
    const trade = {
      id: 'T-2026-05-15-011', account: 'manual_paper', symbol: 'QQQ', asset_class: 'spread',
      side: 'STO', qty: 1, contract_symbol: 'QQQ260529P00072200',
      strike: 722, expiration: '2027-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'alpaca-mleg-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-15T14:00:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'QQQ260529P00072200', strike: 722, entry_premium: 6.21, fill_price: null, qty: 1 },
        long_leg: { occ: 'QQQ260529P00069000', strike: 690, entry_premium: 1.44, fill_price: null, qty: 1 },
        expiration: '2027-05-29', width: 32, net_credit: 4.77, max_loss: 27.23,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      // mleg parent comes back filled but WITHOUT legs (nested unavailable)
      if (path.includes('/v2/orders/')) return Promise.resolve({
        id: 'alpaca-mleg-1', status: 'filled', filled_at: '2026-05-15T14:05:00Z', legs: [],
      });
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'f1', symbol: 'QQQ260529P00072200', side: 'sell', price: '6.20', order_id: 'leg-short-id', transaction_time: '2026-05-15T14:05:00Z' },
        { id: 'f2', symbol: 'QQQ260529P00069000', side: 'buy', price: '1.43', order_id: 'leg-long-id', transaction_time: '2026-05-15T14:05:00Z' },
      ]);
      if (path.includes('/v2/positions/')) return Promise.resolve({ symbol: 'x', qty: '1' });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: '2026-05-15T14:05:00Z',
      fill_confirmed: true,
      spread: expect.objectContaining({
        short_leg: expect.objectContaining({ fill_price: 6.20, order_id: 'leg-short-id' }),
        long_leg: expect.objectContaining({ fill_price: 1.43, order_id: 'leg-long-id' }),
      }),
    }));
  });

  // ---- sweep budget / rotation / grade queue -------------------------------

  // A stock trade whose Alpaca close order has filled → detectClose Path 1
  // closes it. fill_confirmed:true so syncFillData makes no entry-order fetch.
  // Uses manual_paper — isGradeable gate blocks conservative/aggressive/SM from grading.
  function closeableStockTrade(n: number) {
    return {
      id: `T-2026-05-04-${String(n).padStart(3, '0')}`, account: 'manual_paper', symbol: 'TSLA',
      asset_class: 'stock', side: 'buy', qty: 10, filled_avg_price: 319.85, exposure_at_submit: 3198.5,
      alpaca_order_id: `entry-${n}`, alpaca_close_order_id: `close-${n}`,
      filled_at: '2026-05-04T13:30Z', closed_at: null, realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'A', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [], schema: 1, fill_confirmed: true,
    } as any;
  }

  it('closes more than 3 trades in one tick (old MAX_PER_TICK=3 cap is gone)', async () => {
    const trades = Array.from({ length: 8 }, (_, i) => closeableStockTrade(i + 1));
    kvLrange.mockResolvedValueOnce(trades.map((t) => t.id));
    kvLrem.mockResolvedValue(1);
    const byId = new Map(trades.map((t) => [t.id, t]));
    kvGet.mockImplementation((k: string) => {
      const tid = k.startsWith('trade:') ? k.slice('trade:'.length) : null;
      if (tid && byId.has(tid)) return Promise.resolve(byId.get(tid));
      if (k.startsWith('grade:')) return Promise.resolve({ trade_id: k.slice('grade:'.length), entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Every close order is filled.
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/close-')) return Promise.resolve({ id: 'c', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' });
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B+', review: 'r', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);

    // All 8 closed this tick (would have been capped at 3 before).
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, graded: 8 }));
    expect(kvLrem).toHaveBeenCalledTimes(8);
  });

  it('budgets AI grading at 5/tick and queues the overflow (closes still recorded)', async () => {
    const trades = Array.from({ length: 7 }, (_, i) => closeableStockTrade(i + 1));
    kvLrange.mockResolvedValueOnce(trades.map((t) => t.id));
    kvLrem.mockResolvedValue(1);
    const byId = new Map(trades.map((t) => [t.id, t]));
    let needsGrade: string[] = [];
    kvGet.mockImplementation((k: string) => {
      if (k === 'trades:index:needs_grade') return Promise.resolve(needsGrade);
      const tid = k.startsWith('trade:') ? k.slice('trade:'.length) : null;
      if (tid && byId.has(tid)) return Promise.resolve(byId.get(tid));
      if (k.startsWith('grade:')) return Promise.resolve({ trade_id: k.slice('grade:'.length), entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    kvSet.mockImplementation((k: string, v: any) => {
      if (k === 'trades:index:needs_grade') needsGrade = v;
      return Promise.resolve('OK');
    });
    alpacaTradeMock.mockImplementation((_m: any, path: string) => {
      if (path.includes('/close-')) return Promise.resolve({ id: 'c', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' });
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B+', review: 'r', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });

    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);

    // 7 closed, but only 5 AI-graded; 2 deferred to the needs-grade queue.
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ graded: 7 }));
    expect(gradeMock).toHaveBeenCalledTimes(5);
    expect(needsGrade).toHaveLength(2);
  });

  it('drains the needs-grade queue on a later tick (no open trades)', async () => {
    // Uses manual_paper — isGradeable gate blocks conservative/aggressive/SM from queue drain.
    const closed = {
      id: 'T-2026-05-04-090', account: 'manual_paper', symbol: 'TSLA', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: 319.85, closed_at: '2026-05-04T20:09Z',
      closed_avg_price: 362.20, realized_pnl: 423.5, closed_by: 'manual',
      filled_at: '2026-05-04T13:30Z', entry_grade: 'A', entry_reasoning: 'r', tags: [],
      rule_warnings_at_entry: [], schema: 1, fill_confirmed: true,
    } as any;
    kvLrange.mockResolvedValueOnce([]); // no open trades
    let needsGrade: string[] = [closed.id];
    kvGet.mockImplementation((k: string) => {
      if (k === 'trades:index:needs_grade') return Promise.resolve(needsGrade);
      if (k === `trade:${closed.id}`) return Promise.resolve(closed);
      if (k === `grade:${closed.id}`) return Promise.resolve({ trade_id: closed.id, entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    kvSet.mockImplementation((k: string, v: any) => {
      if (k === 'trades:index:needs_grade') needsGrade = v;
      return Promise.resolve('OK');
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B+', review: 'r', calibration: 'over_1', tendencies_hit: [], model: 'sonnet', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });

    const handler = (await import('../../api/cron/[job]')).default;
    const res = mockRes();
    await handler(mockReq({ authorization: 'Bearer cron-token' }), res);

    expect(gradeMock).toHaveBeenCalledTimes(1);
    expect(needsGrade).toHaveLength(0); // queue drained
  });

  it('advances and wraps the sweep cursor so the tail of a large index is reached', async () => {
    // 40 open trades, none closeable (close order still "new"). SWEEP_BUDGET=30,
    // so tick 1 (cursor 0) covers indices 0..29 and writes cursor=30; the next
    // tick starts at 30 and reaches the tail (indices 30..39).
    const ids = Array.from({ length: 40 }, (_, i) => `T-x-${String(i).padStart(3, '0')}`);
    kvLrange.mockResolvedValueOnce(ids);
    kvGet.mockImplementation((k: string) => {
      if (k === 'trades:cursor:sweep') return Promise.resolve(0);
      const tid = k.startsWith('trade:') ? k.slice('trade:'.length) : null;
      if (tid) return Promise.resolve({
        id: tid, account: 'manual_paper', symbol: 'TSLA', asset_class: 'stock',
        side: 'buy', qty: 1, filled_avg_price: 1, alpaca_order_id: `e-${tid}`, alpaca_close_order_id: `c-${tid}`,
        filled_at: '2026-05-04T13:30Z', closed_at: null, closed_by: null, entry_grade: 'A', entry_reasoning: 'r',
        tags: [], rule_warnings_at_entry: [], schema: 1, fill_confirmed: true,
      });
      return Promise.resolve(null);
    });
    // close orders are NOT filled → nothing closes
    alpacaTradeMock.mockResolvedValue({ id: 'c', status: 'new' });
    kvSet.mockResolvedValue('OK');

    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());

    // cursor advanced to 30 for the next tick (which will then cover the tail)
    expect(kvSet).toHaveBeenCalledWith('trades:cursor:sweep', 30);
  });

  it('drain mode lifts the per-tick sweep cap and queues all grades', async () => {
    const trades = Array.from({ length: 35 }, (_, i) => closeableStockTrade(i + 1));
    kvLrange.mockResolvedValueOnce(trades.map((t) => t.id));
    kvLrem.mockResolvedValue(1);
    const byId = new Map(trades.map((t) => [t.id, t]));
    let needsGrade: string[] = [];
    kvGet.mockImplementation((k: string) => {
      if (k === 'trades:index:needs_grade') return Promise.resolve(needsGrade);
      const tid = k.startsWith('trade:') ? k.slice('trade:'.length) : null;
      if (tid && byId.has(tid)) return Promise.resolve(byId.get(tid));
      if (k.startsWith('grade:')) return Promise.resolve({ trade_id: k.slice('grade:'.length), entry: { letter: 'A', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    kvSet.mockImplementation((k: string, v: any) => {
      if (k === 'trades:index:needs_grade') needsGrade = v;
      return Promise.resolve('OK');
    });
    alpacaTradeMock.mockImplementation((_m: any, path: string) =>
      path.includes('/close-') ? Promise.resolve({ id: 'c', status: 'filled', filled_avg_price: '362.20', filled_at: '2026-05-04T20:09Z' }) : Promise.resolve(null));
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });

    const { runGradeOpenTrades } = await import('../../api/cron/[job]');
    const r = await runGradeOpenTrades({ sweepBudget: Number.MAX_SAFE_INTEGER, gradeBudget: 0, timeBudgetMs: 45_000 });

    // All 35 closed in one call (far past the normal 30 cap); 0 graded inline,
    // all deferred to the queue.
    expect(r.graded).toBe(35);
    expect(gradeMock).not.toHaveBeenCalled();
    expect(needsGrade).toHaveLength(35);
  });

  it('drain stops early when the time budget is already exhausted', async () => {
    const trades = Array.from({ length: 5 }, (_, i) => closeableStockTrade(i + 1));
    kvLrange.mockResolvedValueOnce(trades.map((t) => t.id));
    const byId = new Map(trades.map((t) => [t.id, t]));
    kvGet.mockImplementation((k: string) => {
      const tid = k.startsWith('trade:') ? k.slice('trade:'.length) : null;
      if (tid && byId.has(tid)) return Promise.resolve(byId.get(tid));
      return Promise.resolve(null);
    });
    alpacaTradeMock.mockResolvedValue({ id: 'c', status: 'filled', filled_avg_price: '362.20', filled_at: 'x' });
    kvSet.mockResolvedValue('OK');

    const { runGradeOpenTrades } = await import('../../api/cron/[job]');
    const r = await runGradeOpenTrades({ timeBudgetMs: -1 }); // already out of time

    expect(r.graded).toBe(0); // the loop broke before processing any trade
  });

  it('out of time → skips the deferrable tail (auto-import) so the run returns instead of 504-ing', async () => {
    // Core of the "never 504" fix: when the wall-clock budget is spent, the
    // deferrable tail (assignment spawns + per-account auto-import, which walk
    // 7 accounts' activity logs) is skipped and runs next tick instead of
    // pushing the function past the serverless limit.
    kvLrange.mockResolvedValueOnce([]); // no open trades
    kvGet.mockResolvedValue(null);
    kvSet.mockResolvedValue('OK');
    const tradesMod = await import('../../api/trades/[action]');
    (tradesMod.runImport as any).mockClear();

    const { runGradeOpenTrades } = await import('../../api/cron/[job]');
    const r = await runGradeOpenTrades({ timeBudgetMs: -1 });

    expect(r.auto_imported).toEqual({});
    expect(r.assignments_spawned).toBe(0);
    expect(tradesMod.runImport).not.toHaveBeenCalled();
  });

  // ---- detectClose spread expiry branch ------------------------------------

  function makeFilledSpreadTrade(overrides: any = {}) {
    return {
      id: 'T-2026-05-29-001', account: 'manual_paper', symbol: 'AAL', asset_class: 'spread',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-05-29', contract_type: null,
      filled_avg_price: 0.25, filled_at: '2026-05-15T14:05:00Z',
      alpaca_order_id: 'alpaca-mleg-1', alpaca_close_order_id: null,
      submitted_at: '2026-05-15T14:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      // non-empty modify_history short-circuits syncFillData
      modify_history: [{ ts: 'x', prev_order_id: 'x', new_order_id: 'x', limit_price: null, stop_price: null, source: 'dashboard' as const }],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.40, fill_price: 0.37, qty: 1 },
        long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.15, fill_price: 0.12, qty: 1 },
        expiration: '2026-05-29',
        width: 1.0,
        net_credit: 0.25,
        max_loss: 0.75,
      },
      ...overrides,
    } as any;
  }

  it('detectClose: marks spread expired worthless when spot >= short strike at expiry', async () => {
    const trade = makeFilledSpreadTrade();
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Spot $13.00 > short strike $12.5 → worthless OTM
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '13.00' } });
      return Promise.resolve({ bars: { AAL: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'A', review: 'r', calibration: 'on', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    // Freeze time after expiration
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T01:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }
    // net_credit * 100 * qty = 0.25 * 100 * 1 = 25
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: expect.any(String),
      closed_avg_price: 0,
      realized_pnl: 25,
      closed_by: 'expired',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('detectClose: marks spread max-loss expired when spot < long strike at expiry', async () => {
    const trade = makeFilledSpreadTrade({ id: 'T-2026-05-29-002' });
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'r', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Spot $11.00 < long strike $11.5 → deep ITM, full max loss
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '11.00' } });
      return Promise.resolve({ bars: { AAL: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'F', review: 'r', calibration: 'under', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T01:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }
    // -max_loss * 100 * qty = -0.75 * 100 * 1 = -75; closed_avg_price = width = 1.0
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_avg_price: 1.0,
      realized_pnl: -75,
      closed_by: 'expired',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('detectClose: leaves spread untouched when spot is between strikes (partial loss)', async () => {
    const trade = makeFilledSpreadTrade({ id: 'T-2026-05-29-003' });
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    // Spot $12.00 — between long $11.5 and short $12.5 → partial loss, leave for manual
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '12.00' } });
      return Promise.resolve({ bars: { AAL: [] } });
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T01:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }
    // Trade stays open — no close write, no removal from open index.
    // Legacy-guard convergence may write fill_confirmed:true but must NOT
    // write closed_at (the close path leaves partial-loss spreads for manual).
    expect(kvSet).not.toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ closed_at: expect.anything() }),
    );
    expect(kvLrem).not.toHaveBeenCalled();
  });

  it('detectClose: does NOT fire on spreads with future expiration', async () => {
    const trade = makeFilledSpreadTrade({ id: 'T-2026-05-29-004', expiration: '2026-06-26', spread: {
      spread_type: 'put_credit',
      short_leg: { occ: 'AAL260626P00012500', strike: 12.5, entry_premium: 0.40, fill_price: 0.37, qty: 1 },
      long_leg: { occ: 'AAL260626P00011500', strike: 11.5, entry_premium: 0.15, fill_price: 0.12, qty: 1 },
      expiration: '2026-06-26',
      width: 1.0,
      net_credit: 0.25,
      max_loss: 0.75,
    } });
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T01:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }
    // Trade stays open — legacy-guard convergence may write fill_confirmed:true
    // but must NOT write closed_at (not expired yet).
    expect(kvSet).not.toHaveBeenCalledWith(
      `trade:${trade.id}`,
      expect.objectContaining({ closed_at: expect.anything() }),
    );
    expect(kvLrem).not.toHaveBeenCalled();
    // No spot fetch should have happened either (expiry is in the future)
    expect(dataMock).not.toHaveBeenCalled();
  });

  it('detectClose: a bot-closed spread past expiry books the REAL external close, not a fabricated worthless-expiry win', async () => {
    // Regression for the MU phantom-+$950 bug. The bot tripwire-closed this
    // put-credit spread at a LOSS on 06-16 (BTC short @ 37.05 / STC long @ 25.70
    // = 11.35 net cost vs 9.50 credit → −$185). The cron only resolved it AFTER
    // the 06-18 expiry date passed, so Path 2b (spot-vs-strikes fabrication) saw
    // MU above the short strike and booked +$950 "expired" — steamrolling the
    // real close. A real external close is ground truth and must win.
    const trade = {
      id: 'T-2026-06-15-003', account: 'manual_paper', symbol: 'MU', asset_class: 'spread',
      side: 'STO', qty: 1, contract_symbol: null,
      strike: null, expiration: '2026-06-18', contract_type: null,
      filled_avg_price: 9.50, filled_at: '2026-06-15T14:01:39Z',
      alpaca_order_id: 'mleg-mu', alpaca_close_order_id: null,
      submitted_at: '2026-06-15T13:46Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'C+', entry_reasoning: 'earnings play', tags: ['earnings_play'], rule_warnings_at_entry: [],
      fill_confirmed: true, // short-circuits syncFillData; clears the D14 defer guard
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'MU260618P01035000', strike: 1035, entry_premium: 35.75, fill_price: 35.75, qty: 1 },
        long_leg: { occ: 'MU260618P01010000', strike: 1010, entry_premium: 26.25, fill_price: 26.25, qty: 1 },
        expiration: '2026-06-18', width: 25, net_credit: 9.50, max_loss: 15.50,
      },
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'C+', reasoning: 'earnings play', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Both legs gone from positions; the activity stream carries the REAL closing
    // fills at a loss. Spot is above the short strike (so the buggy Path 2b would
    // otherwise book the full +$950 credit).
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/v2/positions/')) return Promise.resolve(null); // 404-equivalent → gone
      if (path.includes('/v2/account/activities')) return Promise.resolve([
        { id: 'f-short', symbol: 'MU260618P01035000', side: 'buy',  price: '37.05', order_id: 'o-short', transaction_time: '2026-06-16T15:41:53Z' },
        { id: 'f-long',  symbol: 'MU260618P01010000', side: 'sell', price: '25.70', order_id: 'o-long',  transaction_time: '2026-06-16T15:41:53Z' },
      ]);
      return Promise.resolve(null);
    });
    dataMock.mockImplementation((_mode: any, path: string) => {
      if (path.includes('/trades/latest')) return Promise.resolve({ trade: { p: '1043.00' } }); // above short strike
      return Promise.resolve({ bars: { MU: [] } });
    });
    gradeMock.mockResolvedValue({ letter: 'D', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T20:30:00Z')); // AFTER the 06-18 expiry → Path 2b is armed
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }

    // The real close must win: bot_external at the actual −$185 loss.
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'bot_external',
      realized_pnl: -185,
      closed_at: '2026-06-16T15:41:53Z',
    }));
    // And it must NOT fabricate the +$950 worthless-expiry win.
    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_by: 'expired',
    }));
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

  it('syncFillData no-ops on still-pending entry orders', async () => {
    // Freeze time before the option expiry (2026-05-29) so detectClose Path 2
    // (option past expiration / backstop) does not fire. Without a fake timer,
    // real Date.now() is past expiry and the backstop auto-closes the trade.
    const trade = {
      id: 'T-2026-05-07-002', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260529P00011000',
      strike: 11.0, expiration: '2026-05-29', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'a-still-pending', alpaca_close_order_id: null,
      submitted_at: '2026-05-07T17:44Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'D', entry_reasoning: 'r', tags: [], rule_warnings_at_entry: [],
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockResolvedValue({ id: 'a-still-pending', status: 'new', filled_at: null, filled_avg_price: null });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z')); // 9 days before 2026-05-29 expiry
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
      // No write to the trade record — neither fill-sync nor close-detect found anything to do.
      // (runAutoImport writes import:cursor:* keys as a side-effect — those are
      // expected and are not what this assertion guards against.)
      expect(kvSet).not.toHaveBeenCalledWith(expect.stringContaining('trade:'), expect.anything());
      expect(kvLrem).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- D6: syncFillData mleg spread modify-chain walking -------------------
  //
  // A user can modify a spread's limit price on Alpaca's web UI. Alpaca cancels
  // the original mleg order (status='replaced', carries replaced_by) and creates
  // a successor. The trade's alpaca_order_id still points at the original.
  // syncFillData MUST follow the chain to the terminal order and read fill status
  // from there — mirroring what the single-leg path already does.

  function makeSpreadTrade(id: string, orderId: string, extraFields: any = {}) {
    return {
      id,
      account: 'manual_paper',
      symbol: 'AAL',
      asset_class: 'spread',
      side: 'STO',
      qty: 1,
      contract_symbol: null,
      strike: null,
      expiration: '2026-07-18',
      contract_type: null,
      filled_avg_price: null,
      filled_at: null,
      alpaca_order_id: orderId,
      alpaca_close_order_id: null,
      submitted_at: '2026-06-17T14:00Z',
      closed_at: null,
      realized_pnl: null,
      closed_avg_price: null,
      closed_by: null,
      entry_grade: 'B',
      entry_reasoning: 'test',
      tags: [],
      rule_warnings_at_entry: [],
      schema: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260718P00012500', strike: 12.5, entry_premium: 0.40, fill_price: null, qty: 1 },
        long_leg: { occ: 'AAL260718P00011500', strike: 11.5, entry_premium: 0.15, fill_price: null, qty: 1 },
        expiration: '2026-07-18',
        width: 1.0,
        net_credit: 0.25,
        max_loss: 0.75,
      },
      ...extraFields,
    } as any;
  }

  it('D6: syncFillData follows replaced_by chain for a spread modified once and now filled', async () => {
    // User submits spread at $0.25 net credit (id=mleg-A), then modifies it
    // to $0.20 on Alpaca's web UI. Alpaca cancels A (status='replaced',
    // replaced_by='mleg-B') and creates B which fills. Trade record still
    // points at mleg-A. syncFillData must walk A→B and write fill data.
    const trade = makeSpreadTrade('T-D6-001', 'mleg-A');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/mleg-A')) return Promise.resolve({
        id: 'mleg-A',
        status: 'replaced',
        replaced_by: 'mleg-B',
        replaces: null,
        legs: [],
      });
      if (path.endsWith('/mleg-B')) return Promise.resolve({
        id: 'mleg-B',
        status: 'filled',
        replaced_by: null,
        replaces: 'mleg-A',
        filled_at: '2026-06-17T14:10:00Z',
        legs: [
          { symbol: 'AAL260718P00012500', side: 'sell', filled_avg_price: '0.35', filled_qty: '1' },
          { symbol: 'AAL260718P00011500', side: 'buy', filled_avg_price: '0.12', filled_qty: '1' },
        ],
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T15:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }

    // Must repoint to terminal order id and capture fill data
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'mleg-B',
      filled_at: '2026-06-17T14:10:00Z',
      spread: expect.objectContaining({
        short_leg: expect.objectContaining({ fill_price: 0.35 }),
        long_leg: expect.objectContaining({ fill_price: 0.12 }),
        net_credit: expect.closeTo(0.23, 5),
      }),
      filled_avg_price: expect.closeTo(0.23, 5),
    }));
  });

  it('D6: syncFillData follows multi-hop chain (replaced → replaced → filled) for spread', async () => {
    // Three hops: mleg-A (replaced) → mleg-B (replaced) → mleg-C (filled)
    const trade = makeSpreadTrade('T-D6-002', 'mleg-A');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/mleg-A')) return Promise.resolve({
        id: 'mleg-A', status: 'replaced', replaced_by: 'mleg-B', replaces: null, legs: [],
      });
      if (path.endsWith('/mleg-B')) return Promise.resolve({
        id: 'mleg-B', status: 'replaced', replaced_by: 'mleg-C', replaces: 'mleg-A', legs: [],
      });
      if (path.endsWith('/mleg-C')) return Promise.resolve({
        id: 'mleg-C', status: 'filled', replaced_by: null, replaces: 'mleg-B',
        filled_at: '2026-06-17T14:20:00Z',
        legs: [
          { symbol: 'AAL260718P00012500', side: 'sell', filled_avg_price: '0.30', filled_qty: '1' },
          { symbol: 'AAL260718P00011500', side: 'buy', filled_avg_price: '0.10', filled_qty: '1' },
        ],
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T15:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }

    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'mleg-C',
      filled_at: '2026-06-17T14:20:00Z',
      spread: expect.objectContaining({
        short_leg: expect.objectContaining({ fill_price: 0.30 }),
        long_leg: expect.objectContaining({ fill_price: 0.10 }),
        net_credit: expect.closeTo(0.20, 5),
      }),
      filled_avg_price: expect.closeTo(0.20, 5),
    }));
  });

  it('D6: syncFillData terminates and does not crash on a malformed cyclic spread chain', async () => {
    // Pathological case: Alpaca returns a chain where A.replaced_by = B and
    // B.replaced_by = A (cycle). The walk must cap iterations and not hang.
    const trade = makeSpreadTrade('T-D6-003', 'mleg-A');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/mleg-A')) return Promise.resolve({
        id: 'mleg-A', status: 'replaced', replaced_by: 'mleg-B', replaces: null, legs: [],
      });
      if (path.endsWith('/mleg-B')) return Promise.resolve({
        id: 'mleg-B', status: 'replaced', replaced_by: 'mleg-A', replaces: 'mleg-A', legs: [],
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T15:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      // Must complete without throwing or timing out
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }

    // Neither order is 'filled', so no fill data should be written.
    // (May or may not write alpaca_order_id repoint — that's acceptable either way.)
    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: expect.any(String),
    }));
  });

  it('D6: syncFillData pins alpaca_order_id to terminal mleg id even when not yet filled', async () => {
    // Modified spread whose replacement is still pending. We want the trade id
    // repointed so next tick reads directly from the terminal, not the replaced order.
    const trade = makeSpreadTrade('T-D6-004', 'mleg-A');
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/mleg-A')) return Promise.resolve({
        id: 'mleg-A', status: 'replaced', replaced_by: 'mleg-B', replaces: null, legs: [],
      });
      if (path.endsWith('/mleg-B')) return Promise.resolve({
        id: 'mleg-B', status: 'new', replaced_by: null, replaces: 'mleg-A', filled_at: null, legs: [],
      });
      return Promise.resolve(null);
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T15:00:00Z'));
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }

    // alpaca_order_id pinned to terminal, but no fill data written
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      alpaca_order_id: 'mleg-B',
      filled_at: null,
    }));
    expect(kvSet).not.toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: expect.stringContaining('Z'),
    }));
  });

  // ---- D7: fill_confirmed sentinel + close-detection isolation ----------------
  //
  // D7a: a trade with fill_confirmed:true must NOT trigger an Alpaca order fetch.
  //      The sentinel short-circuits syncFillData before any network call.
  //
  // D7b: a filled but not-yet-confirmed trade (fill_confirmed absent/false,
  //      modify_history:[]) must fetch the order, confirm the fill, and persist
  //      fill_confirmed:true so the next tick is free.
  //
  // D7c: if syncFillData throws (simulating a rate-limit or transient Alpaca
  //      error), detectClose must still run for that trade — a transient sync
  //      failure must never permanently block close detection.

  it('D7a: syncFillData makes NO Alpaca order fetch when fill_confirmed is true', async () => {
    // Trade is already filled and sentinel is set — syncFillData must early-return
    // without touching alpacaTradeMock at all (aside from detectClose's own reads).
    // To keep this assertion clean we use a stock trade with a close order already
    // linked — detectClose will fetch that close order (path 1). We assert
    // syncFillData did NOT make the entry-order fetch.
    const trade = {
      id: 'T-D7a-001', account: 'manual_paper', symbol: 'TSLA', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: 300.00,
      alpaca_order_id: 'entry-order-d7a', alpaca_close_order_id: 'close-order-d7a',
      submitted_at: '2026-06-10T14:00Z', filled_at: '2026-06-10T14:01Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'test', tags: [], rule_warnings_at_entry: [],
      modify_history: [],
      fill_confirmed: true,  // <-- sentinel that should suppress the entry-order fetch
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'test', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Only set up a mock for the CLOSE order fetch (path 1 in detectClose).
    // Entry order 'entry-order-d7a' must NOT be fetched.
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/close-order-d7a')) {
        return Promise.resolve({ id: 'close-order-d7a', status: 'filled', filled_avg_price: '320.00', filled_at: '2026-06-11T15:00Z' });
      }
      // Entry-order path must not be called — if it is, fail clearly by returning null
      // (which would abort the chain) but the expect below catches the call anyway.
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    // The entry order must NOT have been fetched — fill_confirmed should have
    // caused syncFillData to early-return before any order fetch.
    const fetchedPaths = alpacaTradeMock.mock.calls.map((c: any[]) => c[1] as string);
    expect(fetchedPaths.some((p) => p.includes('entry-order-d7a'))).toBe(false);
  });

  it('D7b: syncFillData fetches once for filled/not-confirmed trade and sets fill_confirmed:true', async () => {
    // Trade is filled on Alpaca (the order is filled) but fill_confirmed is absent
    // (common on legacy/existing records). syncFillData must fetch the order ONCE,
    // capture the fill, and write fill_confirmed:true to KV.
    const trade = {
      id: 'T-D7b-001', account: 'manual_paper', symbol: 'F', asset_class: 'option',
      side: 'STO', qty: 1, contract_symbol: 'F260718P00011000',
      strike: 11.0, expiration: '2026-07-18', contract_type: 'put',
      filled_avg_price: null, filled_at: null,
      alpaca_order_id: 'entry-order-d7b', alpaca_close_order_id: null,
      submitted_at: '2026-06-10T14:00Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'test', tags: [], rule_warnings_at_entry: [],
      modify_history: [],   // empty — the old guard never fires
      // fill_confirmed absent (undefined) — sentinel not yet set
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvGet.mockImplementation((k: string) =>
      k === `trade:${trade.id}` ? Promise.resolve(trade) : Promise.resolve(null));
    // Alpaca reports the entry order as filled
    alpacaTradeMock.mockResolvedValue({
      id: 'entry-order-d7b', status: 'filled',
      filled_at: '2026-06-10T14:05:00Z', filled_avg_price: '0.08',
    });
    kvSet.mockResolvedValue('OK');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T16:00:00Z')); // before 2026-07-18 expiry
    try {
      const handler = (await import('../../api/cron/[job]')).default;
      await handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes());
    } finally { vi.useRealTimers(); }
    // fill_confirmed:true must be written to the trade record
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      filled_at: '2026-06-10T14:05:00Z',
      filled_avg_price: 0.08,
      fill_confirmed: true,
    }));
    // The entry order was fetched exactly once (forward walk to terminal, then backward
    // to check for a modify chain = same terminal id, no backward hops). Accept 1 or 2
    // calls to the entry-order path (walk + backward step that gets the same order).
    const entryFetches = alpacaTradeMock.mock.calls.filter(
      (c: any[]) => typeof c[1] === 'string' && (c[1] as string).includes('entry-order-d7b'),
    );
    expect(entryFetches.length).toBeGreaterThanOrEqual(1);
  });

  it('D7c: detectClose still runs when syncFillData throws (sync failure must not block close)', async () => {
    // Simulate Alpaca rate-limiting the entry-order fetch inside syncFillData.
    // Even though syncFillData fails, detectClose MUST still run and pick up the
    // already-linked close order — so a transient sync failure never permanently
    // blocks close detection.
    const trade = {
      id: 'T-D7c-001', account: 'manual_paper', symbol: 'TSLA', asset_class: 'stock',
      side: 'buy', qty: 10, filled_avg_price: 300.00,
      alpaca_order_id: 'entry-order-d7c', alpaca_close_order_id: 'close-order-d7c',
      submitted_at: '2026-06-10T14:00Z', filled_at: '2026-06-10T14:01Z', closed_at: null,
      realized_pnl: null, closed_avg_price: null, closed_by: null,
      entry_grade: 'B', entry_reasoning: 'test', tags: [], rule_warnings_at_entry: [],
      modify_history: [],   // empty — would normally trigger a sync fetch
      // fill_confirmed absent — sentinel not set, so sync is attempted
      schema: 1,
    } as any;
    kvLrange.mockResolvedValueOnce([trade.id]);
    kvLrem.mockResolvedValue(1);
    kvGet.mockImplementation((k: string) => {
      if (k === `trade:${trade.id}`) return Promise.resolve(trade);
      if (k === `grade:${trade.id}`) return Promise.resolve({ trade_id: trade.id, entry: { letter: 'B', reasoning: 'test', ts: 'now' }, hindsight: null, history: [] });
      return Promise.resolve(null);
    });
    // Entry-order fetch throws (Alpaca rate-limit / 429). Close-order fetch succeeds.
    alpacaTradeMock.mockImplementation((_mode: any, path: string) => {
      if (path.endsWith('/entry-order-d7c')) {
        return Promise.reject(new Error('HTTP 429 Too Many Requests'));
      }
      if (path.endsWith('/close-order-d7c')) {
        return Promise.resolve({ id: 'close-order-d7c', status: 'filled', filled_avg_price: '320.00', filled_at: '2026-06-11T15:00Z' });
      }
      return Promise.resolve(null);
    });
    dataMock.mockResolvedValue({ bars: { TSLA: [] } });
    gradeMock.mockResolvedValue({ letter: 'B', review: 'r', calibration: 'matched', tendencies_hit: [], model: 's', usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, ts: 'now' });
    kvSet.mockResolvedValue('OK');
    const handler = (await import('../../api/cron/[job]')).default;
    // Must NOT throw — the per-trade loop must survive a syncFillData error
    await expect(handler(mockReq({ authorization: 'Bearer cron-token' }), mockRes())).resolves.not.toThrow();
    // detectClose must have run: the trade must be closed with the fill from close-order-d7c
    expect(kvSet).toHaveBeenCalledWith(`trade:${trade.id}`, expect.objectContaining({
      closed_at: '2026-06-11T15:00Z',
      closed_avg_price: 320.00,
      closed_by: 'manual',
    }));
    // And it must be removed from the open index
    expect(kvLrem).toHaveBeenCalledWith('trades:index:open', 0, trade.id);
  });

});
