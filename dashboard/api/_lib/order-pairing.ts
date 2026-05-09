/**
 * Realized-P/L pairing for Alpaca order history.
 *
 * Symbol-agnostic FIFO. For each filled order on a given symbol, we decide
 * whether it's an OPENER (no opposite-side lots in queue) or a CLOSER (matches
 * an open lot). Closers consume from the queue and the realized P/L gets
 * stamped on the closer order.
 *
 * Option assignments and expirations are not orders — they live in Alpaca's
 * activity stream. We treat them as synthetic closers that consume short-option
 * lots and stamp the realized P/L (= full premium kept) onto the original
 * opening STO. The opener's status is also overridden to "expired" or
 * "assigned" so the UI can distinguish it from an unclosed STO.
 */

export type PairableOrder = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell' | 'sell_short';
  filled_qty: string;
  filled_avg_price: string;
  filled_at: string;
};

export type OptionActivityEvent = {
  id: string;
  activity_type: 'OPEXP' | 'OPASN';
  symbol: string;
  qty: string;
  // ISO timestamp; activities only carry a date, but the caller can normalize.
  occurred_at: string;
};

export type PairingResult = {
  /** Realized P/L in dollars, keyed by the order id of the leg the P/L is stamped on. */
  realizedByOrderId: Map<string, number>;
  /** Status override for openers closed by an activity (expired/assigned). */
  statusByOrderId: Map<string, 'expired' | 'assigned'>;
};

const OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

/** OCC option symbols use a 100x contract multiplier; stocks are 1x per share. */
function multiplierFor(symbol: string): number {
  return OCC_RE.test(symbol) ? 100 : 1;
}

type LotSide = 'long' | 'short';
type Lot = {
  openerOrderId: string;
  qty: number;
  price: number;
  side: LotSide;
};

/**
 * Convert order side into the lot side it would OPEN if treated as an opener.
 * A 'buy' opens a long lot; 'sell' or 'sell_short' opens a short lot.
 */
function openSideOf(orderSide: PairableOrder['side']): LotSide {
  return orderSide === 'buy' ? 'long' : 'short';
}

type Event =
  | { kind: 'order'; ts: number; order: PairableOrder }
  | { kind: 'activity'; ts: number; activity: OptionActivityEvent };

function buildEventStream(orders: PairableOrder[], activities: OptionActivityEvent[]): Event[] {
  const events: Event[] = [];
  for (const o of orders) {
    const qty = Number(o.filled_qty);
    const price = Number(o.filled_avg_price);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(price)) continue;
    events.push({ kind: 'order', ts: Date.parse(o.filled_at), order: o });
  }
  for (const a of activities) {
    const qty = Number(a.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    events.push({ kind: 'activity', ts: Date.parse(a.occurred_at), activity: a });
  }
  // Sort chronologically. Stable on ties so deterministic test output.
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

export function pairOrders(
  orders: PairableOrder[],
  activities: OptionActivityEvent[] = [],
): PairingResult {
  const realizedByOrderId = new Map<string, number>();
  const statusByOrderId = new Map<string, 'expired' | 'assigned'>();
  // Per-symbol FIFO queue of open lots.
  const queues = new Map<string, Lot[]>();

  const addRealized = (orderId: string, delta: number) => {
    realizedByOrderId.set(orderId, (realizedByOrderId.get(orderId) ?? 0) + delta);
  };

  for (const ev of buildEventStream(orders, activities)) {
    if (ev.kind === 'order') {
      const o = ev.order;
      const queue = queues.get(o.symbol) ?? [];
      const orderSide = openSideOf(o.side);
      const mult = multiplierFor(o.symbol);
      let remaining = Number(o.filled_qty);
      const closerPrice = Number(o.filled_avg_price);

      // Consume opposite-side lots first (closing). Same-side lots stack.
      while (remaining > 0 && queue.length > 0 && queue[0].side !== orderSide) {
        const lot = queue[0];
        const matched = Math.min(lot.qty, remaining);
        // P/L convention: P/L = (sell_price - buy_price) * matched * mult
        // - long lot closed by sell: sell=closer, buy=opener
        // - short lot closed by buy: sell=opener, buy=closer
        const pl =
          lot.side === 'long'
            ? (closerPrice - lot.price) * matched * mult
            : (lot.price - closerPrice) * matched * mult;
        addRealized(o.id, pl);
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty === 0) queue.shift();
      }

      // Anything left becomes a new lot in this order's direction (opener,
      // or — rarely — the residual after a reversing trade fully consumed
      // the opposite side and then opened in the new direction).
      if (remaining > 0) {
        queue.push({
          openerOrderId: o.id,
          qty: remaining,
          price: closerPrice,
          side: orderSide,
        });
      }
      queues.set(o.symbol, queue);
    } else {
      // Activity event: assignments and expirations close short option lots.
      // We don't model long-option exercise (OPXR) here — the user's wheel
      // strategies don't buy long options to exercise; long calls/puts are
      // managed via STC orders that pair normally above.
      const a = ev.activity;
      const queue = queues.get(a.symbol) ?? [];
      const mult = multiplierFor(a.symbol); // Always 100 for OCC, but be explicit.
      let remaining = Number(a.qty);
      const overrideStatus: 'expired' | 'assigned' =
        a.activity_type === 'OPEXP' ? 'expired' : 'assigned';

      while (remaining > 0 && queue.length > 0 && queue[0].side === 'short') {
        const lot = queue[0];
        const matched = Math.min(lot.qty, remaining);
        // Premium kept in full: P/L = opener_premium * matched * mult.
        const pl = lot.price * matched * mult;
        addRealized(lot.openerOrderId, pl);
        statusByOrderId.set(lot.openerOrderId, overrideStatus);
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty === 0) queue.shift();
      }
      // If `remaining > 0` here, the activity didn't match any open short
      // lot in our window — likely the opener is older than our fetch.
      // Silently drop; the closer will go unrecorded for this fetch.
      queues.set(a.symbol, queue);
    }
  }

  return { realizedByOrderId, statusByOrderId };
}
