import { describe, expect, it } from 'vitest';
import { scoreWheelability } from '../../src/lib/wheelability';

// Build a put-chain row for a given strike, ~21 DTE, with a realistic bid that
// approximates intrinsic + a small extrinsic premium.
function put(symbol: string, strike: number, stockPrice: number, extrinsic: number) {
  const intrinsic = Math.max(0, strike - stockPrice);
  const expiration = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  return {
    contract: { symbol, type: 'put' as const, strike_price: String(strike), expiration_date: expiration },
    snapshot: { latestQuote: { ap: intrinsic + extrinsic + 0.05, bp: intrinsic + extrinsic } },
  };
}

describe('scoreWheelability — ITM rejection', () => {
  it('does NOT recommend an ITM put even if it has the highest premium', () => {
    const stockPrice = 109;
    // OTM put at $98 (~10% OTM, the wheel target) with $1 premium.
    // ITM put at $150 — bid ~$42 (almost all intrinsic). The old formula's
    // `bid * 100` term would dominate; the fix should reject ITM entirely.
    const otm = put('OTM-98', 98, stockPrice, 1.0);
    const itm = put('ITM-150', 150, stockPrice, 0.5);

    const result = scoreWheelability({
      stockPrice,
      buyingPower: 100_000,
      contracts: [otm.contract, itm.contract],
      snapshots: { 'OTM-98': otm.snapshot, 'ITM-150': itm.snapshot },
    });

    expect(result.reason).toBe('computed');
    expect(result.bestStrike).toBe(98);
    // Sanity: the bad pick would have been 150
    expect(result.bestStrike).not.toBe(150);
  });

  it('falls back to no_puts_in_range when only ITM puts exist', () => {
    const stockPrice = 109;
    const itm1 = put('ITM-115', 115, stockPrice, 0.5);
    const itm2 = put('ITM-150', 150, stockPrice, 0.5);
    const result = scoreWheelability({
      stockPrice,
      buyingPower: 100_000,
      contracts: [itm1.contract, itm2.contract],
      snapshots: { 'ITM-115': itm1.snapshot, 'ITM-150': itm2.snapshot },
    });
    expect(result.reason).toBe('no_puts_in_range');
  });
});

describe('scoreWheelability — yield-based scoring', () => {
  it('prefers higher yield (premium/strike) when both candidates are OTM', () => {
    const stockPrice = 100;
    // Candidate A: $90 strike (10% OTM, target), bid $0.50 → yield 0.56%
    // Candidate B: $95 strike (5% OTM), bid $1.50 → yield 1.58%
    // Both fit the wheel target band; B has clearly better yield.
    const a = put('A', 90, stockPrice, 0.50);
    const b = put('B', 95, stockPrice, 1.50);
    const result = scoreWheelability({
      stockPrice,
      buyingPower: 100_000,
      contracts: [a.contract, b.contract],
      snapshots: { A: a.snapshot, B: b.snapshot },
    });
    expect(result.bestStrike).toBe(95);
  });
});
