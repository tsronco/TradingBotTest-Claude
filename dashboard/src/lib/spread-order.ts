import { parseOptionSymbol } from './option-symbol';

export interface SpreadOrderDisplay {
  underlying: string;
  type: 'put' | 'call';
  shortStrike: number;
  longStrike: number;
  expiration: string; // YYYY-MM-DD
  label: string; // e.g. "PUT SPREAD $14/$13"
}

interface OrderLegLike {
  symbol?: string | null;
  side?: string | null;
}

interface SpreadOrderLike {
  order_class?: string | null;
  legs?: OrderLegLike[] | null;
}

function fmtStrike(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/**
 * Describe a 2-leg single-expiry vertical (the only multi-leg shape the bot
 * opens) from an Alpaca order's `legs` array. Alpaca returns mleg parent
 * orders with `symbol`/`side` null and the real data in `legs[]`, so the
 * Orders UI needs this to render a combined row instead of a blank line.
 *
 * Returns null for anything that isn't a clean 2-leg, same-underlying,
 * same-type, same-expiration vertical with exactly one short and one long
 * leg — callers fall back to single-leg rendering.
 */
export function describeSpreadOrder(order: SpreadOrderLike): SpreadOrderDisplay | null {
  const legs = order?.legs;
  if (!Array.isArray(legs) || legs.length !== 2) return null;

  const parsed = legs.map((l) => ({
    side: (l?.side ?? '').toLowerCase(),
    opt: l?.symbol ? parseOptionSymbol(l.symbol) : null,
  }));
  if (parsed.some((p) => p.opt === null)) return null;

  const [a, b] = parsed as Array<{ side: string; opt: NonNullable<ReturnType<typeof parseOptionSymbol>> }>;
  if (
    a.opt.underlying !== b.opt.underlying ||
    a.opt.type !== b.opt.type ||
    a.opt.expiration !== b.opt.expiration
  ) {
    return null;
  }

  const isShort = (s: string) => s === 'sell' || s === 'sell_short';
  const isLong = (s: string) => s === 'buy';
  let shortLeg: typeof a | null = null;
  let longLeg: typeof a | null = null;
  for (const p of [a, b]) {
    if (isShort(p.side)) shortLeg = p;
    else if (isLong(p.side)) longLeg = p;
  }
  if (!shortLeg || !longLeg) return null;

  const type = a.opt.type;
  const shortStrike = shortLeg.opt.strike;
  const longStrike = longLeg.opt.strike;
  return {
    underlying: a.opt.underlying,
    type,
    shortStrike,
    longStrike,
    expiration: a.opt.expiration,
    label: `${type.toUpperCase()} SPREAD $${fmtStrike(shortStrike)}/$${fmtStrike(longStrike)}`,
  };
}
