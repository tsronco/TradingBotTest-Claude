// dashboard/api/cron/[job].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { KV_KEYS, tradeKey, gradeKey, rulesKey, assignmentChildKey, tradesIndexMonthKey } from '../_lib/kv-keys.js';
import { gradeTrade } from '../_lib/grading.js';
import { alpacaData, alpacaTrade } from '../_lib/data-api.js';
import type { Trade, GradeRecord, ClosedBy } from '../_lib/trade-types.js';
import {
  enqueueAssignmentPending,
  drainAssignments,
  removeAssignment,
  buildAssignmentTrade,
  currentMonth,
} from '../_lib/assignment-spawn.js';
import { runMatchers, type Finding, type ClosedTradeView } from '../_lib/tendency-matchers.js';
import { proposeNewRule, proposeDemote } from '../_lib/proposal-prompts.js';
import type { Tendency, Proposal, ManualRule } from '../_lib/rules-types.js';
import { newId } from '../_lib/rules-types.js';

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
  if (job === 'detect-tendencies') return detectTendenciesHandler(req, res);
  return res.status(404).json({ error: 'unknown_job' });
}

function modeFromAccount(account: string): string {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  if (account === 'live') return 'live';
  return 'conservative';
}

async function gradeOpenTrades(res: VercelResponse) {
  const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];

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

    // Detect STO put assignment for follow-on stock trade spawn (M5)
    if (
      closedTrade.asset_class === 'option'
      && closedTrade.contract_type === 'put'
      && closedTrade.side === 'STO'
      && closeInfo.closed_by === 'assigned'
    ) {
      await enqueueAssignmentPending({
        parent_trade_id: closedTrade.id,
        underlying: closedTrade.symbol,
        strike: closedTrade.strike ?? closedTrade.filled_avg_price ?? 0,
        qty: closedTrade.qty * 100,        // 100 shares per contract
        // Live assignments stay on the live account — bot will manage the
        // resulting shares with the same Stage 2 covered-call flow as paper.
        account: closedTrade.account,
        detected_at: closeInfo.closed_at,
      });
    }

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

  // Drain assignments-pending — spawn follow-on stock trades for assigned puts
  const drainResult = await drainAssignmentsAndSpawn();

  return res.status(200).json({
    ok: true,
    graded,
    remaining_open: remaining,
    assignments_spawned: drainResult.spawned,
    assignments_skipped: drainResult.skipped,
  });
}

async function drainAssignmentsAndSpawn(): Promise<{ spawned: number; skipped: number }> {
  const entries = await drainAssignments();
  let spawned = 0;
  let skipped = 0;
  for (const entry of entries) {
    // Idempotency: skip if a child trade for this parent already exists
    const existingChild = await kv().get<string>(assignmentChildKey(entry.parent_trade_id));
    if (existingChild) {
      await removeAssignment(entry);
      skipped++;
      continue;
    }
    const parent = await kv().get<Trade>(tradeKey(entry.parent_trade_id));
    if (!parent) {
      console.error('[drain] parent trade missing:', entry.parent_trade_id);
      await removeAssignment(entry);
      skipped++;
      continue;
    }
    const grade = await kv().get<GradeRecord>(gradeKey(entry.parent_trade_id));
    const newTrade = await buildAssignmentTrade(parent, entry, grade);
    await kv().set(tradeKey(newTrade.id), newTrade);
    await kv().set(assignmentChildKey(entry.parent_trade_id), newTrade.id);
    await kv().rpush(KV_KEYS.tradesIndexOpen, newTrade.id);
    await kv().rpush(tradesIndexMonthKey(currentMonth()), newTrade.id);
    await removeAssignment(entry);
    spawned++;
  }
  return { spawned, skipped };
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
  // Idempotent termination: filled AND we've captured at least one modify
  // event (or we'll fall through and re-check the chain — cheap if no
  // chain exists). Empty/undefined modify_history → re-walk.
  //
  // For trades with no modifies, modify_history stays empty array and we
  // re-fetch the head order each tick to confirm. That's 1 Alpaca call
  // per tick per filled trade with no modifies — acceptable. Could
  // optimize later with a `modify_history_checked: true` sentinel.
  if (trade.filled_at && (trade.modify_history?.length ?? 0) > 0) return trade;
  const mode = modeFromAccount(trade.account) as 'conservative' | 'aggressive' | 'manual';

  // Spread (mleg) path — Alpaca returns a single order with a `legs` array.
  // Match each leg's OCC symbol to short/long and copy fill prices back onto
  // the spread block. Net credit is recomputed from actual fills (may differ
  // from the order's target net credit by a few cents of slippage). Modify
  // chain walking is skipped — paper Alpaca mleg orders submit as one unit
  // and don't have a replaces/replaced_by chain to walk.
  if (trade.asset_class === 'spread' && trade.spread) {
    let order: any = null;
    try {
      order = await alpacaTrade<any>(mode, `/v2/orders/${trade.alpaca_order_id}`);
    } catch (e) {
      console.error('syncFillData mleg order fetch failed', trade.id, trade.alpaca_order_id, e);
      return trade;
    }
    if (!order || order.status !== 'filled') return trade;
    const legs = order.legs ?? [];
    const shortFill = legs.find((l: any) => l.symbol === trade.spread!.short_leg.occ);
    const longFill = legs.find((l: any) => l.symbol === trade.spread!.long_leg.occ);
    if (!shortFill || !longFill) return trade;
    const shortPx = parseFloat(shortFill.filled_avg_price);
    const longPx = parseFloat(longFill.filled_avg_price);
    if (!Number.isFinite(shortPx) || !Number.isFinite(longPx)) return trade;
    const netCredit = shortPx - longPx;
    const updated: Trade = {
      ...trade,
      filled_at: order.filled_at ?? new Date().toISOString(),
      filled_avg_price: netCredit,           // back-compat for legacy consumers
      spread: {
        ...trade.spread,
        short_leg: { ...trade.spread.short_leg, fill_price: shortPx },
        long_leg: { ...trade.spread.long_leg, fill_price: longPx },
        net_credit: netCredit,
        max_loss: trade.spread.width - netCredit,
      },
    };
    await kv().set(tradeKey(trade.id), updated);
    return updated;
  }

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

  // Path 2b: spread past expiration with no close order = resolve by spot vs strikes.
  // The bot (Phase 2 handle_spread) clears the legs on Alpaca's side at expiry, but
  // the dashboard's trade record stays pinned to trades:index:open with closed_at=null
  // unless we resolve it here. Three outcomes:
  //   • spot >= short_strike  → both legs worthless OTM, keep full net credit (win)
  //   • spot <  long_strike   → both legs deep ITM, full max loss
  //   • between strikes       → partial loss, leave for manual resolution
  if (trade.asset_class === 'spread' && trade.spread) {
    const exp = trade.spread.expiration;
    const expDate = new Date(exp + 'T20:00:00Z'); // ~4 PM ET = 20:00 UTC during EDT
    if (Date.now() > expDate.getTime()) {
      // Fetch latest trade price for the underlying
      let spot = 0;
      try {
        const latest = await alpacaData<any>(mode, `/v2/stocks/${trade.symbol}/trades/latest`, { feed: 'iex' });
        spot = parseFloat(latest?.trade?.p ?? '0');
      } catch (e) {
        console.error('detectClose spread spot fetch failed', trade.id, trade.symbol, e);
        return null;
      }
      if (!Number.isFinite(spot) || spot <= 0) {
        console.error('detectClose spread spot unavailable', trade.id, trade.symbol);
        return null;
      }

      const { short_leg, long_leg, net_credit, max_loss, width } = trade.spread;
      const qty = short_leg.qty;

      if (spot >= short_leg.strike) {
        // Worthless OTM — keep full credit
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: 0,
          realized_pnl: Math.round(net_credit * 100 * qty * 100) / 100,
          closed_by: 'expired',
        };
      }
      if (spot < long_leg.strike) {
        // Deep ITM — full max loss
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: width,
          realized_pnl: Math.round(-max_loss * 100 * qty * 100) / 100,
          closed_by: 'expired',
        };
      }
      // Between strikes — partial loss, leave for manual close
      console.warn(
        `[${trade.id}] spread expired between strikes (spot=${spot}, short=${short_leg.strike}, long=${long_leg.strike}) — leaving for manual close`,
      );
      return null;
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

const TENDENCY_LOOKBACK_DAYS = 90;
const MAX_FINDING_PROPOSALS = 6;
const MAX_DEMOTE_PROPOSALS = 6;
const DEMOTE_OVERRIDE_THRESHOLD = 3;
const DEMOTE_PROFITABLE_THRESHOLD = 0.6;

async function detectTendenciesHandler(req: VercelRequest, res: VercelResponse) {
  // Bearer auth — match the grade-open-trades convention
  const auth = req.headers.authorization ?? '';
  if (!process.env.CRON_TOKEN || auth !== `Bearer ${process.env.CRON_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const trades = await loadClosedTrades(TENDENCY_LOOKBACK_DAYS);
  const findings = runMatchers(trades);

  // Update tendencies (replace prior entries by matcher key)
  const existingTendencies = (await kv().get<Tendency[]>(rulesKey('tendencies'))) ?? [];
  const updatedTendencies = mergeTendencies(existingTendencies, findings);
  await kv().set(rulesKey('tendencies'), updatedTendencies);

  // Generate proposals for actionable findings, dedupe against open + dismissed
  const proposals = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];
  let proposalsAppended = 0;
  let llmCalls = 0;
  for (const finding of findings) {
    if (!finding.actionable) continue;
    if (llmCalls >= MAX_FINDING_PROPOSALS) break;
    if (proposals.some((p) => proposalKey(p) === finding.key && p.status !== 'approved')) continue;
    try {
      const evidenceSnippets = trades
        .filter((t) => finding.evidence_trade_ids.includes(t.id))
        .slice(0, 5)
        .map((t) => ({ id: t.id, symbol: t.symbol, pnl: t.realized_pnl, closed_at: t.closed_at }));
      const proposal = await proposeNewRule(finding, evidenceSnippets);
      proposals.push(proposal as Proposal);
      proposalsAppended++;
      llmCalls++;
    } catch (e) {
      console.error('[detect-tendencies] proposal generation failed:', e);
    }
  }

  // Demote loop: for each block-severity rule, see if it's been over-overridden profitably
  const manualRules = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];
  const blockRules = manualRules.filter((r) => r.severity === 'block');
  let demotesAppended = 0;
  for (const rule of blockRules) {
    if (demotesAppended >= MAX_DEMOTE_PROPOSALS) break;
    const overrides = trades.filter((t) =>
      t.rule_violations.some((v) =>
        v.rule === rule.id && v.severity === 'block' && v.override_reason),
    );
    if (overrides.length < DEMOTE_OVERRIDE_THRESHOLD) continue;
    const profitable = overrides.filter((t) => t.realized_pnl > 0).length;
    const profitablePct = profitable / overrides.length;
    if (profitablePct < DEMOTE_PROFITABLE_THRESHOLD) continue;
    if (proposals.some((p) => p.demote_target_rule_id === rule.id && p.status === 'open')) continue;
    try {
      const proposal = proposeDemote(rule, { overrides: overrides.length, profitable_pct: profitablePct });
      proposals.push(proposal as Proposal);
      demotesAppended++;
    } catch (e) {
      console.error('[detect-tendencies] demote proposal failed:', e);
    }
  }

  if (proposalsAppended > 0 || demotesAppended > 0) {
    await kv().set(rulesKey('proposals'), proposals);
  }

  return res.status(200).json({
    findings_count: findings.length,
    proposals_appended: proposalsAppended,
    demotes_appended: demotesAppended,
    llm_calls: llmCalls,
  });
}

function mergeTendencies(existing: Tendency[], findings: Finding[]): Tendency[] {
  const byMatcher: Record<string, Tendency> = {};
  for (const t of existing) byMatcher[t.matcher] = t;
  const now = new Date().toISOString();
  for (const f of findings) {
    byMatcher[f.matcher] = {
      id: newId('te'),
      matcher: f.matcher,
      finding: f.finding,
      evidence_trade_ids: f.evidence_trade_ids,
      detected_at: now,
    };
  }
  return Object.values(byMatcher);
}

function proposalKey(p: Proposal): string {
  if (p.demote_target_rule_id) return `demote:${p.demote_target_rule_id}`;
  // Mirror the matcher.key conventions from tendency-matchers.ts
  if (p.matcher === 'cc_below_cost_basis') return 'cc_below_cost_basis:global';
  if (p.matcher === 'held_through_earnings') return 'held_through_earnings:global';
  if (p.matcher === 'over_grading_self') return 'over_grading_self:global';
  // For the per-symbol/per-side matchers, derive dim from triggers
  const tig = p.proposed_rule.triggers[0];
  if (tig?.type === 'symbol_in' && tig.symbols.length > 0) {
    return `${p.matcher}:${tig.symbols[0]}`;
  }
  if (tig?.type === 'asset_class') {
    const ot = p.proposed_rule.triggers.find((t) => t.type === 'option_type') as any;
    return `${p.matcher}:${tig.value}:${ot?.value ?? 'na'}`;
  }
  return p.matcher;
}

async function loadClosedTrades(days: number): Promise<ClosedTradeView[]> {
  const cutoff = new Date(Date.now() - days * 86400000);
  const months: string[] = [];
  const cursor = new Date(cutoff);
  cursor.setUTCDate(1);
  while (cursor <= new Date()) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const idsByMonth = await Promise.all(
    months.map((m) => kv().get<string[]>(`trades:index:${m}`)),
  );
  const allIds = idsByMonth.flat().filter(Boolean) as string[];

  const records = await Promise.all(allIds.map(async (id) => {
    const trade = await kv().get<Trade>(`trade:${id}`);
    if (!trade || !trade.closed_at) return null;
    if (Date.parse(trade.closed_at) < cutoff.getTime()) return null;
    const grade = await kv().get<GradeRecord>(`grade:${id}`);
    return tradeToClosedView(trade, grade);
  }));

  return records.filter((r): r is ClosedTradeView => r !== null);
}

function tradeToClosedView(t: Trade, grade: GradeRecord | null): ClosedTradeView {
  return {
    id: t.id,
    symbol: t.symbol,
    asset_class: t.asset_class,
    option_type: t.contract_type,
    side: t.side,
    closed_at: t.closed_at!,
    realized_pnl: t.realized_pnl ?? 0,
    user_grade: t.entry_grade,
    ai_grade: grade?.hindsight?.letter ?? null,
    tags: t.tags,
    rule_violations: (t.rule_warnings_at_entry ?? []).map((v) => ({
      rule: v.rule,
      severity: v.severity as any,
      override_reason: (v as any).override_reason,
    })),
    strike: t.strike,
    expiration: t.expiration,
    cost_basis_at_entry: null,           // populated by future grade-cron extension; null is fine
    earnings_during_hold: false,         // ditto
  };
}
