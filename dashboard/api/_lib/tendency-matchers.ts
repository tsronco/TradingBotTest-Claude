// dashboard/api/_lib/tendency-matchers.ts
//
// Six deterministic matchers that scan closed trades for behavioral patterns.
// Each matcher inspects the full trade list and returns a Finding when its
// criteria fire. Findings are deduped by `key` (matcher + dimension) so the
// cron's proposal generator can avoid re-suggesting the same pattern twice.
//
// Matchers are pure (no I/O, no LLM, no KV). The cron uses the LLM only to
// rephrase a finding into journal-quality rule prose.

import { gradeIndex } from './trade-types.js';
import type { GradeLetter, ClosedBy, AccountId } from './trade-types.js';
import type { MatcherName, Trigger, Severity } from './rules-types.js';

export interface ClosedTradeView {
  id: string;
  symbol: string;
  account: AccountId;
  asset_class: 'stock' | 'option' | 'spread';
  option_type: 'put' | 'call' | null;
  side: string;
  submitted_at: string;
  filled_at: string | null;
  closed_at: string;
  closed_by: ClosedBy;
  realized_pnl: number;
  user_grade: GradeLetter;
  ai_grade: GradeLetter | null;
  tags: string[];
  rule_violations: Array<{ rule: string; severity: Severity; override_reason?: string }>;
  strike: number | null;
  expiration: string | null;
  /** Days-to-expiration at order-entry time. Null for stocks. */
  dte_at_entry: number | null;
  /** True iff modify_history shows a monotonic worsening walk (chasing the fill). */
  chased_during_open: boolean;
  /** Cost basis of the underlying at the time a covered call was sold. Null when N/A. */
  cost_basis_at_entry: number | null;
  /** True iff an earnings event fell between entry and exit. Populated by the grade-cron. */
  earnings_during_hold: boolean;
}

export interface Finding {
  matcher: MatcherName;
  finding: string;                   // plain-English summary (Sonnet rewrites for proposal text)
  evidence_trade_ids: string[];
  /** Dedup key: `matcher:dimension` (e.g. `loss_concentration_by_symbol:F`). */
  key: string;
  /** True if this finding should generate a proposal. False for informational-only findings. */
  actionable: boolean;
  suggested_severity: Severity;
  suggested_triggers: Trigger[];
}

export function runMatchers(trades: ClosedTradeView[]): Finding[] {
  const out: Finding[] = [];
  const f1 = lossConcentrationBySymbol(trades);   if (f1) out.push(f1);
  const f2 = lossConcentrationBySide(trades);     if (f2) out.push(f2);
  const f3 = ccBelowCostBasis(trades);            if (f3) out.push(f3);
  const f4 = heldThroughEarnings(trades);         if (f4) out.push(f4);
  const f5 = overrideLossPattern(trades);         out.push(...f5);
  const f6 = overGradingSelf(trades);             if (f6) out.push(f6);
  const f7 = revengeTradePattern(trades);         if (f7) out.push(f7);
  out.push(...lossConcentrationByTag(trades));
  out.push(...dteBucketLossPattern(trades));
  const f10 = chaseModifyPattern(trades);         if (f10) out.push(f10);
  const f11 = winnerCutShort(trades);             if (f11) out.push(f11);
  return out;
}

function groupBy<T>(arr: T[], k: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of arr) (out[k(x)] ??= []).push(x);
  return out;
}

function lossConcentrationBySymbol(trades: ClosedTradeView[]): Finding | null {
  const bySymbol = groupBy(trades, (t) => t.symbol);
  for (const [symbol, ts] of Object.entries(bySymbol)) {
    if (ts.length < 3) continue;
    const wins = ts.filter((t) => t.realized_pnl > 0).length;
    const winRate = wins / ts.length;
    const total = ts.reduce((s, t) => s + t.realized_pnl, 0);
    if (winRate < 0.4 && total < 0) {
      return {
        matcher: 'loss_concentration_by_symbol',
        finding: `${ts.length} trades on ${symbol}, ${(winRate * 100).toFixed(0)}% win rate, total P&L ${total.toFixed(0)}`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `loss_concentration_by_symbol:${symbol}`,
        actionable: true,
        suggested_severity: 'warn',
        suggested_triggers: [{ type: 'symbol_in', symbols: [symbol] }],
      };
    }
  }
  return null;
}

function lossConcentrationBySide(trades: ClosedTradeView[]): Finding | null {
  const groups: Record<string, ClosedTradeView[]> = {};
  for (const t of trades) {
    const k = `${t.asset_class}:${t.option_type ?? 'na'}`;
    (groups[k] ??= []).push(t);
  }
  for (const [k, ts] of Object.entries(groups)) {
    if (ts.length < 5) continue;
    const wins = ts.filter((t) => t.realized_pnl > 0).length;
    const winRate = wins / ts.length;
    if (winRate < 0.4) {
      const [ac, ot] = k.split(':');
      const triggers: Trigger[] = [{ type: 'asset_class', value: ac as 'stock' | 'option' }];
      if (ot !== 'na') triggers.push({ type: 'option_type', value: ot as 'put' | 'call' });
      return {
        matcher: 'loss_concentration_by_side',
        finding: `${ts.length} ${k} trades, ${(winRate * 100).toFixed(0)}% win rate`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `loss_concentration_by_side:${k}`,
        actionable: true,
        suggested_severity: 'warn',
        suggested_triggers: triggers,
      };
    }
  }
  return null;
}

function ccBelowCostBasis(trades: ClosedTradeView[]): Finding | null {
  const ccs = trades.filter((t) =>
    t.asset_class === 'option' && t.option_type === 'call' && t.side === 'STO'
    && t.strike != null && t.cost_basis_at_entry != null
    && t.strike < t.cost_basis_at_entry,
  );
  const losses = ccs.filter((t) => t.realized_pnl < 0);
  if (ccs.length >= 2 && losses.length >= 1) {
    return {
      matcher: 'cc_below_cost_basis',
      finding: `${ccs.length} covered calls below cost basis, ${losses.length} ended at a loss`,
      evidence_trade_ids: ccs.map((t) => t.id),
      key: 'cc_below_cost_basis:global',
      actionable: true,
      suggested_severity: 'block',
      suggested_triggers: [
        { type: 'asset_class', value: 'option' },
        { type: 'option_type', value: 'call' },
        { type: 'side', value: 'sell' },
        { type: 'strike_below_cost_basis' },
      ],
    };
  }
  return null;
}

function heldThroughEarnings(trades: ClosedTradeView[]): Finding | null {
  const eligible = trades.filter((t) => t.earnings_during_hold);
  if (eligible.length < 2) return null;
  const losses = eligible.filter((t) => t.realized_pnl < 0);
  if (losses.length / eligible.length >= 0.5) {
    return {
      matcher: 'held_through_earnings',
      finding: `${eligible.length} trades held through earnings, ${losses.length} lost money`,
      evidence_trade_ids: eligible.map((t) => t.id),
      key: 'held_through_earnings:global',
      actionable: true,
      suggested_severity: 'block',
      suggested_triggers: [{ type: 'earnings_within_days', value: 14 }],
    };
  }
  return null;
}

function overrideLossPattern(trades: ClosedTradeView[]): Finding[] {
  const byRule: Record<string, ClosedTradeView[]> = {};
  for (const t of trades) {
    for (const v of t.rule_violations) {
      if (v.severity === 'block' && v.override_reason) {
        (byRule[v.rule] ??= []).push(t);
      }
    }
  }
  const findings: Finding[] = [];
  for (const [ruleId, ts] of Object.entries(byRule)) {
    if (ts.length < 3) continue;
    const losses = ts.filter((t) => t.realized_pnl < 0).length;
    if (losses / ts.length >= 0.6) {
      findings.push({
        matcher: 'override_loss_pattern',
        finding: `Rule ${ruleId} overridden ${ts.length} times, ${losses} lost money (${((losses / ts.length) * 100).toFixed(0)}%)`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `override_loss_pattern:${ruleId}`,
        actionable: true,
        suggested_severity: 'block',
        suggested_triggers: [],
      });
    }
  }
  return findings;
}

const SYSTEM_TAGS = new Set(['imported']);

function isOutcomeTrade(t: ClosedTradeView): boolean {
  return t.closed_by !== 'canceled';
}

function revengeTradePattern(trades: ClosedTradeView[]): Finding | null {
  const eligible = trades.filter(isOutcomeTrade);
  const byAcct = groupBy(eligible, (t) => t.account);
  const revengeIds: string[] = [];
  let revengeLosers = 0;
  for (const ts of Object.values(byAcct)) {
    const sorted = [...ts].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
    for (const t of sorted) {
      const submitMs = Date.parse(t.submitted_at);
      if (!Number.isFinite(submitMs)) continue;
      let prior: ClosedTradeView | null = null;
      let priorMs = -Infinity;
      for (const cand of sorted) {
        if (cand.id === t.id) continue;
        const closedMs = Date.parse(cand.closed_at);
        if (!Number.isFinite(closedMs)) continue;
        if (closedMs >= submitMs) continue;
        if (closedMs > priorMs) { prior = cand; priorMs = closedMs; }
      }
      if (!prior) continue;
      if (prior.realized_pnl >= 0) continue;
      const gapMin = (submitMs - priorMs) / 60000;
      if (gapMin > 60) continue;
      revengeIds.push(t.id);
      if (t.realized_pnl < 0) revengeLosers++;
    }
  }
  if (revengeIds.length < 3) return null;
  if (revengeLosers / revengeIds.length < 0.5) return null;
  return {
    matcher: 'revenge_trade_pattern',
    finding: `${revengeIds.length} revenge trades opened within 60min of a loss, ${revengeLosers} lost money`,
    evidence_trade_ids: revengeIds,
    key: 'revenge_trade_pattern:global',
    actionable: true,
    suggested_severity: 'block',
    suggested_triggers: [{ type: 'recent_loss_within_minutes', minutes: 60 }],
  };
}

function lossConcentrationByTag(trades: ClosedTradeView[]): Finding[] {
  const eligible = trades.filter(isOutcomeTrade);
  const byTag: Record<string, ClosedTradeView[]> = {};
  for (const t of eligible) {
    for (const tag of t.tags) {
      if (SYSTEM_TAGS.has(tag)) continue;
      (byTag[tag] ??= []).push(t);
    }
  }
  const findings: Finding[] = [];
  for (const [tag, ts] of Object.entries(byTag)) {
    if (ts.length < 4) continue;
    const wins = ts.filter((t) => t.realized_pnl > 0).length;
    const winRate = wins / ts.length;
    const total = ts.reduce((s, t) => s + t.realized_pnl, 0);
    if (winRate < 0.4 && total < 0) {
      findings.push({
        matcher: 'loss_concentration_by_tag',
        finding: `${ts.length} trades tagged '${tag}', ${(winRate * 100).toFixed(0)}% win rate, total P&L ${total.toFixed(0)}`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `loss_concentration_by_tag:${tag}`,
        actionable: true,
        suggested_severity: 'warn',
        suggested_triggers: [{ type: 'tag_in', tags: [tag] }],
      });
    }
  }
  return findings;
}

function dteBucket(dte: number): { label: string; min: number; max: number } | null {
  if (dte < 0) return null;
  if (dte <= 7)  return { label: '0-7',   min: 0,  max: 7 };
  if (dte <= 14) return { label: '8-14',  min: 8,  max: 14 };
  if (dte <= 28) return { label: '15-28', min: 15, max: 28 };
  return { label: '29+', min: 29, max: 9999 };
}

function dteBucketLossPattern(trades: ClosedTradeView[]): Finding[] {
  const eligible = trades.filter((t) =>
    isOutcomeTrade(t) && t.asset_class === 'option' && t.dte_at_entry != null,
  );
  const buckets: Record<string, { ts: ClosedTradeView[]; min: number; max: number }> = {};
  for (const t of eligible) {
    const b = dteBucket(t.dte_at_entry!);
    if (!b) continue;
    (buckets[b.label] ??= { ts: [], min: b.min, max: b.max }).ts.push(t);
  }
  const findings: Finding[] = [];
  for (const [label, { ts, min, max }] of Object.entries(buckets)) {
    if (ts.length < 5) continue;
    const wins = ts.filter((t) => t.realized_pnl > 0).length;
    const winRate = wins / ts.length;
    if (winRate < 0.4) {
      findings.push({
        matcher: 'dte_bucket_loss_pattern',
        finding: `${ts.length} option trades opened ${label} DTE, ${(winRate * 100).toFixed(0)}% win rate`,
        evidence_trade_ids: ts.map((t) => t.id),
        key: `dte_bucket_loss_pattern:${label}`,
        actionable: true,
        suggested_severity: 'warn',
        suggested_triggers: [{ type: 'dte_at_entry_between', min, max }],
      });
    }
  }
  return findings;
}

function chaseModifyPattern(trades: ClosedTradeView[]): Finding | null {
  const chased = trades.filter((t) =>
    isOutcomeTrade(t) && t.chased_during_open && t.realized_pnl < 0,
  );
  if (chased.length < 3) return null;
  return {
    matcher: 'chase_modify_pattern',
    finding: `${chased.length} trades modified 2+ times in the chase direction, all lost money`,
    evidence_trade_ids: chased.map((t) => t.id),
    key: 'chase_modify_pattern:global',
    actionable: true,
    suggested_severity: 'warn',
    suggested_triggers: [],
  };
}

function winnerCutShort(trades: ClosedTradeView[]): Finding | null {
  const eligible = trades.filter((t) =>
    isOutcomeTrade(t)
    && t.asset_class === 'option'
    && t.closed_by !== 'assigned' && t.closed_by !== 'expired'
    && t.filled_at != null && t.expiration != null,
  );
  if (eligible.length < 10) return null;
  const pcts: Array<{ pct: number; win: boolean }> = [];
  for (const t of eligible) {
    const filledMs = Date.parse(t.filled_at!);
    const expMs = Date.parse(`${t.expiration!}T20:00:00Z`);
    const closedMs = Date.parse(t.closed_at);
    const total = expMs - filledMs;
    if (total <= 0) continue;
    const held = (closedMs - filledMs) / total;
    pcts.push({ pct: held, win: t.realized_pnl > 0 });
  }
  if (pcts.length < 10) return null;
  const winners = pcts.filter((x) => x.win);
  const losers = pcts.filter((x) => !x.win);
  if (winners.length === 0 || losers.length === 0) return null;
  const avgWin = winners.reduce((s, x) => s + x.pct, 0) / winners.length;
  const avgLoss = losers.reduce((s, x) => s + x.pct, 0) / losers.length;
  if (avgWin < 0.4 && avgLoss > 0.7) {
    return {
      matcher: 'winner_cut_short',
      finding: `On ${pcts.length} closed options, winners held ${(avgWin * 100).toFixed(0)}% of available time, losers ${(avgLoss * 100).toFixed(0)}%`,
      evidence_trade_ids: eligible.map((t) => t.id),
      key: 'winner_cut_short:global',
      actionable: false,
      suggested_severity: 'warn',
      suggested_triggers: [],
    };
  }
  return null;
}

function overGradingSelf(trades: ClosedTradeView[]): Finding | null {
  const graded = trades.filter((t) => t.ai_grade != null);
  if (graded.length < 10) return null;
  const totalDelta = graded.reduce((s, t) => s + (gradeIndex(t.user_grade) - gradeIndex(t.ai_grade!)), 0);
  const avgDelta = totalDelta / graded.length;
  // gradeIndex: lower index = higher grade. user grades higher than ai → user_idx < ai_idx → delta is negative.
  // "≥1 letter step higher than AI" → avgDelta ≤ -1.
  if (avgDelta <= -1) {
    return {
      matcher: 'over_grading_self',
      finding: `Across ${graded.length} graded trades, you grade yourself ~${(-avgDelta).toFixed(1)} letter steps higher than AI on average.`,
      evidence_trade_ids: graded.map((t) => t.id),
      key: 'over_grading_self:global',
      actionable: false,                 // informational only — no rule generated
      suggested_severity: 'warn',
      suggested_triggers: [],
    };
  }
  return null;
}
