import { describe, it, expect } from 'vitest';
import { describeSpreadOrder } from '../../src/lib/spread-order';

describe('describeSpreadOrder', () => {
  it('describes a SOFI put credit spread from mleg legs (sell short / buy long)', () => {
    const r = describeSpreadOrder({
      order_class: 'mleg',
      legs: [
        { symbol: 'SOFI260605P00014000', side: 'sell' },
        { symbol: 'SOFI260605P00013000', side: 'buy' },
      ],
    });
    expect(r).toEqual({
      underlying: 'SOFI',
      type: 'put',
      shortStrike: 14,
      longStrike: 13,
      expiration: '2026-06-05',
      label: 'PUT SPREAD $14/$13',
    });
  });

  it('is order-independent (legs given long-first still resolve by side)', () => {
    const r = describeSpreadOrder({
      legs: [
        { symbol: 'M260605P00016000', side: 'buy' },
        { symbol: 'M260605P00017000', side: 'sell' },
      ],
    });
    expect(r?.underlying).toBe('M');
    expect(r?.shortStrike).toBe(17);
    expect(r?.longStrike).toBe(16);
    expect(r?.label).toBe('PUT SPREAD $17/$16');
  });

  it('treats sell_short as the short leg', () => {
    const r = describeSpreadOrder({
      legs: [
        { symbol: 'AAL260619P00012500', side: 'sell_short' },
        { symbol: 'AAL260619P00011500', side: 'buy' },
      ],
    });
    expect(r?.shortStrike).toBe(12.5);
    expect(r?.longStrike).toBe(11.5);
    expect(r?.label).toBe('PUT SPREAD $12.5/$11.5');
  });

  it('returns null for a single-leg / non-spread order', () => {
    expect(describeSpreadOrder({ symbol: 'AAPL', side: 'buy' })).toBeNull();
    expect(describeSpreadOrder({ legs: [] })).toBeNull();
    expect(describeSpreadOrder({ legs: undefined })).toBeNull();
    expect(describeSpreadOrder({})).toBeNull();
  });

  it('returns null when legs are not a clean 2-leg single-expiry vertical', () => {
    // different expirations (calendar/diagonal) — not a simple vertical
    expect(
      describeSpreadOrder({
        legs: [
          { symbol: 'SOFI260605P00014000', side: 'sell' },
          { symbol: 'SOFI260703P00013000', side: 'buy' },
        ],
      }),
    ).toBeNull();
    // unparseable leg symbol
    expect(
      describeSpreadOrder({
        legs: [
          { symbol: 'SOFI260605P00014000', side: 'sell' },
          { symbol: null, side: 'buy' },
        ],
      }),
    ).toBeNull();
    // both same side — can't identify short vs long
    expect(
      describeSpreadOrder({
        legs: [
          { symbol: 'SOFI260605P00014000', side: 'sell' },
          { symbol: 'SOFI260605P00013000', side: 'sell' },
        ],
      }),
    ).toBeNull();
  });
});
