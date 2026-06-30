// dashboard/api/_lib/rule-check.ts
//
// Trigger-DSL evaluator. Reads rules:manual and bot:rules:<mode> from KV,
// evaluates each manual rule's triggers against the order draft + ctx,
// and emits synthetic warn-severity violations from bot rules.
//
// Severity ordering on output: block first, warn next, info last.

import { kv } from './kv.js';
import { rulesKey, botRulesKey, tradesIndexMonthKey, tradeKey, readMonthIndex } from './kv-keys.js';
import { fetchEarningsDate } from './fundamentals-fetch.js';
import type {
  ManualRule, Trigger, BotRulesPayload,
} from './rules-types.js';
import type {
  AssetClass, AccountId, RuleWarning, RuleSeverity, OrderSide, SpreadType, Trade,
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
  spread?: { width: number; net_credit: number; max_loss: number };
  spread_type?: SpreadType;          // for spreads — distinguishes put_credit etc.
  // Current price of the UNDERLYING stock (not the option/spread). Threaded
  // through by the order-form preview/check/submit paths so OTM-distance rules
  // can be evaluated. Null when a quote isn't available.
  underlying_price?: number | null;
}

// Minimum out-of-the-money distance for a short put before we nudge the user.
// Selling puts close to the money chases premium at the cost of a much higher
// assignment/blow-through probability; staying further OTM "basically
// guarantees" the (smaller) premium. Warn-only — sometimes going closer is a
// deliberate call. See shortPutOtmViolation().
export const SHORT_PUT_MIN_OTM_PCT = 0.07;

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
  // accountToMode returns a kv-keys Mode (manual or live); both have their
  // bot:rules:<mode> key whitelisted and pushed by the monitor workflows, so
  // the lookup is valid for every account.
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

  // --- Built-in OTM-distance nudge for short puts (warn-only) ---
  const otm = shortPutOtmViolation(input);
  if (otm) violations.push(otm);

  // --- Legacy stub rules (kept for backward compatibility — preserve existing behavior
  // for sizing_1x, earnings_within_7d, bot_wheel_overlap that the order form already
  // surfaces). These are warn/info severity, complement the trigger DSL. ---
  await appendLegacyStubRules(input, violations);

  return violations.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
}

/**
 * Built-in nudge: warn when a SHORT put is being sold too close to the money.
 * Fires for a bare cash-secured put (STO put) or the short leg of a put credit
 * spread. Returns null when it doesn't apply (other asset/side, missing strike
 * or underlying price, or the strike is already comfortably OTM).
 *
 * "Too close" = the short strike is less than SHORT_PUT_MIN_OTM_PCT below the
 * current underlying price. Pure function (no IO) so it's trivially testable.
 */
export function shortPutOtmViolation(input: RuleCheckInput): RuleWarning | null {
  const isBareShortPut =
    input.asset_class === 'option' &&
    input.option_type === 'put' &&
    input.side === 'STO';
  const isPutCreditSpread =
    input.asset_class === 'spread' && input.spread_type === 'put_credit';
  if (!isBareShortPut && !isPutCreditSpread) return null;

  const strike = input.strike;
  const spot = input.underlying_price;
  if (strike == null || !Number.isFinite(strike) || strike <= 0) return null;
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;

  // Positive = OTM for a put (strike below spot). Negative/zero = ATM-or-ITM.
  const otmPct = (spot - strike) / spot;
  if (otmPct >= SHORT_PUT_MIN_OTM_PCT) return null;

  const minPctLabel = `${(SHORT_PUT_MIN_OTM_PCT * 100).toFixed(0)}%`;
  const spotLabel = `$${spot.toFixed(2)}`;
  const strikeLabel = `$${strike.toFixed(2)}`;
  const message = otmPct <= 0
    ? `short put ${strikeLabel} is at/in the money (spot ${spotLabel}). `
      + `Go further OTM (≥${minPctLabel} below spot) to bank premium with far less assignment risk.`
    : `short put ${strikeLabel} is only ${(otmPct * 100).toFixed(1)}% OTM (spot ${spotLabel}). `
      + `Rule of thumb: keep the short strike ≥${minPctLabel} below spot — going further out trades a little premium for a much higher win rate.`;

  return { rule: 'short_put_too_close_otm', severity: 'warn', message };
}

// Backward-compat alias for existing callers (api/trades/[action].ts:115, :144)
export const runStubRuleChecks = runRuleChecks;

function sevRank(s: RuleSeverity): number {
  return s === 'block' ? 0 : s === 'warn' ? 1 : 2;
}

function accountToMode(account: AccountId): 'manual' | 'live' {
  if (account === 'live') return 'live';
  return 'manual';
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
    case 'max_risk_per_spread': {
      if (!input.spread) return false;
      const risk_dollars = input.spread.max_loss * 100 * input.qty;
      return risk_dollars > t.max_dollars;
    }
    case 'tag_in': {
      const tags = input.tags ?? [];
      return tags.some((tag) => t.tags.includes(tag));
    }
    case 'dte_at_entry_between': {
      if (input.asset_class !== 'option' || !input.expiration) return false;
      const dte = calcDTE(input.expiration);
      return dte >= t.min && dte <= t.max;
    }
    case 'recent_loss_within_minutes':
      return await checkRecentLossWithinMinutes(input.account, t.minutes);
    default:                return false;
  }
}

// Walks the most-recent closed trades for `account` (current month, then prior
// month as fallback) and returns true iff the most-recent close was a loss
// AND closed within `minutes` of now. Bounded to the last 50 IDs per month to
// keep KV traffic predictable. Returns false on a fresh account with no closed
// trades — avoids false positives.
async function checkRecentLossWithinMinutes(
  account: AccountId,
  minutes: number,
): Promise<boolean> {
  const now = Date.now();
  const windowMs = minutes * 60_000;
  const months = recentMonthKeys(2);
  for (const month of months) {
    const ids = await readMonthIndex(month);
    if (ids.length === 0) continue;
    const tail = ids.slice(-50).reverse();
    for (const id of tail) {
      const trade = await kv().get<Trade>(tradeKey(id));
      if (!trade) continue;
      if (trade.account !== account) continue;
      if (!trade.closed_at) continue;
      const closedAt = Date.parse(trade.closed_at);
      if (!Number.isFinite(closedAt)) return false;
      if ((trade.realized_pnl ?? 0) >= 0) return false;
      return (now - closedAt) <= windowMs;
    }
  }
  return false;
}

function recentMonthKeys(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
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

  // bot_wheel_overlap — warn when the bot has an open wheel on the same symbol
  const manualState = (await kv().get<Record<string, { stage?: number }>>('bot:state:manual')) ?? {};
  const liveState = (await kv().get<Record<string, { stage?: number }>>('bot:state:live')) ?? {};
  const manualHas = manualState[input.symbol]?.stage === 1 || manualState[input.symbol]?.stage === 2;
  const liveHas = liveState[input.symbol]?.stage === 1 || liveState[input.symbol]?.stage === 2;
  if (manualHas || liveHas) {
    const accounts = [manualHas && 'manual', liveHas && 'live'].filter(Boolean).join(' & ');
    out.push({
      rule: 'bot_wheel_overlap',
      severity: 'warn',
      message: `bot has an open wheel on ${input.symbol} in ${accounts}. manual position will share BP.`,
    });
  }
}
