// dashboard/api/cron/[job].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { KV_KEYS, tradeKey, gradeKey } from '../_lib/kv-keys.js';
import { gradeTrade } from '../_lib/grading.js';
import { alpacaData, alpacaTrade } from '../_lib/data-api.js';
import type { Trade, GradeRecord, ClosedBy } from '../_lib/trade-types.js';

const MAX_PER_TICK = 3;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow either Vercel's built-in cron header OR an explicit bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1'
    || (req.headers['user-agent']?.toString().includes('vercel-cron') ?? false);
  const auth = req.headers.authorization ?? '';
  const expected = `Bearer ${process.env.CRON_TOKEN ?? ''}`;
  if (!isVercelCron && (!process.env.CRON_TOKEN || auth !== expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const job = String(req.query.job ?? '');
  if (job === 'grade-open-trades') return gradeOpenTrades(res);
  return res.status(404).json({ error: 'unknown_job' });
}

function modeFromAccount(account: string): string {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  return 'conservative';
}

async function gradeOpenTrades(res: VercelResponse) {
  const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
  if (openIds.length === 0) return res.status(200).json({ ok: true, graded: 0 });

  let graded = 0;
  let remaining = openIds.length;

  for (const id of openIds) {
    if (graded >= MAX_PER_TICK) break;
    let trade = await kv().get<Trade>(tradeKey(id));
    if (!trade) {
      // Stale entry — remove it from the list
      await kv().lrem(KV_KEYS.tradesIndexOpen, 0, id);
      remaining -= 1;
      continue;
    }

    // Sync delayed fills back to the trade record. Limit orders may submit
    // with filled_at=null and fill seconds-to-hours later. Without this,
    // the trade is permanently stuck showing "submitted · limit $X" with
    // no entry price, and grade-on-close uses submitted_at as the start
    // instead of the actual fill time.
    trade = await syncFillData(trade);

    const closeInfo = await detectClose(trade);
    if (!closeInfo) continue;

    // Update trade record
    const closedTrade: Trade = {
      ...trade,
      closed_at: closeInfo.closed_at,
      closed_avg_price: closeInfo.closed_avg_price,
      realized_pnl: closeInfo.realized_pnl,
      closed_by: closeInfo.closed_by,
      alpaca_close_order_id: closeInfo.alpaca_close_order_id ?? trade.alpaca_close_order_id,
    };
    await kv().set(tradeKey(id), closedTrade);

    // Atomically remove the closed trade from the open list
    await kv().lrem(KV_KEYS.tradesIndexOpen, 0, id);
    graded += 1;
    remaining -= 1;

    // Skip AI grading for canceled trades — entry never filled, nothing to grade.
    if (closeInfo.closed_by === 'canceled') continue;

    // Pull bars and grade
    const start = closedTrade.filled_at ?? closedTrade.submitted_at;
    const end = closedTrade.closed_at ?? new Date().toISOString();
    let bars: Array<{ t: string; c: number }> = [];
    try {
      const data = await alpacaData<any>(modeFromAccount(closedTrade.account) as any, '/v2/stocks/bars', {
        symbols: closedTrade.symbol, timeframe: '1Min', start, end, limit: 500,
      });
      bars = (data?.bars?.[closedTrade.symbol] ?? []).map((b: any) => ({ t: b.t, c: b.c }));
    } catch { /* bars are optional */ }

    const grade = await kv().get<GradeRecord>(gradeKey(id));
    if (!grade) continue;
    const hindsight = await gradeTrade({ trade: closedTrade, bars });
    const next = { ...grade, hindsight };
    await kv().set(gradeKey(id), next);
  }

  return res.status(200).json({ ok: true, graded, remaining_open: remaining });
}

interface CloseInfo {
  closed_at: string;
  closed_avg_price: number;
  realized_pnl: number;
  closed_by: NonNullable<ClosedBy>;
  alpaca_close_order_id?: string | null;
}

/**
 * Pull the entry order from Alpaca and copy its fill data back onto the
 * trade record if missing. Called once per open trade per cron tick so
 * delayed-fill limit orders eventually pick up the actual entry price
 * and fill timestamp instead of staying stuck at "submitted · limit $X".
 *
 * Follows the `replaced_by` chain when the trade's order_id has been
 * replaced (by a modify, either via our dashboard or directly on Alpaca).
 * Updates `alpaca_order_id` on the trade record to the terminal order
 * so subsequent passes don't have to re-walk the chain.
 *
 * Returns the (possibly updated) trade. Idempotent — once filled_at is
 * set, this is a no-op aside from the Alpaca read on subsequent calls.
 */
async function syncFillData(trade: Trade): Promise<Trade> {
  // Idempotent termination: filled AND modify_history is at least an empty
  // array (meaning we've already checked the chain). Trades created before
  // modify_history was added have undefined here and need one backfill pass.
  if (trade.filled_at && trade.modify_history !== undefined) return trade;
  const mode = modeFromAccount(trade.account) as 'conservative' | 'aggressive' | 'manual';

  // Build the full modify chain bidirectionally from trade.alpaca_order_id:
  //   - Walk forward via replaced_by to find the terminal (non-replaced) order
  //   - Walk backward via replaces to find every prior order
  // This is robust whether trade.alpaca_order_id is the original (never
  // modified yet, or modified externally and not yet seen by us) or the
  // terminal (pinned by a previous syncFillData run). Cap each direction at
  // 10 hops to avoid an infinite loop on malformed Alpaca responses.
  const fetchOrder = async (id: string): Promise<any> => {
    try { return await alpacaTrade<any>(mode, `/v2/orders/${id}`); }
    catch (e) {
      console.error('syncFillData order fetch failed', trade.id, id, e);
      return null;
    }
  };

  // Forward walk to terminal
  let cursor = await fetchOrder(trade.alpaca_order_id);
  if (!cursor) return trade;
  for (let hops = 0; hops < 10 && cursor.replaced_by; hops++) {
    const next = await fetchOrder(cursor.replaced_by);
    if (!next) break;
    cursor = next;
  }
  const terminal = cursor;

  // Backward walk from terminal to collect prior orders. Start with the
  // terminal in the chain, prepend each `replaces` predecessor.
  const chain: any[] = [terminal];
  for (let hops = 0; hops < 10 && chain[0]?.replaces; hops++) {
    const prev = await fetchOrder(chain[0].replaces);
    if (!prev) break;
    chain.unshift(prev);
  }
  // chain is now [original, ..., terminal] in chronological order
  const order = terminal;
  const orderId = terminal.id;

  // Build modify_history from the chain only when the trade doesn't already
  // have it captured (chain length 1 = no modifies, nothing to backfill).
  const shouldBackfill = chain.length > 1
    && (trade.modify_history === undefined || trade.modify_history.length === 0);
  const backfilled = shouldBackfill
    ? chain.slice(1).map((o, i) => ({
        ts: o.submitted_at ?? o.created_at ?? new Date().toISOString(),
        prev_order_id: chain[i].id,
        new_order_id: o.id,
        qty: o.qty != null ? Number(o.qty) : undefined,
        limit_price: o.limit_price != null ? Number(o.limit_price) : null,
        stop_price: o.stop_price != null ? Number(o.stop_price) : null,
        source: 'backfill' as const,
      }))
    : (trade.modify_history ?? []);

  if (order?.status !== 'filled' || !order.filled_at || !order.filled_avg_price) {
    // Not filled yet — but if we walked the chain or reconstructed history,
    // persist the terminal id and any backfilled events so we don't redo
    // the work every cron tick.
    if (orderId !== trade.alpaca_order_id || shouldBackfill) {
      const updated: Trade = {
        ...trade,
        alpaca_order_id: orderId,
        modify_history: backfilled,
      };
      await kv().set(tradeKey(trade.id), updated);
      return updated;
    }
    return trade;
  }

  const updated: Trade = {
    ...trade,
    alpaca_order_id: orderId,  // pin to terminal id
    filled_at: order.filled_at,
    filled_avg_price: Number(order.filled_avg_price),
    modify_history: backfilled,
  };
  await kv().set(tradeKey(trade.id), updated);
  return updated;
}

async function detectClose(trade: Trade): Promise<CloseInfo | null> {
  const mode = modeFromAccount(trade.account) as 'conservative' | 'aggressive' | 'manual';

  // Path 0: entry order itself was canceled/rejected before fill — trade never existed.
  // Check this FIRST because if the entry order is canceled there's no point checking close-order paths.
  if (!trade.filled_at) {
    let entryOrder: any = null;
    try {
      entryOrder = await alpacaTrade<any>(mode, `/v2/orders/${trade.alpaca_order_id}`);
    } catch (e) {
      // 404 or other transient — leave the trade open and let next tick retry
      console.error('detectClose entry-order fetch failed', trade.id, trade.alpaca_order_id, e);
      return null;
    }
    const status = (entryOrder?.status ?? '').toLowerCase();
    if (status === 'canceled' || status === 'cancelled' || status === 'rejected' || status === 'expired') {
      return {
        closed_at: entryOrder.canceled_at ?? entryOrder.updated_at ?? new Date().toISOString(),
        closed_avg_price: 0,
        realized_pnl: 0,
        closed_by: 'canceled',
      };
    }
    // Entry order not yet filled and not canceled — leave trade open.
    return null;
  }

  // Path 1: explicit close order linked
  if (trade.alpaca_close_order_id) {
    let order: any = null;
    try {
      order = await alpacaTrade<any>(mode, `/v2/orders/${trade.alpaca_close_order_id}`);
    } catch (e) {
      console.error('detectClose close-order fetch failed', trade.id, trade.alpaca_close_order_id, e);
      // Fall through to other paths
    }
    if (order?.status === 'filled' && order.filled_at) {
      const fillPx = Number(order.filled_avg_price);
      return {
        closed_at: order.filled_at,
        closed_avg_price: fillPx,
        realized_pnl: realizedPnl(trade, fillPx),
        closed_by: 'manual',
      };
    }
  }

  // Path 2: option past expiration with no close order = expired worthless
  if (trade.asset_class === 'option' && trade.expiration) {
    const expDate = new Date(trade.expiration + 'T20:00:00Z'); // 4 PM ET ~= 20:00 UTC during DST
    if (Date.now() > expDate.getTime()) {
      // STO expired worthless: kept full premium
      if (trade.side === 'STO') {
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: 0,
          realized_pnl: (trade.filled_avg_price ?? 0) * 100 * trade.qty,
          closed_by: 'expired',
        };
      }
      // BTO expired worthless: lost full premium
      if (trade.side === 'BTO') {
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: 0,
          realized_pnl: -(trade.filled_avg_price ?? 0) * 100 * trade.qty,
          closed_by: 'expired',
        };
      }
    }
  }

  // Path 3: stock — match a later opposite-side fill against the same symbol
  // (Phase 2 keeps this simple — the user is expected to attach a close order via the modify/cancel UI
  // in milestone 6. Skipping fancy FIFO stock matching here.)

  return null;
}

function realizedPnl(trade: Trade, closePx: number): number {
  if (trade.asset_class === 'stock') {
    const dir = trade.side === 'buy' ? 1 : -1;
    return ((closePx - (trade.filled_avg_price ?? 0)) * dir) * trade.qty;
  }
  // option: premium-based
  if (trade.side === 'STO') {
    return ((trade.filled_avg_price ?? 0) - closePx) * 100 * trade.qty;
  }
  if (trade.side === 'BTO') {
    return (closePx - (trade.filled_avg_price ?? 0)) * 100 * trade.qty;
  }
  return 0;
}
