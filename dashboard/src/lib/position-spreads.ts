// Group flat Alpaca option positions into vertical spreads so the Positions
// screen can show net cost / max loss / max profit / breakeven per trade,
// the way an options builder (TradingView, the order form) does.
//
// A vertical spread here = two option legs on the SAME underlying, SAME
// expiration, SAME type (both calls or both puts), OPPOSITE side (one long,
// one short), at DIFFERENT strikes. Anything that doesn't pair (a lone long
// call, a naked short, a stock) stays a single.
//
// The max-profit / max-loss / breakeven math is delegated to buildPayoff() —
// the same closed-form engine the payoff chart and order form use — so there
// is one source of truth and no drift. Those figures depend only on strikes
// and entry premiums, not on the current spot, so a placeholder spot is fine.
import { buildPayoff, type Leg } from './payoff';
import { parseOptionSymbol } from './option-symbol';

export interface RawPosition {
  symbol: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side?: string;
}

export interface SpreadMetrics {
  name: string;                 // "Bull Call Spread"
  optionType: 'call' | 'put';
  isDebit: boolean;             // true = you paid to open, false = you collected
  netCost: number;             // signed $: + = net debit paid, − = net credit received
  maxProfit: number | null;    // $, null = unbounded (shouldn't happen for a vertical)
  maxLoss: number | null;      // $ (negative), null = unbounded
  breakeven: number | null;    // underlying price
  width: number;               // strike distance
  contracts: number;           // paired contract count
  underlying: string;
  expiration: string;          // YYYY-MM-DD
  longStrike: number;
  shortStrike: number;
  groupPL: number;             // live: sum of both legs' unrealized_pl
}

export type PositionGroup =
  | { kind: 'single'; pos: RawPosition }
  | { kind: 'spread'; long: RawPosition; short: RawPosition; metrics: SpreadMetrics };

function isSpreadableOption(p: RawPosition): boolean {
  return p.asset_class === 'us_option' && parseOptionSymbol(p.symbol) !== null;
}

function spreadName(type: 'call' | 'put', isDebit: boolean): string {
  // Directional bias of each vertical (industry-standard names, matching the
  // options builders users cross-check against).
  if (type === 'call') return isDebit ? 'Bull Call Spread' : 'Bear Call Spread';
  return isDebit ? 'Bear Put Spread' : 'Bull Put Spread';
}

function makeSpread(long: RawPosition, short: RawPosition, contracts: number): PositionGroup {
  const lp = parseOptionSymbol(long.symbol)!;
  const sp = parseOptionSymbol(short.symbol)!;
  const type = lp.type;
  const longPrem = Number(long.avg_entry_price);
  const shortPrem = Number(short.avg_entry_price);

  // + = you paid (debit), − = you were paid (credit).
  const netCost = (longPrem - shortPrem) * 100 * contracts;
  const isDebit = netCost > 0;

  const legs: Leg[] = [
    { kind: 'option', dir: 'long', type, strike: lp.strike, premium: longPrem, contracts },
    { kind: 'option', dir: 'short', type, strike: sp.strike, premium: shortPrem, contracts },
  ];
  // Spot only affects the chart window, not max/loss/breakeven — midpoint is fine.
  const payoff = buildPayoff(legs, (lp.strike + sp.strike) / 2);

  const metrics: SpreadMetrics = {
    name: spreadName(type, isDebit),
    optionType: type,
    isDebit,
    netCost,
    maxProfit: payoff.maxProfit,
    maxLoss: payoff.maxLoss,
    breakeven: payoff.breakevens.length ? payoff.breakevens[0] : null,
    width: Math.abs(lp.strike - sp.strike),
    contracts,
    underlying: lp.underlying,
    expiration: lp.expiration,
    longStrike: lp.strike,
    shortStrike: sp.strike,
    groupPL: Number(long.unrealized_pl) + Number(short.unrealized_pl),
  };
  return { kind: 'spread', long, short, metrics };
}

/**
 * Fold a flat position list into ordered groups: vertical spreads (paired
 * long+short legs) plus singles for everything else. Ordering follows the
 * original list, anchored on each spread's LONG leg, so the view stays stable.
 *
 * Pairing is greedy and whole-position: within an underlying|expiration|type
 * bucket, each long leg claims the not-yet-used short leg at the nearest
 * different strike (narrowest width wins — the same tie-break the bot uses).
 * Each position lands in exactly one group, so P&L is never double-counted.
 * Unequal leg quantities pair at the smaller count for the payoff math while
 * each leg row still shows its true quantity.
 */
export function groupPositions(positions: RawPosition[]): PositionGroup[] {
  // Bucket spreadable options by underlying|expiration|type.
  const buckets = new Map<string, RawPosition[]>();
  for (const p of positions) {
    if (!isSpreadableOption(p)) continue;
    const parsed = parseOptionSymbol(p.symbol)!;
    const key = `${parsed.underlying}|${parsed.expiration}|${parsed.type}`;
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }

  // spreadByLongSymbol: emit the spread when we reach its long leg in order.
  const spreadByLongSymbol = new Map<string, PositionGroup>();
  const consumed = new Set<string>();

  for (const legs of buckets.values()) {
    const longs = legs.filter((p) => Number(p.qty) > 0);
    const shorts = legs.filter((p) => Number(p.qty) < 0);
    const usedShorts = new Set<string>();

    for (const L of longs) {
      const lp = parseOptionSymbol(L.symbol)!;
      const cands = shorts
        .filter((S) => !usedShorts.has(S.symbol) && parseOptionSymbol(S.symbol)!.strike !== lp.strike)
        .sort(
          (a, b) =>
            Math.abs(parseOptionSymbol(a.symbol)!.strike - lp.strike) -
            Math.abs(parseOptionSymbol(b.symbol)!.strike - lp.strike),
        );
      const S = cands[0];
      if (!S) continue;
      usedShorts.add(S.symbol);
      const contracts = Math.min(Math.abs(Number(L.qty)), Math.abs(Number(S.qty)));
      spreadByLongSymbol.set(L.symbol, makeSpread(L, S, contracts));
      consumed.add(L.symbol);
      consumed.add(S.symbol);
    }
  }

  const groups: PositionGroup[] = [];
  for (const p of positions) {
    const spread = spreadByLongSymbol.get(p.symbol);
    if (spread) {
      groups.push(spread);
      continue;
    }
    if (consumed.has(p.symbol)) continue; // short leg already emitted with its spread
    groups.push({ kind: 'single', pos: p });
  }
  return groups;
}
