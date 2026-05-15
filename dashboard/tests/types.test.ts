import { describe, it, expect } from 'vitest';
import type { Trade, SpreadDetails } from '../api/_lib/trade-types';

describe('Trade types — spread', () => {
  it('Trade has optional spread field with full SpreadDetails shape', () => {
    const sp: SpreadDetails = {
      spread_type: 'put_credit',
      short_leg: {
        occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37,
        fill_price: 0.37, qty: 1,
      },
      long_leg: {
        occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12,
        fill_price: 0.12, qty: 1,
      },
      expiration: '2026-05-29',
      width: 1.0,
      net_credit: 0.25,
      max_loss: 0.75,
    };
    const trade: Partial<Trade> = { id: 'T-2026-05-15-001', spread: sp };
    expect(trade.spread?.short_leg.strike).toBe(12.5);
  });
});
