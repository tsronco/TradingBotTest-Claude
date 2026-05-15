// dashboard/src/lib/payoff.ts
export type LegDir = 'long' | 'short';
export type OptionType = 'call' | 'put';

export interface StockLeg { kind: 'stock'; dir: LegDir; entry: number; shares: number; }
export interface OptionLeg {
  kind: 'option'; dir: LegDir; type: OptionType; strike: number; premium: number; contracts: number;
}
export type Leg = StockLeg | OptionLeg;

export interface PayoffResult {
  points: { price: number; pl: number }[];
  maxProfit: number | null;   // null = unbounded
  maxLoss: number | null;     // null = unbounded
  breakevens: number[];       // ascending, rounded to cents
  currentPrice: number;
  window: { lo: number; hi: number };
}

const MULT = 100;

export function stockLegPL(s: number, leg: StockLeg): number {
  const per = leg.dir === 'long' ? s - leg.entry : leg.entry - s;
  return per * leg.shares;
}

export function optionLegPL(s: number, leg: OptionLeg): number {
  const intrinsic = leg.type === 'call' ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0);
  const per = leg.dir === 'long' ? intrinsic - leg.premium : leg.premium - intrinsic;
  return per * MULT * leg.contracts;
}

export function legPL(s: number, leg: Leg): number {
  return leg.kind === 'stock' ? stockLegPL(s, leg) : optionLegPL(s, leg);
}

export function totalPL(s: number, legs: Leg[]): number {
  return legs.reduce((acc, l) => acc + legPL(s, l), 0);
}

export function buildPayoff(legs: Leg[], currentPrice: number, samples = 96): PayoffResult {
  const empty: PayoffResult = { points: [], maxProfit: null, maxLoss: null, breakevens: [], currentPrice, window: { lo: 0, hi: 0 } };
  if (legs.length === 0 || !isFinite(currentPrice)) return empty;
  for (const l of legs) {
    if (l.kind === 'stock') {
      if (!isFinite(l.entry) || !isFinite(l.shares)) return empty;
    } else {
      if (!isFinite(l.strike) || !isFinite(l.premium) || !isFinite(l.contracts)) return empty;
    }
  }

  const strikes = legs.filter((l): l is OptionLeg => l.kind === 'option').map((l) => l.strike);
  const refs = strikes.length ? strikes : [currentPrice];
  const maxRef = Math.max(currentPrice, ...refs);
  const minRef = Math.min(currentPrice, ...refs);
  const span = Math.max(maxRef - minRef, currentPrice * 0.08);
  let lo = Math.max(0, minRef - span * 1.5);
  let hi = maxRef + span * 1.5;
  if (legs.every((l) => l.kind === 'stock')) {
    lo = Math.max(0, currentPrice * 0.75);
    hi = currentPrice * 1.25;
  }
  lo = Math.min(lo, currentPrice);
  hi = Math.max(hi, currentPrice);

  const points: { price: number; pl: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const price = lo + ((hi - lo) * i) / samples;
    points.push({ price, pl: totalPL(price, legs) });
  }
  for (const k of [0, ...strikes, currentPrice]) {
    if (k >= lo && k <= hi) points.push({ price: k, pl: totalPL(k, legs) });
  }
  points.sort((a, b) => a.price - b.price);

  const top = (strikes.length ? Math.max(...strikes) : currentPrice) + 1;
  const rightSlope = totalPL(top + 1, legs) - totalPL(top, legs);
  const candidates = [0, ...strikes].filter((x) => x >= 0).map((s) => totalPL(s, legs));

  let maxProfit: number | null;
  let maxLoss: number | null;
  if (rightSlope > 1e-9) {
    maxProfit = null;
    maxLoss = Math.min(...candidates);
  } else if (rightSlope < -1e-9) {
    maxLoss = null;
    maxProfit = Math.max(...candidates);
  } else {
    maxProfit = Math.max(...candidates);
    maxLoss = Math.min(...candidates);
  }

  const xs = Array.from(new Set([0, ...strikes, top * 2])).sort((a, b) => a - b);
  const bes: number[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    const fa = totalPL(a, legs);
    const fb = totalPL(b, legs);
    // Only record a breakeven on a genuine sign change (both beyond ±epsilon).
    if (fa < -1e-9 && fb > 1e-9) bes.push(a + (fa / (fa - fb)) * (b - a));
    else if (fa > 1e-9 && fb < -1e-9) bes.push(a + (fa / (fa - fb)) * (b - a));
  }
  const breakevens = Array.from(new Set(bes.map((x) => Math.round(x * 100) / 100))).sort((a, b) => a - b);

  return { points, maxProfit, maxLoss, breakevens, currentPrice, window: { lo, hi } };
}
