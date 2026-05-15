// dashboard/tests/lib/fillHint.test.ts
import { describe, it, expect } from 'vitest';
import { computeFillHint } from '../../src/lib/fillHint';

describe('computeFillHint', () => {
  it('sell: fast=bid, balanced=mid, patient toward ask', () => {
    const h = computeFillHint({ side: 'sell', bid: 2.30, ask: 2.40, oi: 500 })!;
    expect(h.fast.price).toBeCloseTo(2.30, 2);
    expect(h.balanced.price).toBeCloseTo(2.35, 2);
    expect(h.patient.price).toBeGreaterThan(2.35);
    expect(h.patient.price).toBeLessThan(2.40);
  });
  it('buy: fast=ask, patient toward bid', () => {
    const h = computeFillHint({ side: 'buy', bid: 1.00, ask: 1.20 })!;
    expect(h.fast.price).toBeCloseTo(1.20, 2);
    expect(h.patient.price).toBeGreaterThan(1.00);
    expect(h.patient.price).toBeLessThan(1.10);
  });
  it('tight + liquid → confident mid', () => {
    const h = computeFillHint({ side: 'sell', bid: 5.00, ask: 5.05, oi: 1000 })!;
    expect(h.confidence).toMatch(/mid usually fills/i);
  });
  it('wide spread → concede note', () => {
    const h = computeFillHint({ side: 'sell', bid: 1.00, ask: 1.40 })!;
    expect(h.confidence).toMatch(/concede toward the bid/i);
  });
  it('crossed/missing quote → null', () => {
    expect(computeFillHint({ side: 'sell', bid: 0, ask: 0 })).toBeNull();
    expect(computeFillHint({ side: 'buy', bid: 2.5, ask: 2.4 })).toBeNull();
  });
  it('sub-penny option (bid < tick) returns null instead of zero/negative tiers', () => {
    expect(computeFillHint({ side: 'sell', bid: 0.001, ask: 0.002 })).toBeNull();
  });
  it('all tier prices are clean (no floating-point tails)', () => {
    const h = computeFillHint({ side: 'sell', bid: 2.30, ask: 2.40 })!;
    for (const t of [h.fast, h.balanced, h.patient, { price: h.mid }]) {
      expect(t.price.toString()).not.toMatch(/\d{6,}/);
    }
  });
});
