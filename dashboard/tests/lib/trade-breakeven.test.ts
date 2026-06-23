import { describe, it, expect } from 'vitest';
import { tradeBreakevens } from '../../src/lib/trade-breakeven';
import type { Trade } from '../../src/lib/trade-types';

// Minimal Trade factory — fills required fields with inert defaults so each
// test only sets what it cares about.
function mkTrade(p: Partial<Trade>): Trade {
  return {
    id: 'T-2026-06-23-001', account: 'conservative_paper', asset_class: 'stock',
    symbol: 'F', side: 'buy', qty: 1, order_type: 'limit', limit_price: null,
    stop_price: null, trail_pct: null, tif: 'day', contract_symbol: null,
    strike: null, expiration: null, contract_type: null, greeks_at_entry: null,
    alpaca_order_id: 'x', alpaca_close_order_id: null, submitted_at: '2026-06-23T13:00:00Z',
    filled_at: null, filled_avg_price: null, closed_at: null, closed_avg_price: null,
    realized_pnl: null, closed_by: null, tags: [], entry_grade: 'B',
    entry_reasoning: 'r', journal: '', exposure_at_submit: 0,
    rule_warnings_at_entry: [], schema: 1, ...p,
  } as Trade;
}

describe('tradeBreakevens', () => {
  it('long stock → break-even is the fill price (cost basis)', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'stock', side: 'buy', qty: 10, filled_avg_price: 14.5,
    }));
    expect(be).toHaveLength(1);
    expect(be[0]).toBeCloseTo(14.5, 2);
  });

  it('long call → strike + premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'call', strike: 400,
      qty: 1, filled_avg_price: 2.0,
    }));
    expect(be[0]).toBeCloseTo(402, 2);
  });

  it('long put → strike − premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'put', strike: 100,
      qty: 1, filled_avg_price: 1.5,
    }));
    expect(be[0]).toBeCloseTo(98.5, 2);
  });

  it('short put (CSP) → strike − premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'STO', contract_type: 'put', strike: 12.5,
      qty: 1, filled_avg_price: 0.4,
    }));
    expect(be[0]).toBeCloseTo(12.1, 2);
  });

  it('put-credit spread → short strike − net credit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'A', strike: 12.5, entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg: { occ: 'B', strike: 11.5, entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        expiration: '2026-07-17', width: 1, net_credit: 0.25, max_loss: 0.75, max_profit: 0.25,
      },
    }));
    expect(be[0]).toBeCloseTo(12.25, 2);
  });

  it('call-credit spread → short strike + net credit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'call_credit',
        short_leg: { occ: 'A', strike: 100, entry_premium: 1.2, fill_price: 1.2, qty: 1 },
        long_leg: { occ: 'B', strike: 105, entry_premium: 0.6, fill_price: 0.6, qty: 1 },
        expiration: '2026-07-17', width: 5, net_credit: 0.6, max_loss: 4.4, max_profit: 0.6,
      },
    }));
    expect(be[0]).toBeCloseTo(100.6, 2);
  });

  it('spread with no leg fill prices falls back to entry_premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'A', strike: 12.5, entry_premium: 0.37, fill_price: null, qty: 1 },
        long_leg: { occ: 'B', strike: 11.5, entry_premium: 0.12, fill_price: null, qty: 1 },
        expiration: '2026-07-17', width: 1, net_credit: 0.25, max_loss: 0.75, max_profit: 0.25,
      },
    }));
    expect(be[0]).toBeCloseTo(12.25, 2);
  });

  it('unfilled single-leg falls back to the order limit price', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'call', strike: 400,
      qty: 1, filled_avg_price: null, limit_price: 2.0,
    }));
    expect(be[0]).toBeCloseTo(402, 2);
  });

  it('canceled / no usable price → empty', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'BTO', contract_type: 'call', strike: 400,
      qty: 1, filled_avg_price: null, limit_price: null, closed_by: 'canceled',
    }));
    expect(be).toEqual([]);
  });

  it('put-debit spread → long strike − net debit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'put_debit',
        short_leg: { occ: 'A', strike: 95, entry_premium: 0.5, fill_price: 0.5, qty: 1 },
        long_leg: { occ: 'B', strike: 100, entry_premium: 2.0, fill_price: 2.0, qty: 1 },
        expiration: '2026-07-17', width: 5, net_credit: 0, net_debit: 1.5, max_loss: 1.5, max_profit: 3.5,
      },
    }));
    expect(be[0]).toBeCloseTo(98.5, 2);
  });

  it('call-debit spread → long strike + net debit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'call_debit',
        short_leg: { occ: 'A', strike: 105, entry_premium: 1.5, fill_price: 1.5, qty: 1 },
        long_leg: { occ: 'B', strike: 100, entry_premium: 3.0, fill_price: 3.0, qty: 1 },
        expiration: '2026-07-17', width: 5, net_credit: 0, net_debit: 1.5, max_loss: 1.5, max_profit: 3.5,
      },
    }));
    expect(be[0]).toBeCloseTo(101.5, 2);
  });

  it('spread with no leg prices at all falls back to the stored net credit', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'spread', qty: 1,
      spread: {
        spread_type: 'put_credit',
        short_leg: { occ: 'A', strike: 12.5, entry_premium: null, fill_price: null, qty: 1 },
        long_leg: { occ: 'B', strike: 11.5, entry_premium: null, fill_price: null, qty: 1 },
        expiration: '2026-07-17', width: 1, net_credit: 0.25, max_loss: 0.75, max_profit: 0.25,
      },
    }));
    expect(be[0]).toBeCloseTo(12.25, 2);
  });

  it('short call (covered call) → strike + premium', () => {
    const be = tradeBreakevens(mkTrade({
      asset_class: 'option', side: 'STO', contract_type: 'call', strike: 100,
      qty: 1, filled_avg_price: 2.0,
    }));
    expect(be[0]).toBeCloseTo(102, 2);
  });
});
