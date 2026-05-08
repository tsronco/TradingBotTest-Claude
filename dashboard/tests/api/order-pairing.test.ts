import { describe, it, expect } from 'vitest';
import {
  pairOrders,
  type PairableOrder,
  type OptionActivityEvent,
} from '../../api/_lib/order-pairing';

// Test-data builders so each case stays readable.
function order(
  id: string,
  symbol: string,
  side: PairableOrder['side'],
  qty: number,
  price: number,
  filled_at: string,
): PairableOrder {
  return {
    id,
    symbol,
    side,
    filled_qty: String(qty),
    filled_avg_price: String(price),
    filled_at,
  };
}

function activity(
  id: string,
  type: OptionActivityEvent['activity_type'],
  symbol: string,
  qty: number,
  occurred_at: string,
): OptionActivityEvent {
  return { id, activity_type: type, symbol, qty: String(qty), occurred_at };
}

const T = (n: number) => `2026-05-${String(n).padStart(2, '0')}T14:30:00.000Z`;

describe('pairOrders — stocks', () => {
  it('pairs a buy followed by a sell as one closed long lot', () => {
    const orders = [
      order('o1', 'TSLA', 'buy', 10, 300, T(1)),
      order('o2', 'TSLA', 'sell', 10, 320, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // P/L stamped on the closer (the sell).
    expect(realizedByOrderId.get('o2')).toBe(200); // (320 - 300) * 10
    expect(realizedByOrderId.has('o1')).toBe(false);
  });

  it('pairs a sell-short followed by a buy as one closed short lot', () => {
    const orders = [
      order('o1', 'TSLA', 'sell_short', 10, 320, T(1)),
      order('o2', 'TSLA', 'buy', 10, 300, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // Short profits when closer < opener.
    expect(realizedByOrderId.get('o2')).toBe(200); // (320 - 300) * 10
  });

  it('shows a loss when the closer is a worse price', () => {
    const orders = [
      order('o1', 'TSLA', 'buy', 5, 300, T(1)),
      order('o2', 'TSLA', 'sell', 5, 290, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    expect(realizedByOrderId.get('o2')).toBe(-50); // (290 - 300) * 5
  });

  it('handles a partial close (closer qty < open qty)', () => {
    const orders = [
      order('o1', 'TSLA', 'buy', 10, 300, T(1)),
      order('o2', 'TSLA', 'sell', 4, 320, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    expect(realizedByOrderId.get('o2')).toBe(80); // (320 - 300) * 4 only
  });

  it('drains lots FIFO when one closer matches multiple opens', () => {
    const orders = [
      order('o1', 'TSLA', 'buy', 5, 300, T(1)),
      order('o2', 'TSLA', 'buy', 5, 310, T(2)),
      order('o3', 'TSLA', 'sell', 8, 320, T(3)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // First lot fully closed (5 * 20 = 100), second lot partially (3 * 10 = 30).
    expect(realizedByOrderId.get('o3')).toBe(130);
  });

  it('keeps symbols isolated from each other', () => {
    const orders = [
      order('o1', 'TSLA', 'buy', 5, 300, T(1)),
      order('o2', 'BAC',  'buy', 5,  40, T(1)),
      order('o3', 'BAC',  'sell', 5, 50, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    expect(realizedByOrderId.get('o3')).toBe(50);
    expect(realizedByOrderId.has('o1')).toBe(false); // TSLA still open.
  });
});

describe('pairOrders — option cycles', () => {
  // OCC symbols used here:
  //  - TSLA260529P00385000 = TSLA $385 put expiring 5/29/2026
  //  - F260918P00011000    = F    $11 put expiring 9/18/2026
  //  - AMD260116P00120000  = AMD  $120 put expiring 1/16/2026
  it('pairs STO put with BTC put using the 100x option multiplier', () => {
    const orders = [
      order('o1', 'TSLA260529P00385000', 'sell', 1, 5.00, T(1)),
      order('o2', 'TSLA260529P00385000', 'buy',  1, 2.00, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // P/L = (5 - 2) * 1 * 100 = $300
    expect(realizedByOrderId.get('o2')).toBe(300);
  });

  it('pairs BTO long call with STC long call', () => {
    const orders = [
      order('o1', 'TSLA260620C00500000', 'buy',  2, 3.00, T(1)),
      order('o2', 'TSLA260620C00500000', 'sell', 2, 4.50, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // P/L = (4.50 - 3.00) * 2 * 100 = $300
    expect(realizedByOrderId.get('o2')).toBe(300);
  });

  it('does NOT pair option legs across different OCC symbols (different strikes/expiries)', () => {
    const orders = [
      order('o1', 'TSLA260529P00385000', 'sell', 1, 5.00, T(1)),
      // Different strike — this is a separate cycle, not a close of the first.
      order('o2', 'TSLA260529P00370000', 'buy',  1, 1.00, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    expect(realizedByOrderId.has('o2')).toBe(false);
  });

  it('pairs partial closes on multi-contract STO cycles', () => {
    const orders = [
      order('o1', 'F260918P00011000', 'sell', 5, 0.20, T(1)),
      // Close 3 of 5 at half premium — 50% close target hit on partial fill.
      order('o2', 'F260918P00011000', 'buy',  3, 0.10, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // P/L = (0.20 - 0.10) * 3 * 100 = $30
    expect(realizedByOrderId.get('o2')).toBeCloseTo(30, 6);
  });
});

describe('pairOrders — assignments and expirations', () => {
  it('OPEXP stamps full premium as P/L on the originating STO and overrides status to expired', () => {
    const orders = [
      order('sto1', 'TSLA260529P00385000', 'sell', 1, 5.00, T(1)),
    ];
    const acts = [
      activity('exp1', 'OPEXP', 'TSLA260529P00385000', 1, T(28)),
    ];
    const { realizedByOrderId, statusByOrderId } = pairOrders(orders, acts);
    expect(realizedByOrderId.get('sto1')).toBe(500); // 5.00 * 1 * 100
    expect(statusByOrderId.get('sto1')).toBe('expired');
  });

  it('OPASN stamps full premium and overrides status to assigned', () => {
    const orders = [
      order('sto1', 'F260918P00011000', 'sell', 2, 0.20, T(1)),
    ];
    const acts = [
      activity('asn1', 'OPASN', 'F260918P00011000', 2, T(28)),
    ];
    const { realizedByOrderId, statusByOrderId } = pairOrders(orders, acts);
    expect(realizedByOrderId.get('sto1')).toBeCloseTo(40, 6); // 0.20 * 2 * 100
    expect(statusByOrderId.get('sto1')).toBe('assigned');
  });

  it('does not pair an assignment to an STO that has already been closed by BTC', () => {
    const orders = [
      order('sto1', 'TSLA260529P00385000', 'sell', 1, 5.00, T(1)),
      order('btc1', 'TSLA260529P00385000', 'buy',  1, 2.00, T(5)),
    ];
    // Spurious activity arriving for an already-closed lot — should be dropped.
    const acts = [
      activity('asn1', 'OPASN', 'TSLA260529P00385000', 1, T(28)),
    ];
    const { realizedByOrderId, statusByOrderId } = pairOrders(orders, acts);
    expect(realizedByOrderId.get('btc1')).toBe(300); // BTC pair stands.
    expect(realizedByOrderId.has('sto1')).toBe(false);
    expect(statusByOrderId.has('sto1')).toBe(false);
  });

  it('partial assignment closes some lots and leaves the rest open', () => {
    const orders = [
      order('sto1', 'F260918P00011000', 'sell', 5, 0.20, T(1)),
    ];
    const acts = [
      // Only 2 of 5 contracts assigned.
      activity('asn1', 'OPASN', 'F260918P00011000', 2, T(28)),
    ];
    const { realizedByOrderId, statusByOrderId } = pairOrders(orders, acts);
    // Assignment realizes premium for the matched lots.
    expect(realizedByOrderId.get('sto1')).toBeCloseTo(40, 6); // 0.20 * 2 * 100
    expect(statusByOrderId.get('sto1')).toBe('assigned');
    // The remaining 3 contracts are still open — verifiable by closing them.
    const ordersWithBtc = [
      ...orders,
      order('btc1', 'F260918P00011000', 'buy', 3, 0.05, T(30)),
    ];
    const second = pairOrders(ordersWithBtc, acts);
    expect(second.realizedByOrderId.get('btc1')).toBeCloseTo(45, 6); // (0.20 - 0.05) * 3 * 100
  });
});

describe('pairOrders — defensive cases', () => {
  it('skips orders with zero filled_qty (canceled-but-still-in-feed)', () => {
    const orders = [
      order('o1', 'TSLA', 'buy', 0, 300, T(1)),
      order('o2', 'TSLA', 'sell', 5, 320, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    // o1 was filtered, so o2 is treated as opening a NEW short lot — no P/L stamped.
    expect(realizedByOrderId.has('o2')).toBe(false);
  });

  it('returns empty result for empty inputs', () => {
    const result = pairOrders([], []);
    expect(result.realizedByOrderId.size).toBe(0);
    expect(result.statusByOrderId.size).toBe(0);
  });

  it('handles an order with NaN price by skipping it', () => {
    const orders = [
      // Simulate a malformed Alpaca response.
      { id: 'bad', symbol: 'TSLA', side: 'buy' as const, filled_qty: '5', filled_avg_price: 'not-a-number', filled_at: T(1) },
      order('o2', 'TSLA', 'sell', 5, 300, T(2)),
    ];
    const { realizedByOrderId } = pairOrders(orders);
    expect(realizedByOrderId.has('o2')).toBe(false);
  });
});
