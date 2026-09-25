/**
 * Read a position's current price against its average cost at a glance.
 *
 * On the positions table, avg cost and current price sit side by side in the
 * same color, so "am I above or below my cost?" needs a second look. This
 * classifies the pair so the current-price cell can carry the answer.
 *
 * `favorable` is direction-aware: a LONG position wants price above cost, a
 * SHORT option (negative qty — you sold it) wants price BELOW the premium you
 * collected. The color therefore matches the sign of unrealized P&L, so the
 * row reads the same way from either column.
 */
export type PriceVsCost = {
  /** raw comparison of current price to average cost */
  direction: 'above' | 'below' | 'flat';
  /** whether that direction helps this position (long vs short aware) */
  favorable: boolean | null; // null when flat
  /** current − avg, per share/contract, signed */
  delta: number;
  /** (current − avg) / avg × 100, signed; null when avg is 0 */
  deltaPct: number | null;
};

export function priceVsCost(current: number, avgCost: number, qty: number): PriceVsCost {
  const delta = current - avgCost;
  // Sub-cent moves are noise, not a signal.
  const flat = Math.abs(delta) < 0.005;
  const direction = flat ? 'flat' : delta > 0 ? 'above' : 'below';
  const isShort = qty < 0;
  const favorable = flat ? null : isShort ? delta < 0 : delta > 0;
  const deltaPct = avgCost !== 0 ? (delta / Math.abs(avgCost)) * 100 : null;
  return { direction, favorable, delta, deltaPct };
}

/** Tailwind text class for the current-price cell. */
export function priceVsCostClass(v: PriceVsCost): string {
  if (v.favorable === null) return 'text-fg';
  return v.favorable ? 'text-hi' : 'text-red';
}
