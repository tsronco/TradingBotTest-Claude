// dashboard/api/_lib/rule-check.ts
//
// Trigger-DSL evaluator. Reads rules:manual and bot:rules:<mode> from KV,
// evaluates each manual rule's triggers against the order draft + ctx,
// and emits synthetic warn-severity violations from bot rules.
//
// Severity ordering on output: block first, warn next, info last.

import { kv } from './kv.js';
import { rulesKey, botRulesKey } from './kv-keys.js';
import { fetchEarningsDate } from './fundamentals-fetch.js';
import type {
  ManualRule, Trigger, BotRulesPayload,
} from './rules-types.js';
import type {
  AssetClass, AccountId, RuleWarning, RuleSeverity, OrderSide,
} from './trade-types.js';

export interface RuleCheckInput {
  asset_class: AssetClass;
  symbol: string;
  qty: number;
  account: AccountId;
  // Optional fields used by triggers (and by the order form via /api/trades/check):
  side?: OrderSide;
  option_type?: 'put' | 'call';
  strike?: number | null;
  expiration?: string | null;        // YYYY-MM-DD
  tags?: string[];
}

export interface RuleCheckCtx {
  positions?: Array<{ symbol: string; qty: number; avg_entry_price: number }>;
}

export async function runRuleChecks(
  input: RuleCheckInput,
  ctx: RuleCheckCtx = {},
): Promise<RuleWarning[]> {
  const positions = ctx.positions ?? [];
  const violations: RuleWarning[] = [];

  // --- Manual rules ---
  const manualRaw = await kv().get<ManualRule[]>(rulesKey('manual'));
  const manual: ManualRule[] = Array.isArray(manualRaw) ? manualRaw : [];
  for (const rule of manual) {
    if (rule.triggers.length === 0) continue;     // empty triggers don't auto-fire
    let allMatch = true;
    for (const t of rule.triggers) {
      const ok = await evaluateTrigger(t, input, positions);
      if (!ok) { allMatch = false; break; }
    }
    if (allMatch) {
      violations.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.title,
      });
    }
  }

  // --- Bot rules (warn-only) ---
  const mode = accountToMode(input.account);
  const bot = (await kv().get<BotRulesPayload>(botRulesKey(mode))) ?? null;
  if (bot && input.asset_class === 'option') {
    if (Array.isArray(bot.wheel?.symbols) && !bot.wheel.symbols.includes(input.symbol)) {
      violations.push({
        rule: 'bot_outside_wheel_symbols',
        severity: 'warn',
        message: `${input.symbol} is not on the ${mode} wheel symbol list`,
      });
    }
    if (input.expiration && bot.wheel?.dte_min != null && bot.wheel?.dte_max != null) {
      const dte = calcDTE(input.expiration);
      if (dte < bot.wheel.dte_min - 3 || dte > bot.wheel.dte_max + 3) {
        violations.push({
          rule: 'bot_dte_outside_wheel',
          severity: 'warn',
          message: `expiration ${dte} DTE is outside wheel range ${bot.wheel.dte_min}-${bot.wheel.dte_max}`,
        });
      }
    }
  }

  // --- Legacy stub rules (kept for backward compatibility — preserve existing behavior
  // for sizing_1x, earnings_within_7d, bot_wheel_overlap that the order form already
  // surfaces). These are warn/info severity, complement the trigger DSL. ---
  await appendLegacyStubRules(input, violations);

  return violations.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
}

// Backward-compat alias for existing callers (api/trades/[action].ts:115, :144)
export const runStubRuleChecks = runRuleChecks;

function sevRank(s: RuleSeverity): number {
  return s === 'block' ? 0 : s === 'warn' ? 1 : 2;
}

function accountToMode(account: AccountId): 'conservative' | 'aggressive' | 'manual' {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  return 'conservative';   // conservative_paper or live
}

function calcDTE(expiration: string): number {
  // expiration is YYYY-MM-DD; treat as 4 PM ET on that day for DTE math.
  // Note: M4.1 will introduce a DST-aware helper; for now use 20:00 UTC = 4 PM EDT.
  // The bot_dte_outside_wheel check is warn-only and approximate, so a 1-hour drift
  // during EST (Nov-Mar) doesn't change the result on any practical input.
  const d = new Date(`${expiration}T20:00:00Z`);
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000));
}

async function evaluateTrigger(
  t: Trigger,
  input: RuleCheckInput,
  positions: Array<{ symbol: string; qty: number; avg_entry_price: number }>,
): Promise<boolean> {
  switch (t.type) {
    case 'symbol_in':       return t.symbols.includes(input.symbol);
    case 'symbol_not_in':   return !t.symbols.includes(input.symbol);
    case 'side': {
      const isBuy =
        input.side === 'buy' || input.side === 'BTO' || input.side === 'BTC';
      return t.value === 'buy' ? isBuy : !isBuy;
    }
    case 'asset_class':     return input.asset_class === t.value;
    case 'option_type':     return input.option_type === t.value;
    case 'option_dte_lt':   return input.expiration ? calcDTE(input.expiration) < t.value : false;
    case 'option_dte_gt':   return input.expiration ? calcDTE(input.expiration) > t.value : false;
    case 'open_position_count_gt': {
      const n = positions.filter((p) => p.symbol === input.symbol).length;
      return n > t.value;
    }
    case 'earnings_within_days': {
      const date = await fetchEarningsDate(input.symbol);
      if (!date) return false;
      const days = Math.floor((Date.parse(date) - Date.now()) / 86400000);
      return days >= 0 && days <= t.value;
    }
    case 'strike_below_cost_basis': {
      if (input.asset_class !== 'option' || input.option_type !== 'call' || input.strike == null) return false;
      const stock = positions.find((p) => p.symbol === input.symbol);
      if (!stock) return false;
      return input.strike < stock.avg_entry_price;
    }
    case 'tag_present':     return (input.tags ?? []).includes(t.tag);
    default:                return false;
  }
}

// --- Legacy stub rules (preserved from Phase 2 for backward compat) ---

async function appendLegacyStubRules(
  input: RuleCheckInput,
  out: RuleWarning[],
): Promise<void> {
  // sizing_1x — info severity for orders larger than the per-asset-class threshold
  const sizingThreshold = input.asset_class === 'stock' ? 20 : 1;
  if (input.qty > sizingThreshold) {
    const multiple = input.asset_class === 'stock'
      ? `${(input.qty / 10).toFixed(1)}× normal`
      : `${input.qty}× normal`;
    out.push({
      rule: 'sizing_1x',
      severity: 'info',
      message: `order is ${multiple} size (>${sizingThreshold} ${input.asset_class === 'stock' ? 'shares' : 'contracts'}). reason should explain.`,
    });
  }

  // earnings_within_7d — built-in warn for orders going into earnings
  if (input.asset_class === 'stock' || input.asset_class === 'option') {
    const earnings = await fetchEarningsDate(input.symbol);
    if (earnings) {
      const days = Math.floor((Date.parse(earnings) - Date.now()) / 86400000);
      if (days >= 0 && days <= 7) {
        out.push({
          rule: 'earnings_within_7d',
          severity: 'warn',
          message: `earnings on ${earnings} (in ${days} day${days === 1 ? '' : 's'}). consider sizing down or waiting.`,
        });
      }
    }
  }

  // bot_wheel_overlap — warn when bot has an open wheel on the same symbol
  const cons = (await kv().get<Record<string, { stage?: number }>>('bot:state:conservative')) ?? {};
  const agg = (await kv().get<Record<string, { stage?: number }>>('bot:state:aggressive')) ?? {};
  const consHas = cons[input.symbol]?.stage === 1 || cons[input.symbol]?.stage === 2;
  const aggHas = agg[input.symbol]?.stage === 1 || agg[input.symbol]?.stage === 2;
  if (consHas || aggHas) {
    const accounts = [consHas && 'conservative', aggHas && 'aggressive'].filter(Boolean).join(' & ');
    out.push({
      rule: 'bot_wheel_overlap',
      severity: 'warn',
      message: `bot has an open wheel on ${input.symbol} in ${accounts}. manual position will share BP.`,
    });
  }
}
