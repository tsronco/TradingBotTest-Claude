// dashboard/api/cron/[job].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../_lib/kv.js';
import { KV_KEYS, tradeKey, gradeKey, rulesKey, assignmentChildKey, tradesIndexMonthKey, importCursorKey, readMonthIndex, appendMonthIndex } from '../_lib/kv-keys.js';
import { gradeTrade } from '../_lib/grading.js';
import { alpacaData, alpacaTrade } from '../_lib/data-api.js';
import type { Mode } from '../_lib/alpaca.js';
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
import { fetchEarningsDates, earningsInWindow } from '../_lib/fundamentals-fetch.js';

// AI hindsight grades to run per tick. Small because gradeTrade is a Sonnet
// call (seconds + tokens); closes beyond this land on the needs-grade queue
// and are drained on later ticks. This caps ONLY grading — never fill-sync or
// close detection (those are cheap Alpaca reads and must run for every trade
// every tick so nothing is left stuck "open"). The old MAX_PER_TICK=3 used
// this same number to break the whole sweep, which stranded any trade past the
// first 3 closes — with a large open index the tail (newest trades) never got
// synced or close-detected.
const MAX_GRADE_PER_TICK = 5;

// Trades to fill-sync + close-detect per tick. Bounded so a large backlog can't
// blow the serverless time budget (the function runs under maxDuration=60s; a
// worst-case trade does several Alpaca reads, so this stays well clear), but
// combined with a rotating cursor it sweeps the entire open index over a
// handful of ticks. A ~300-trade backlog fully sweeps in ~10 ticks (~50 min).
const SWEEP_BUDGET = 30;

// How long to wait for Alpaca to post the OPEXP/OPASN settlement activity
// before assuming a past-expiry STO simply expired worthless. Alpaca normally
// posts it the evening of / morning after expiry; this is a safety net so a
// trade never hangs open indefinitely if the activity never arrives.
const SETTLEMENT_BACKSTOP_MS = 3 * 86400000; // 3 days

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

// Account → bot mode. MUST match api/_lib/rule-check.ts accountToMode() and the
// duplicate copy in trades/[action].ts modeFromAccount() exactly — the grade/sync
// cron routes SM trades to their own SM Alpaca credentials, NOT conservative's.
// (DRY follow-up: three copies across the api/ vs src/ build-root boundary;
// keep in sync.)
//
// Returns the full Mode union (not bare string) so every Alpaca call site below
// is type-checked against the real per-trade account. Narrowing this to
// 'conservative' | 'aggressive' | 'manual' anywhere would silently mis-route
// SM/live trades' settlement + fill + bars fetches to conservative's creds.
function modeFromAccount(account: string): Mode {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  if (account === 'sm500_paper') return 'sm500';
  if (account === 'sm1000_paper') return 'sm1000';
  if (account === 'sm2000_paper') return 'sm2000';
  if (account === 'live') return 'live';
  return 'conservative';
}

async function gradeOpenTrades(res: VercelResponse) {
  const result = await runGradeOpenTrades();
  return res.status(200).json({ ok: true, ...result });
}

/**
 * Pure logic for the grade-open-trades job. Walks every open trade,
 * syncs fill data, detects closes, AI-grades the closes, and drains
 * any pending option assignments into follow-on stock trades.
 *
 * Exported so the on-demand refresh action (POST /api/trades/refresh)
 * can run the same logic from a button click without going through the
 * cron auth path. Idempotent — safe to call repeatedly.
 *
 * Options (all optional — defaults reproduce the normal cron tick):
 *   sweepBudget  — max trades to fill-sync + close-detect this call.
 *   gradeBudget  — max AI hindsight grades this call (overflow → needs-grade queue).
 *   timeBudgetMs — soft wall-clock cap; the sweep stops between trades once
 *                  exceeded. Used by drain mode to process a big backlog in one
 *                  request while staying clear of the serverless time limit.
 */
export async function runGradeOpenTrades(opts: {
  sweepBudget?: number;
  gradeBudget?: number;
  timeBudgetMs?: number;
} = {}): Promise<{
  graded: number;
  synced: number;
  remaining_open: number;
  assignments_spawned: number;
  assignments_skipped: number;
  auto_imported: Record<string, number | string>;
}> {
  const startedAt = Date.now();
  const sweepBudget = opts.sweepBudget ?? SWEEP_BUDGET;
  const gradeBudget = opts.gradeBudget ?? MAX_GRADE_PER_TICK;
  const timeBudgetMs = opts.timeBudgetMs;
  const outOfTime = () => timeBudgetMs !== undefined && Date.now() - startedAt > timeBudgetMs;

  const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];

  let graded = 0;        // trades CLOSED this tick (what /trades surfaces as "closed")
  let synced = 0;
  let aiGrades = 0;      // expensive Sonnet grade calls used this tick
  let remaining = openIds.length;

  // Rotating sweep window: process at most sweepBudget trades starting from a
  // stored cursor, wrapping around. This guarantees every open trade is
  // fill-synced + close-detected within ceil(N / sweepBudget) ticks even when
  // N is large — the old "always start at index 0, break after 3 closes" path
  // never reached the tail of a big index.
  const N = openIds.length;
  const startRaw = (await kv().get<number>(KV_KEYS.tradesSweepCursor)) ?? 0;
  const start = N > 0 ? (((startRaw % N) + N) % N) : 0;
  const sweepCount = Math.min(sweepBudget, N);
  // Advance the cursor for next tick before doing the work, so a mid-sweep
  // crash still makes forward progress on the following tick. (When the loop
  // stops early on timeBudget, the post-loop write below corrects this to the
  // actual stopping point so a follow-up call resumes where this one left off.)
  if (N > 0) await kv().set(KV_KEYS.tradesSweepCursor, (start + sweepCount) % N);

  // Drain previously-queued closed-but-ungraded trades first (older closes get
  // their hindsight grade before we spend budget on new ones this tick).
  aiGrades += await drainNeedsGrade(gradeBudget);

  let processed = 0;
  for (let k = 0; k < sweepCount; k++) {
    if (outOfTime()) break;
    processed = k + 1;   // count this index as covered (we advance past it even on stale-skip)
    const id = openIds[(start + k) % N];
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
    //
    // Wrapped in try/catch to decouple sync failures from close detection.
    // A transient Alpaca rate-limit or network error in syncFillData must
    // never skip detectClose — a real (possibly live) close that Alpaca
    // already processed must still get its P&L recorded this tick.
    // Note: syncFillData's inner fetchOrderById already swallows its own
    // errors and returns trade unchanged, so in practice syncFillData does
    // not throw. The outer try/catch is a belt-and-suspenders guarantee.
    const beforeFilledAt = trade.filled_at;
    try {
      trade = await syncFillData(trade);
    } catch (e) {
      console.error('[gradeOpenTrades] syncFillData failed, proceeding to detectClose', trade.id, e);
    }
    if (trade.filled_at && trade.filled_at !== beforeFilledAt) synced += 1;

    const closeInfo = await detectClose(trade);
    if (!closeInfo) continue;

    let earnings_during_hold = trade.earnings_during_hold ?? false;
    if (trade.earnings_during_hold === undefined && trade.filled_at) {
      try {
        const dates = await fetchEarningsDates(trade.symbol);
        earnings_during_hold = earningsInWindow(dates, trade.filled_at, closeInfo.closed_at);
      } catch (e) {
        console.log('[earnings_during_hold] fetch failed', trade.id, trade.symbol, e);
        earnings_during_hold = false;
      }
    }

    // Auto-applied outcome tags. Computed at close time so the user doesn't
    // have to remember which short puts got assigned, which CCs got called
    // away, etc. Tags only add — never remove user-set tags.
    //   - STO put + closed_by='assigned'  → 'assigned' (also inherited by the
    //     spawned stock trade via buildAssignmentTrade tag-inheritance)
    //   - STO call + closed_by='assigned' → 'called_away' (no child spawn —
    //     shares are simply gone)
    //   - STO put/call + closed_by='expired' + realized_pnl > 0
    //                                    → 'expired_worthless' (kept the full premium)
    const autoTags: string[] = [];
    if (
      trade.asset_class === 'option'
      && trade.side === 'STO'
      && closeInfo.closed_by === 'assigned'
    ) {
      autoTags.push(trade.contract_type === 'call' ? 'called_away' : 'assigned');
    }
    if (
      trade.asset_class === 'option'
      && trade.side === 'STO'
      && closeInfo.closed_by === 'expired'
      && (closeInfo.realized_pnl ?? 0) > 0
    ) {
      autoTags.push('expired_worthless');
    }
    const mergedTags = autoTags.length > 0
      ? Array.from(new Set([...(trade.tags ?? []), ...autoTags]))
      : trade.tags;

    // Update trade record
    const closedTrade: Trade = {
      ...trade,
      closed_at: closeInfo.closed_at,
      closed_avg_price: closeInfo.closed_avg_price,
      realized_pnl: closeInfo.realized_pnl,
      closed_by: closeInfo.closed_by,
      alpaca_close_order_id: closeInfo.alpaca_close_order_id ?? trade.alpaca_close_order_id,
      earnings_during_hold,
      tags: mergedTags,
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

    // The close itself is already persisted above. AI grading is the only
    // expensive step, so it's budgeted: grade inline while budget remains,
    // otherwise queue for a later tick (the trade still shows closed with P&L
    // immediately — only the hindsight letter is deferred).
    if (aiGrades < gradeBudget) {
      if (await gradeClosedTrade(closedTrade)) aiGrades += 1;
    } else {
      await enqueueNeedsGrade(closedTrade.id);
    }
  }

  // Correct the sweep cursor to where we actually stopped (matters when the
  // loop broke early on timeBudget — a follow-up call then resumes from here
  // instead of re-walking from the pre-set full-window position).
  if (N > 0) await kv().set(KV_KEYS.tradesSweepCursor, (start + processed) % N);

  // Drain assignments-pending — spawn follow-on stock trades for assigned puts
  const drainResult = await drainAssignmentsAndSpawn();

  // Auto-import bot-opened trades from every bot-touched account so they show
  // up on /trades automatically (was previously a one-shot manual operation
  // in Settings). Failures per account are swallowed so one bad account
  // doesn't block grading or the other imports. See runAutoImport() below.
  const importResult = await runAutoImport();

  return {
    graded,
    synced,
    remaining_open: remaining,
    assignments_spawned: drainResult.spawned,
    assignments_skipped: drainResult.skipped,
    auto_imported: importResult,
  };
}

/**
 * Fetch context bars and run the AI hindsight grade for an already-closed
 * trade, writing the result onto its grade record. Returns true if a grade
 * was produced, false if there was no grade record to attach to (nothing to
 * do). Throws are the caller's responsibility to budget around — but the bars
 * fetch is best-effort (grading proceeds without bars).
 */
async function gradeClosedTrade(closedTrade: Trade): Promise<boolean> {
  const grade = await kv().get<GradeRecord>(gradeKey(closedTrade.id));
  if (!grade) return false;

  const start = closedTrade.filled_at ?? closedTrade.submitted_at;
  const end = closedTrade.closed_at ?? new Date().toISOString();
  let bars: Array<{ t: string; c: number }> = [];
  try {
    const data = await alpacaData<any>(modeFromAccount(closedTrade.account), '/v2/stocks/bars', {
      symbols: closedTrade.symbol, timeframe: '1Min', start, end, limit: 500,
    });
    bars = (data?.bars?.[closedTrade.symbol] ?? []).map((b: any) => ({ t: b.t, c: b.c }));
  } catch { /* bars are optional */ }

  const hindsight = await gradeTrade({ trade: closedTrade, bars });
  await kv().set(gradeKey(closedTrade.id), { ...grade, hindsight });
  return true;
}

/** Append a trade id to the needs-grade queue (deduped, JSON-array backed). */
async function enqueueNeedsGrade(id: string): Promise<void> {
  const q = (await kv().get<string[]>(KV_KEYS.tradesIndexNeedsGrade)) ?? [];
  if (q.includes(id)) return;
  q.push(id);
  await kv().set(KV_KEYS.tradesIndexNeedsGrade, q);
}

/**
 * Grade up to `budget` queued closed-but-ungraded trades. Returns how many AI
 * grades were performed (so the caller can subtract from its per-tick budget).
 * Entries whose trade/grade record is gone are dropped from the queue.
 */
async function drainNeedsGrade(budget: number): Promise<number> {
  if (budget <= 0) return 0;
  const q = (await kv().get<string[]>(KV_KEYS.tradesIndexNeedsGrade)) ?? [];
  if (q.length === 0) return 0;

  let used = 0;
  const remainingQueue: string[] = [];
  for (const id of q) {
    if (used >= budget) { remainingQueue.push(id); continue; }
    const t = await kv().get<Trade>(tradeKey(id));
    if (!t || !t.closed_at) continue; // gone or no longer closed — drop silently
    // Already graded (e.g. the user hit "grade now")? Drop without re-grading.
    const g = await kv().get<GradeRecord>(gradeKey(id));
    if (g?.hindsight) continue;
    try {
      if (await gradeClosedTrade(t)) used += 1;
    } catch (e) {
      console.error('drainNeedsGrade gradeClosedTrade failed', id, e);
      remainingQueue.push(id); // keep for retry
    }
  }
  await kv().set(KV_KEYS.tradesIndexNeedsGrade, remainingQueue);
  return used;
}

// Per-account auto-import tag policy:
//   - cons/agg/sm* accounts are 100% bot-driven, so any fill found in the
//     activity log that isn't already in our trades index must have been
//     opened by the bot → tag 'bot_opened' in addition to 'imported'.
//   - manual/live accounts mix bot-opens (auto-spread on manual since
//     2026-05-22; live = real money) with hand-opens via Alpaca's web UI,
//     so we can't reliably attribute either way → tag 'imported' only.
const AUTO_IMPORT_ACCOUNTS: Array<{ account: string; extraTags: string[] }> = [
  { account: 'conservative_paper', extraTags: ['bot_opened'] },
  { account: 'aggressive_paper',   extraTags: ['bot_opened'] },
  { account: 'manual_paper',       extraTags: [] },
  { account: 'live',               extraTags: [] },
  { account: 'sm500_paper',        extraTags: ['bot_opened'] },
  { account: 'sm1000_paper',       extraTags: ['bot_opened'] },
  { account: 'sm2000_paper',       extraTags: ['bot_opened'] },
];

// First-run cursor — start 7 days back so we don't sweep the entire account
// history on the first auto-import (Tim's already used the one-shot importer
// for historical backfill).
const AUTO_IMPORT_INITIAL_LOOKBACK_MS = 7 * 86400000;

async function runAutoImport(): Promise<Record<string, number | string>> {
  // Dynamic import breaks the module-init cycle with trades/[action] (which
  // imports runGradeOpenTrades from this file). Top-level static import would
  // work in V8 ESM but Vercel's bundler doesn't guarantee that — safer this
  // way and the call is rare (once per cron tick).
  const { runImport } = await import('../trades/[action].js');
  const result: Record<string, number | string> = {};
  const now = new Date();
  for (const { account, extraTags } of AUTO_IMPORT_ACCOUNTS) {
    if (account === 'live' && process.env.LIVE_ENABLED !== 'true') {
      result[account] = 'skipped_live_disabled';
      continue;
    }
    const cursorKey = importCursorKey(account);
    const stored = await kv().get<string>(cursorKey);
    const since = stored ?? new Date(now.getTime() - AUTO_IMPORT_INITIAL_LOOKBACK_MS).toISOString();
    try {
      const summary = await runImport({ account: account as any, since, extraTags });
      // Advance the cursor only on success so a failed tick can retry the
      // same window next time without missing fills.
      await kv().set(cursorKey, now.toISOString());
      result[account] = summary.imported;
    } catch (e) {
      result[account] = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return result;
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
    await appendMonthIndex(currentMonth(), newTrade.id);
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
  // D7 sentinel: once we've confirmed a fill from Alpaca and written
  // fill_confirmed:true, the fill data is captured and immutable —
  // no further Alpaca order fetch is needed. Early-return without any
  // network call so we don't burn rate budget on every 5-min tick for
  // every filled trade across all 7 accounts.
  //
  // Undefined on legacy/pre-D7 trades → fall through and confirm once.
  if (trade.fill_confirmed) return trade;

  // Legacy guard (pre-D7): filled AND has modify history recorded.
  // For these trades the fill is already known (filled_at is set), so stamp
  // fill_confirmed:true and persist once — the primary D7 sentinel above then
  // short-circuits on every subsequent tick without any Alpaca fetch.
  // Without this convergence step the guard would fire on EVERY tick, leaving
  // fill_confirmed permanently unset and causing D14 to defer spread-close
  // P&L bookkeeping for the full 24h backstop.
  if (trade.filled_at && (trade.modify_history?.length ?? 0) > 0) {
    const converged: Trade = { ...trade, fill_confirmed: true };
    await kv().set(tradeKey(trade.id), converged);
    return converged;
  }

  const mode = modeFromAccount(trade.account);

  // Shared helper — forward walk to the terminal order following replaced_by.
  // Caps at 10 hops to guard against malformed/cyclic chains. Returns the
  // terminal order object (the last one without replaced_by, or the last one
  // we could reach before the cap or a fetch failure).
  // nested=true is REQUIRED for multi-leg (mleg) spread orders: without it
  // Alpaca returns the parent order with NO `legs` array, so the spread fill
  // sync below can never match its legs and `filled_at` is never written —
  // the trade is stuck at "submitted" forever (the bug that left every
  // dashboard-placed spread showing a "—" fill). Harmless for single-leg
  // orders (they simply have no legs to roll up).
  const fetchOrderById = async (id: string): Promise<any> => {
    try { return await alpacaTrade<any>(mode, `/v2/orders/${id}`, { nested: 'true' }); }
    catch (e) {
      console.error('syncFillData order fetch failed', trade.id, id, e);
      return null;
    }
  };

  const walkToTerminal = async (startId: string): Promise<any> => {
    let cursor = await fetchOrderById(startId);
    if (!cursor) return null;
    const seen = new Set<string>([cursor.id]);
    for (let hops = 0; hops < 10 && cursor.replaced_by; hops++) {
      if (seen.has(cursor.replaced_by)) break; // cycle guard
      const next = await fetchOrderById(cursor.replaced_by);
      if (!next) break;
      seen.add(next.id);
      cursor = next;
    }
    return cursor;
  };

  // Spread (mleg) path — Alpaca returns a single order with a `legs` array.
  // Match each leg's OCC symbol to short/long and copy fill prices back onto
  // the spread block. Net credit is recomputed from actual fills (may differ
  // from the order's target net credit by a few cents of slippage).
  //
  // A user CAN modify a spread's limit price on Alpaca's web UI. Alpaca then
  // cancels the original mleg order (status='replaced') and creates a successor
  // linked via replaced_by. We walk the chain to the terminal order before
  // reading fill status — same as the single-leg path below.
  if (trade.asset_class === 'spread' && trade.spread) {
    const terminal = await walkToTerminal(trade.alpaca_order_id);
    if (!terminal) return trade;

    // Repoint alpaca_order_id to terminal even if not yet filled, so next tick
    // reads directly from the current order without re-walking the chain.
    const idChanged = terminal.id !== trade.alpaca_order_id;

    if (terminal.status !== 'filled') {
      if (idChanged) {
        const updated: Trade = { ...trade, alpaca_order_id: terminal.id };
        await kv().set(tradeKey(trade.id), updated);
        return updated;
      }
      return trade;
    }

    const legs = terminal.legs ?? [];
    let shortFill = legs.find((l: any) => l.symbol === trade.spread!.short_leg.occ);
    let longFill = legs.find((l: any) => l.symbol === trade.spread!.long_leg.occ);

    // Belt-and-suspenders: if the parent order came back without usable legs
    // (e.g. an account/order shape where nested roll-up is unavailable), fall
    // back to the FILL activity stream for each leg's opening fill so the
    // trade can still confirm instead of being stuck open forever.
    if (!shortFill || !longFill) {
      const [s, l] = await Promise.all([
        shortFill ? Promise.resolve(shortFill) : findOpeningLegFill(mode, trade, trade.spread.short_leg.occ, 'sell'),
        longFill ? Promise.resolve(longFill) : findOpeningLegFill(mode, trade, trade.spread.long_leg.occ, 'buy'),
      ]);
      shortFill = s;
      longFill = l;
    }
    if (!shortFill || !longFill) return trade;

    // Leg fill price comes from `filled_avg_price` (nested order leg) or
    // `price` (activity-stream fallback). Same for the leg order id.
    const shortPx = parseFloat(shortFill.filled_avg_price ?? shortFill.price);
    const longPx = parseFloat(longFill.filled_avg_price ?? longFill.price);
    if (!Number.isFinite(shortPx) || !Number.isFinite(longPx)) return trade;
    const netCredit = shortPx - longPx;
    const filledAt =
      terminal.filled_at ?? shortFill.transaction_time ?? longFill.transaction_time ?? new Date().toISOString();
    const updated: Trade = {
      ...trade,
      alpaca_order_id: terminal.id,          // pin to terminal order
      filled_at: filledAt,
      filled_avg_price: netCredit,           // back-compat for legacy consumers
      fill_confirmed: true,                  // D7 sentinel: skip sync on future ticks
      spread: {
        ...trade.spread,
        // Persist the per-leg Alpaca order ids so a later /api/trades/import
        // dedups against this dashboard-placed spread (orderIdAlreadyImported
        // checks spread.short_leg.order_id) instead of creating a duplicate.
        // Order id: nested mleg legs carry it as `id` (no order_id field);
        // activity-stream fallback rows carry the real order id as `order_id`
        // (their `id` is the ACTIVITY id). Prefer order_id, fall back to id.
        short_leg: { ...trade.spread.short_leg, fill_price: shortPx, order_id: shortFill.order_id ?? shortFill.id ?? trade.spread.short_leg.order_id },
        long_leg: { ...trade.spread.long_leg, fill_price: longPx, order_id: longFill.order_id ?? longFill.id ?? trade.spread.long_leg.order_id },
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
  // (Uses fetchOrderById + walkToTerminal defined above, shared with the spread path.)

  // Forward walk to terminal
  const terminal = await walkToTerminal(trade.alpaca_order_id);
  if (!terminal) return trade;

  // Backward walk from terminal to collect prior orders. Start with the
  // terminal in the chain, prepend each `replaces` predecessor.
  const chain: any[] = [terminal];
  for (let hops = 0; hops < 10 && chain[0]?.replaces; hops++) {
    const prev = await fetchOrderById(chain[0].replaces);
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
    fill_confirmed: true,      // D7 sentinel: skip sync on future ticks
  };
  await kv().set(tradeKey(trade.id), updated);
  return updated;
}

/**
 * For a past-expiry STO option, ask Alpaca's account activity stream whether
 * the contract was assigned (OPASN) or expired worthless (OPEXP). Returns
 * null when no matching activity has posted yet (caller should retry on a
 * later tick). Matching is by OCC contract symbol; legacy trades with no
 * contract_symbol can't be matched and resolve as 'expired'.
 */
async function resolveOptionSettlement(
  mode: Mode,
  trade: Trade,
): Promise<'assigned' | 'expired' | null> {
  if (!trade.contract_symbol) return 'expired';
  // Window the activity fetch from a few days before expiry. The OPEXP/OPASN
  // posts on/after the expiration date, but Alpaca's `after` filter is
  // date-granular and may be strictly-after — so anchoring exactly on the
  // expiration date risks excluding a same-day settlement. A wider window is
  // safe because we match precisely on the OCC contract symbol below, which
  // is unique to this contract/strike/expiry.
  let after: string | undefined;
  if (trade.expiration) {
    const d = new Date(trade.expiration + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 5);
    after = d.toISOString().slice(0, 10);
  }
  let activities: any[] = [];
  try {
    const raw = await alpacaTrade<any[]>(mode, '/v2/account/activities', {
      activity_types: 'OPEXP,OPASN',
      after,
      page_size: 100,
    });
    activities = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('resolveOptionSettlement activities fetch failed', trade.id, e);
    return null; // transient — treat as "not posted yet" and retry next tick
  }
  const match = activities.filter(
    (a) => a?.symbol === trade.contract_symbol
      && (a?.activity_type === 'OPEXP' || a?.activity_type === 'OPASN'),
  );
  if (match.length === 0) return null;
  // If a partial assignment posts both an OPASN and an OPEXP for the same
  // contract, the assignment is the economically significant event — it's
  // what delivers shares, spawns the follow-on stock trade, and changes the
  // hindsight grading context.
  if (match.some((a) => a.activity_type === 'OPASN')) return 'assigned';
  return 'expired';
}

async function detectClose(trade: Trade): Promise<CloseInfo | null> {
  const mode = modeFromAccount(trade.account);

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

  // Path 2: option past expiration with no close order.
  if (trade.asset_class === 'option' && trade.expiration) {
    const expDate = new Date(trade.expiration + 'T20:00:00Z'); // 4 PM ET ~= 20:00 UTC during DST
    if (Date.now() > expDate.getTime()) {
      // STO: a short option past expiry either expired worthless (OTM) or was
      // assigned (ITM). Both leave the same option-leg economics — full premium
      // kept, contract gone — but only an assignment delivers shares, so the
      // distinction drives the follow-on stock-trade spawn and the hindsight
      // grading context. Alpaca records this in the account activity stream
      // (OPEXP = expired, OPASN = assigned); the contract itself is not an
      // order so there's nothing in /v2/orders to read.
      if (trade.side === 'STO') {
        const settlement = await resolveOptionSettlement(mode, trade);
        if (settlement === null) {
          // Activity hasn't posted yet (Alpaca posts OPEXP/OPASN the evening
          // of / morning after expiry). Leave the trade open and retry next
          // tick — UNLESS we're past the backstop window.
          if (Date.now() < expDate.getTime() + SETTLEMENT_BACKSTOP_MS) return null;

          // D11 — Past the backstop and settlement is still unconfirmed.
          //
          // Old (unsafe) path: assume 'expired' and book a win. This silently
          // fabricates an expired-worthless P&L for a contract that may have
          // been ASSIGNED. If it was truly assigned, the 100 delivered shares
          // get no trade record and are invisible to exposure/P&L.
          //
          // New (conservative) path:
          //
          // (1) Guard null filled_avg_price — booking realized_pnl=0 from a null
          //     price is misleading (looks like a clean breakeven). If we can't
          //     even confirm the entry premium, leave the trade open and log.
          if (trade.filled_avg_price === null || trade.filled_avg_price === undefined) {
            console.warn(
              `[D11] settlement unconfirmed past backstop AND filled_avg_price is null — leaving open for manual review`,
              trade.id,
              trade.contract_symbol,
            );
            return null;
          }
          //
          // (2) Cross-check the underlying stock position for assignment evidence.
          //     A short put that was assigned delivers 100 × qty shares to the
          //     account. If such a position is present, treat it as confirmation
          //     of assignment and book accordingly so the spawn fires.
          //
          //     KNOWN LIMITATION: this check cannot distinguish a freshly-assigned
          //     position from shares the user already held before the put was
          //     written. If the user held ≥ 100×qty pre-existing shares, this may
          //     produce a false-positive 'assigned' booking. That is accepted over
          //     the alternative: a false-negative that silently loses real equity.
          //     A false-positive creates a visible spawned stock trade the user can
          //     review/delete; a false-negative creates invisible shares with a
          //     wrong P&L record.
          //
          //     If no shares are found (position 404) or there is any transient
          //     error, we fall through to the conservative leave-open path.
          const assignedSharesRequired = 100 * trade.qty;
          let underlyingQty = 0;
          try {
            const pos = await alpacaTrade<any>(mode, `/v2/positions/${encodeURIComponent(trade.symbol)}`);
            underlyingQty = Math.abs(Number(pos?.qty ?? 0));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes(' 404 ')) {
              // Transient error (not a missing-position 404) — be conservative.
              console.error(
                `[D11] positions fetch failed (non-404), leaving trade open for retry`,
                trade.id,
                trade.symbol,
                e,
              );
              return null;
            }
            // 404 → no position → fall through to leave-open path
          }

          if (underlyingQty >= assignedSharesRequired) {
            // Assignment evidence found — book as 'assigned' so the spawn fires.
            return {
              closed_at: expDate.toISOString(),
              closed_avg_price: 0,
              realized_pnl: trade.filled_avg_price * 100 * trade.qty,
              closed_by: 'assigned' as const,
            };
          }

          // No assignment evidence (position absent or insufficient qty).
          // Do NOT fabricate an expired-worthless win — leave the trade open
          // and emit a visible warning so it can be reviewed.
          console.warn(
            `[D11] settlement unconfirmed past backstop, no assignment evidence — leaving open for manual review`,
            trade.id,
            trade.contract_symbol,
            `underlying_qty=${underlyingQty}`,
            `required_for_assignment=${assignedSharesRequired}`,
          );
          return null;
        }
        // Settlement confirmed by Alpaca activity (OPEXP or OPASN).
        const closedBy = settlement === 'assigned' ? 'assigned' : 'expired';
        return {
          closed_at: expDate.toISOString(),
          closed_avg_price: 0,
          realized_pnl: (trade.filled_avg_price ?? 0) * 100 * trade.qty,
          closed_by: closedBy,
        };
      }
      // BTO expired worthless: lost full premium. (Long-option exercise is not
      // modeled — the wheel strategies never buy long options to exercise.)
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

  // Path 2b-pre: a REAL external close is ground truth and must be detected BEFORE
  // the spot-vs-strikes expiry fabrication below. Otherwise a spread the bot closed
  // *before* expiry gets re-booked as a fabricated worthless/ITM expiry once its
  // expiration date passes — the MU phantom-+$950 bug (closed −$185 on 06-16,
  // mis-booked +$950 on the 06-18 expiry tick). detectExternalSpreadClose returns
  // null when no closing fills exist (a genuine expiry), so real expiries still fall
  // through to Path 2b below.
  if (trade.asset_class === 'spread' && trade.spread) {
    const realClose = await detectExternalSpreadClose(mode, trade);
    if (realClose) return realClose;
  }

  // Path 2b: spread past expiration with no close order = resolve by spot vs strikes.
  // The bot (Phase 2 handle_spread) clears the legs on Alpaca's side at expiry, but
  // the dashboard's trade record stays pinned to trades:index:open with closed_at=null
  // unless we resolve it here.
  //
  // D12 — debit-spread geometry is the INVERSE of credit spreads:
  //
  // Credit spreads (put_credit, call_credit):
  //   • spot >= short_strike  → legs worthless OTM, keep full net_credit (max profit)
  //   • spot <  long_strike   → legs deep ITM, full max_loss
  //   • between strikes       → partial, leave for manual
  //
  // Debit spreads (put_debit, call_debit):
  //   put_debit  (short = lower strike, long = higher strike — BTO the expensive one):
  //     • spot < short_strike  → both puts ITM → max profit (= max_profit × 100)
  //     • spot >= long_strike  → both puts OTM → full debit lost (= -net_debit × 100)
  //     • between strikes      → partial, leave for manual
  //   call_debit (short = higher strike, long = lower strike — BTO the cheap one):
  //     • spot >= short_strike → both calls ITM → max profit
  //     • spot <  long_strike  → both calls OTM → full debit lost
  //     • between strikes      → partial, leave for manual
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

      const { spread_type, short_leg, long_leg, net_credit, max_loss, width } = trade.spread;
      const net_debit = trade.spread.net_debit ?? 0;
      const max_profit = trade.spread.max_profit ?? net_credit; // backward-compat: pre-D12 records lack max_profit
      const qty = short_leg.qty;
      const isCredit = spread_type === 'put_credit' || spread_type === 'call_credit';

      if (isCredit) {
        // Credit spread: OTM when spot >= short_strike (put_credit: short is higher strike,
        // call_credit: short is lower strike — both cases the short leg defines "worthless" side).
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
      } else {
        // Debit spread: geometry is inverted vs credit.
        // put_debit  (short=lower strike, long=higher strike):
        //   max profit when spot < short_leg.strike (both ITM)
        //   max loss   when spot >= long_leg.strike  (both OTM, worthless)
        // call_debit (short=higher strike, long=lower strike):
        //   max profit when spot >= short_leg.strike (both ITM)
        //   max loss   when spot < long_leg.strike   (both OTM, worthless)
        const isMaxProfit = spread_type === 'put_debit'
          ? spot < short_leg.strike
          : spot >= short_leg.strike;  // call_debit
        const isMaxLoss = spread_type === 'put_debit'
          ? spot >= long_leg.strike
          : spot < long_leg.strike;    // call_debit

        if (isMaxProfit) {
          return {
            closed_at: expDate.toISOString(),
            closed_avg_price: 0,
            realized_pnl: Math.round(max_profit * 100 * qty * 100) / 100,
            closed_by: 'expired',
          };
        }
        if (isMaxLoss) {
          return {
            closed_at: expDate.toISOString(),
            closed_avg_price: 0,
            realized_pnl: Math.round(-net_debit * 100 * qty * 100) / 100,
            closed_by: 'expired',
          };
        }
      }
      // Between strikes — partial loss, leave for manual close
      console.warn(
        `[${trade.id}] spread expired between strikes (spot=${spot}, short=${short_leg.strike}, long=${long_leg.strike}) — leaving for manual close`,
      );
      return null;
    }
  }

  // Path 3: external bot-close detection for filled options + spreads.
  //
  // The bot manages user-opened CSPs / spreads / wheel positions via its own
  // Alpaca client. When it buys-to-close at 50% profit (or hits a stop, or
  // closes a spread leg pair), the dashboard's trade record has no
  // alpaca_close_order_id and the contract is just gone from positions. Path 1
  // can't fire (no close id linked), Path 2 can't fire (option isn't past
  // expiry yet). Without this path, the trade stays "open" forever even
  // though the position is gone.
  //
  // Approach: check current positions for the contract; if missing, walk the
  // /v2/account/activities FILL stream to find the matching closing fill(s),
  // and pin a synthetic close using the fill's price/timestamp/order_id.
  // Stocks are skipped (partial closes are common and FIFO matching is out of
  // scope for v1 — the rationale that ships with Path 3 above for stocks).
  if (trade.asset_class === 'option' && trade.contract_symbol) {
    const closeInfo = await detectExternalOptionClose(mode, trade);
    if (closeInfo) return closeInfo;
  }
  // (spread external-close is handled in Path 2b-pre above — moved ahead of the
  // Path 2b expiry fabrication so a real close always wins over a spot guess.)

  return null;
}

/**
 * Check whether an open option position has been closed externally (by the
 * bot's own Alpaca client, or by a hand-placed close on Alpaca's web UI).
 * Returns a CloseInfo if the position is gone and a matching closing fill
 * can be found in the account activity stream; returns null otherwise.
 *
 * Matching: position symbol == OCC. Closing fill side is the opposite of
 * the open (STO → buy to close, BTO → sell to close).
 */
async function detectExternalOptionClose(mode: Mode, trade: Trade): Promise<CloseInfo | null> {
  const occ = trade.contract_symbol!;
  if (await positionExists(mode, occ)) return null;

  const expectedSide = closingSideFor(trade.side);
  if (!expectedSide) return null;

  const fill = await findClosingFill(mode, trade, occ, expectedSide);
  if (!fill) return null;

  const fillPx = Number(fill.price);
  if (!Number.isFinite(fillPx)) return null;

  return {
    closed_at: fill.transaction_time ?? new Date().toISOString(),
    closed_avg_price: fillPx,
    realized_pnl: realizedPnl(trade, fillPx),
    closed_by: 'bot_external',
    alpaca_close_order_id: fill.order_id ?? null,
  };
}

/**
 * Spread variant of detectExternalOptionClose. Both legs must be gone from
 * positions before we declare the spread closed (a partial close — e.g. the
 * short leg gets bought back but the long survives — should NOT close the
 * trade record; the orphan-leg handler in the bot will pick it up).
 *
 * P&L uses the per-leg closing fill prices. closed_avg_price stores the net
 * debit paid to close (positive when the spread is bought back, signed
 * consistently with the open's net_credit).
 */
async function detectExternalSpreadClose(mode: Mode, trade: Trade): Promise<CloseInfo | null> {
  const shortOcc = trade.spread!.short_leg.occ;
  const longOcc = trade.spread!.long_leg.occ;

  // Both legs must be absent
  const [shortGone, longGone] = await Promise.all([
    positionExists(mode, shortOcc).then((b) => !b),
    positionExists(mode, longOcc).then((b) => !b),
  ]);
  if (!shortGone || !longGone) return null;

  // Find closing fills for both legs. Short was STO → look for buy; long was
  // BTO → look for sell.
  const shortFill = await findClosingFill(mode, trade, shortOcc, 'buy');
  const longFill = await findClosingFill(mode, trade, longOcc, 'sell');
  if (!shortFill || !longFill) return null;

  const shortPx = Number(shortFill.price);
  const longPx = Number(longFill.price);
  if (!Number.isFinite(shortPx) || !Number.isFinite(longPx)) return null;

  // D14 — Entry-fill confirmation guard.
  //
  // trade.spread.net_credit is the DECISION-TIME target mid until syncFillData
  // overwrites it with the real leg fill prices. In the common path, syncFillData
  // already ran (and set fill_confirmed:true) before detectClose is called.
  // However, on legacy pre-D7 trades that have filled_at AND non-empty
  // modify_history, syncFillData hits the legacy short-circuit and returns
  // without re-syncing — leaving net_credit at the stale mid. Computing
  // realized P&L from that stale value would produce a wrong number on /trades.
  //
  // Fix: if fill_confirmed is absent/false, defer the close to the next tick.
  // syncFillData stamps fill_confirmed:true and persists when it sees
  // filled_at set (both the common new-trade path and the legacy-guard
  // convergence path), so after one tick this guard is cleared and the close
  // proceeds with the confirmed net_credit.
  //
  // Backstop: if the trade is >24h old and still unconfirmed, book with what
  // we have and log the approximation. This prevents indefinite deferral in
  // the degenerate case where syncFillData persistently cannot reach KV.
  const D14_BACKSTOP_MS = 24 * 60 * 60 * 1000;
  if (!trade.fill_confirmed) {
    const submittedAt = trade.submitted_at ? new Date(trade.submitted_at).getTime() : 0;
    const ageMs = Date.now() - submittedAt;
    if (ageMs < D14_BACKSTOP_MS) {
      // Defer: let next tick's syncFillData confirm the real entry credit first.
      return null;
    }
    // Past backstop: book anyway to avoid leaving a real close invisible forever.
    console.warn(
      '[D14] spread close booked with unconfirmed net_credit (stale mid approximation)',
      trade.id, trade.symbol,
      `net_credit=${trade.spread!.net_credit}`,
      `age_hours=${Math.round(ageMs / 3600000)}`,
    );
  }

  const qty = trade.spread!.short_leg.qty;
  const spreadType = trade.spread!.spread_type;
  const isCredit = spreadType === 'put_credit' || spreadType === 'call_credit';

  // D12 — P&L formula differs for credit vs debit spreads.
  //
  // For ALL spread types, the closing fills are:
  //   shortPx = price paid to buy back the short leg (the STO side)
  //   longPx  = price received from selling the long leg (the BTO side)
  //
  // netCostToClose = shortPx − longPx:
  //   positive → we paid net (typical credit spread close — buy back short, sell long for less)
  //   negative → we received net (typical debit spread close — long gained more than short)
  //
  // Credit spread (opened for net_credit received):
  //   realized = (net_credit − netCostToClose) × 100 × qty
  //
  // Debit spread (opened for net_debit paid):
  //   realized = (−netCostToClose − net_debit) × 100 × qty
  //           = ((longPx − shortPx) − net_debit) × 100 × qty
  const netCostToClose = shortPx - longPx;
  let realized: number;
  if (isCredit) {
    const netCredit = trade.spread!.net_credit;
    realized = Math.round((netCredit - netCostToClose) * 100 * qty * 100) / 100;
  } else {
    const netDebitAtOpen = trade.spread!.net_debit ?? 0;
    realized = Math.round((-netCostToClose - netDebitAtOpen) * 100 * qty * 100) / 100;
  }

  // Pick the later of the two fill timestamps for closed_at — the trade
  // isn't truly closed until both legs are out.
  const shortTs = shortFill.transaction_time ?? '';
  const longTs = longFill.transaction_time ?? '';
  const closedAt = (shortTs > longTs ? shortTs : longTs) || new Date().toISOString();

  return {
    closed_at: closedAt,
    closed_avg_price: netCostToClose,  // net cost to unwind (negative = received net)
    realized_pnl: realized,
    closed_by: 'bot_external',
    alpaca_close_order_id: shortFill.order_id ?? null,
  };
}

/**
 * True if Alpaca has an open position for `symbol`. Returns false ONLY on
 * the 404 that Alpaca emits for a missing position (the expected case when
 * a contract has been closed). Any other error returns true — conservative:
 * a transient network/auth failure should NOT cause us to mark the trade
 * closed; the cron retries each tick so detection simply defers.
 */
async function positionExists(mode: Mode, symbol: string): Promise<boolean> {
  try {
    const pos = await alpacaTrade<any>(mode, `/v2/positions/${encodeURIComponent(symbol)}`);
    return !!pos;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Alpaca returns 404 when the position doesn't exist — treat as "gone."
    if (msg.includes(' 404 ')) return false;
    // Any other error: be conservative and don't mark the trade closed.
    console.error('positionExists fetch failed', symbol, e);
    return true;
  }
}

/**
 * STO and BTO are opens; STC/BTC don't make sense as opens here. Returns the
 * Alpaca activity-stream `side` of the matching CLOSE fill (lowercased to
 * match Alpaca's `side` field).
 */
function closingSideFor(openSide: string): 'buy' | 'sell' | null {
  if (openSide === 'STO') return 'buy';
  if (openSide === 'BTO') return 'sell';
  return null;
}

interface ActivityFill {
  id?: string;
  activity_type?: string;
  transaction_time?: string;
  symbol?: string;
  side?: string;
  price?: string;
  qty?: string;
  order_id?: string;
}

/** Maximum pages to walk in findClosingFill before giving up (10 pages × 100 = 1 000 activities). */
const MAX_FILL_PAGES = 10;

/**
 * Walk the Alpaca FILL activity stream for a fill matching this contract
 * symbol + side, after the trade's filled_at timestamp. Returns null when
 * no matching fill has posted yet.
 *
 * Window: starts one day before the trade's fill (defensive — handles
 * timezone edge cases) and runs through today. Paginates via `page_token`
 * until the matching fill is found, the stream is exhausted (< page_size
 * items returned), or MAX_FILL_PAGES is reached. If the cap is hit without
 * finding a match, a log is emitted so the miss is visible (not silently
 * dropped).
 */
async function findClosingFill(
  mode: Mode,
  trade: Trade,
  occ: string,
  side: 'buy' | 'sell',
): Promise<ActivityFill | null> {
  const filledAt = trade.filled_at;
  if (!filledAt) return null;
  const after = new Date(new Date(filledAt).getTime() - 86400000).toISOString().slice(0, 10);
  const openTs = Date.parse(filledAt);
  const PAGE_SIZE = 100;

  let pageToken: string | undefined;
  for (let page = 0; page < MAX_FILL_PAGES; page++) {
    let activities: ActivityFill[];
    try {
      const params: Record<string, string | number | undefined> = {
        activity_types: 'FILL',
        after,
        page_size: PAGE_SIZE,
      };
      if (pageToken) params.page_token = pageToken;
      const raw = await alpacaTrade<ActivityFill[]>(mode, '/v2/account/activities', params);
      activities = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error('findClosingFill activities fetch failed', trade.id, occ, e);
      return null;
    }

    // Check this page for a matching closing fill.
    for (const a of activities) {
      if (a.symbol !== occ) continue;
      if ((a.side ?? '').toLowerCase() !== side) continue;
      if (!a.transaction_time) continue;
      if (Date.parse(a.transaction_time) <= openTs) continue;
      // Found — return immediately without over-fetching.
      return a;
    }

    // End of stream: fewer items than a full page means no more data.
    if (activities.length < PAGE_SIZE) return null;

    // Advance the cursor: use the `id` of the last item as `page_token`.
    const lastId = activities[activities.length - 1]?.id;
    if (!lastId) return null; // No id to paginate with — stop.
    pageToken = lastId;
  }

  // Page cap reached without finding a match.
  console.log(
    `findClosingFill page cap reached (${MAX_FILL_PAGES} pages)`,
    trade.id, occ, 'no matching closing fill found — will retry next cron tick',
  );
  return null;
}

/**
 * Fallback for the spread fill-sync when the nested mleg order doesn't
 * surface its legs: walk the FILL activity stream for this leg's OPENING
 * fill (short leg → 'sell', long leg → 'buy') on or after the spread's
 * submission time. Returns the raw activity (with `price`, `order_id`,
 * `transaction_time`) or null if no matching fill has posted yet.
 */
async function findOpeningLegFill(
  mode: Mode,
  trade: Trade,
  occ: string,
  side: 'buy' | 'sell',
): Promise<ActivityFill | null> {
  const submitted = trade.submitted_at ? Date.parse(trade.submitted_at) : NaN;
  // Start the date window a day before submission to absorb timezone edges.
  const anchor = Number.isFinite(submitted) ? submitted : Date.now();
  const after = new Date(anchor - 86400000).toISOString().slice(0, 10);
  const PAGE_SIZE = 100;

  let pageToken: string | undefined;
  for (let page = 0; page < MAX_FILL_PAGES; page++) {
    let activities: ActivityFill[];
    try {
      const params: Record<string, string | number | undefined> = {
        activity_types: 'FILL',
        after,
        page_size: PAGE_SIZE,
      };
      if (pageToken) params.page_token = pageToken;
      const raw = await alpacaTrade<ActivityFill[]>(mode, '/v2/account/activities', params);
      activities = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error('findOpeningLegFill activities fetch failed', trade.id, occ, e);
      return null;
    }

    for (const a of activities) {
      if (a.symbol !== occ) continue;
      if ((a.side ?? '').toLowerCase() !== side) continue;
      return a;
    }

    if (activities.length < PAGE_SIZE) return null;
    const lastId = activities[activities.length - 1]?.id;
    if (!lastId) return null;
    pageToken = lastId;
  }
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

  const idsByMonth = await Promise.all(months.map((m) => readMonthIndex(m)));
  const allIds = idsByMonth.flat();

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
  const entryRef = t.filled_at ?? t.submitted_at;
  let dte_at_entry: number | null = null;
  if (t.expiration && entryRef) {
    const exp = Date.parse(`${t.expiration}T20:00:00Z`);
    const ref = Date.parse(entryRef);
    if (!isNaN(exp) && !isNaN(ref)) {
      dte_at_entry = Math.max(0, Math.round((exp - ref) / 86400000));
    }
  }
  return {
    id: t.id,
    symbol: t.symbol,
    account: t.account,
    asset_class: t.asset_class,
    option_type: t.contract_type,
    side: t.side,
    submitted_at: t.submitted_at,
    filled_at: t.filled_at,
    closed_at: t.closed_at!,
    closed_by: t.closed_by,
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
    dte_at_entry,
    chased_during_open: computeChased(t),
    cost_basis_at_entry: t.cost_basis_at_entry ?? null,
    earnings_during_hold: t.earnings_during_hold ?? false,
  };
}

function computeChased(t: Trade): boolean {
  const hist = t.modify_history ?? [];
  if (hist.length < 2) return false;
  const prices: number[] = [];
  if (t.limit_price != null) prices.push(t.limit_price);
  for (const ev of hist) {
    if (ev.limit_price == null) return false;
    prices.push(ev.limit_price);
  }
  if (prices.length < 3) return false;
  const isSell = t.side === 'sell' || t.side === 'STO' || t.side === 'STC';
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (isSell) {
      if (diff >= 0) return false;
    } else {
      if (diff <= 0) return false;
    }
  }
  return true;
}
