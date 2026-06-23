// dashboard/src/lib/trade-breakeven.ts
//
// Recompute a trade's break-even price(s) from its stored record, reusing the
// same payoff engine the order form uses (single source of truth). Break-even
// is a pure function of a position's legs — strikes, entry premium, side — all
// persisted on the Trade, so no snapshot/schema change is needed and this works
// retroactively on every existing trade.
//
// Fill-based: uses actual fill prices, falling back to the order limit (single
// leg) or the stored net credit/debit (spreads) when fills aren't recorded.
import { buildPayoff } from './payoff';
import type { Leg, OptionLeg, OptionType, LegDir } from './payoff';
import type { Trade } from './trade-types';

function num(x: number | null | undefined): number | null {
  return x != null && isFinite(x) ? x : null;
}

/** Map a trade record to payoff legs using fill prices (entry-time basis). */
export function tradeToLegs(trade: Trade): Leg[] {
  if (trade.asset_class === 'stock') {
    const entry = num(trade.filled_avg_price) ?? num(trade.limit_price);
    if (entry == null) return [];
    const dir: LegDir = trade.side === 'buy' ? 'long' : 'short';
    return [{ kind: 'stock', dir, entry, shares: trade.qty }];
  }

  if (trade.asset_class === 'option') {
    const premium = num(trade.filled_avg_price) ?? num(trade.limit_price);
    if (premium == null || trade.strike == null || trade.contract_type == null) return [];
    const dir: LegDir = trade.side === 'BTO' || trade.side === 'BTC' ? 'long' : 'short';
    return [{
      kind: 'option', dir, type: trade.contract_type,
      strike: trade.strike, premium, contracts: trade.qty,
    }];
  }

  if (trade.asset_class === 'spread' && trade.spread) {
    const sp = trade.spread;
    const type: OptionType =
      sp.spread_type === 'put_credit' || sp.spread_type === 'put_debit' ? 'put' : 'call';
    const mk = (dir: LegDir, strike: number, premium: number): OptionLeg => ({
      kind: 'option', dir, type, strike, premium, contracts: trade.qty,
    });

    const shortPrem = num(sp.short_leg.fill_price) ?? num(sp.short_leg.entry_premium);
    const longPrem = num(sp.long_leg.fill_price) ?? num(sp.long_leg.entry_premium);
    if (shortPrem != null && longPrem != null) {
      return [mk('short', sp.short_leg.strike, shortPrem), mk('long', sp.long_leg.strike, longPrem)];
    }

    // Fallback: synthesize per-leg premiums from the stored net so the
    // break-even is still correct. Break-even depends only on net + the
    // relevant strike, so loading the whole net onto one leg (and 0 on the
    // other) yields the right zero-crossing. Max profit/loss would be
    // meaningless this way, but we only read `breakevens`.
    const isCredit = sp.spread_type === 'put_credit' || sp.spread_type === 'call_credit';
    const net = isCredit ? num(sp.net_credit) : num(sp.net_debit);
    if (net == null || net <= 0) return [];
    return isCredit
      ? [mk('short', sp.short_leg.strike, net), mk('long', sp.long_leg.strike, 0)]
      : [mk('short', sp.short_leg.strike, 0), mk('long', sp.long_leg.strike, net)];
  }

  return [];
}

/** Reference price that only sets buildPayoff's search window (not the BE values). */
function refPrice(legs: Leg[]): number {
  for (const l of legs) if (l.kind === 'option') return l.strike;
  for (const l of legs) if (l.kind === 'stock') return l.entry;
  return 1;
}

/** Break-even price(s) for a trade, ascending. Empty when not computable. */
export function tradeBreakevens(trade: Trade): number[] {
  const legs = tradeToLegs(trade);
  if (legs.length === 0) return [];
  return buildPayoff(legs, refPrice(legs)).breakevens;
}
