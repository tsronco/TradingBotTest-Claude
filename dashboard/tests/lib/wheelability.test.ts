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

describe('scoreWheelability — band filter (manual)', () => {
  it('rejects strikes too close to market (<7% OTM) even with great yield', () => {
    const stockPrice = 109;
    // Near-ATM put has fat extrinsic and great yield, but it's NOT a wheel
    // candidate — assignment risk is too high. Conservative band is 7-13% OTM.
    const tooClose = put('TOO-CLOSE-108', 108, stockPrice, 1.0); // ~0.6% OTM
    const inBand = put('IN-BAND-98', 98, stockPrice, 1.0);       // ~10% OTM ✓

    const result = scoreWheelability({
      stockPrice,
      optionsBuyingPower: 100_000,
      contracts: [tooClose.contract, inBand.contract],
      snapshots: { 'TOO-CLOSE-108': tooClose.snapshot, 'IN-BAND-98': inBand.snapshot },
      mode: 'manual',
    });
    expect(result.bestStrike).toBe(98);
  });

  it('rejects strikes too far OTM (>13% OTM)', () => {
    const stockPrice = 100;
    const tooFar = put('TOO-FAR-80', 80, stockPrice, 0.10);  // ~20% OTM
    const inBand = put('IN-BAND-90', 90, stockPrice, 0.50);  // ~10% OTM ✓
    const result = scoreWheelability({
      stockPrice,
      optionsBuyingPower: 100_000,
      contracts: [tooFar.contract, inBand.contract],
      snapshots: { 'TOO-FAR-80': tooFar.snapshot, 'IN-BAND-90': inBand.snapshot },
      mode: 'manual',
    });
    expect(result.bestStrike).toBe(90);
  });

  it('does NOT recommend an ITM put even with the highest premium', () => {
    const stockPrice = 109;
    const otm = put('OTM-98', 98, stockPrice, 1.0);
    const itm = put('ITM-150', 150, stockPrice, 0.5);
    const result = scoreWheelability({
      stockPrice,
      optionsBuyingPower: 100_000,
      contracts: [otm.contract, itm.contract],
      snapshots: { 'OTM-98': otm.snapshot, 'ITM-150': itm.snapshot },
      mode: 'manual',
    });
    expect(result.bestStrike).toBe(98);
  });

  it('returns no_puts_in_range when no strikes fall in the band', () => {
    const stockPrice = 109;
    const itm = put('ITM-150', 150, stockPrice, 0.5);
    const tooClose = put('TOO-CLOSE-108', 108, stockPrice, 1.0);
    const result = scoreWheelability({
      stockPrice,
      optionsBuyingPower: 100_000,
      contracts: [itm.contract, tooClose.contract],
      snapshots: { 'ITM-150': itm.snapshot, 'TOO-CLOSE-108': tooClose.snapshot },
      mode: 'manual',
    });
    expect(result.reason).toBe('no_puts_in_range');
  });
});

describe('scoreWheelability — BP fit uses options BP only', () => {
  it('reports bpFit=false when strike collateral exceeds options BP, even if cash is plenty', () => {
    const stockPrice = 100;
    // Conservative target: $90 strike → $9,000 collateral required.
    // Account has $98k cash but only $6,500 options BP (existing CSPs absorbed the rest).
    const target = put('TARGET-90', 90, stockPrice, 0.50);
    const result = scoreWheelability({
      stockPrice,
      optionsBuyingPower: 6_500, // not enough — $9k required
      contracts: [target.contract],
      snapshots: { 'TARGET-90': target.snapshot },
      mode: 'manual',
    });
    expect(result.reason).toBe('computed');
    expect(result.bestStrike).toBe(90);
    expect(result.bpFit).toBe(false);
  });
});

describe('scoreWheelability — within-band yield tiebreaker', () => {
  it('prefers higher-yield strike when both fit the band', () => {
    const stockPrice = 100;
    // Both 8% OTM and 12% OTM fit the conservative 7-13% band.
    const richer = put('RICHER-92', 92, stockPrice, 1.50);  // 8% OTM, higher yield
    const thinner = put('THINNER-88', 88, stockPrice, 0.30); // 12% OTM, lower yield
    const result = scoreWheelability({
      stockPrice,
      optionsBuyingPower: 100_000,
      contracts: [richer.contract, thinner.contract],
      snapshots: { 'RICHER-92': richer.snapshot, 'THINNER-88': thinner.snapshot },
      mode: 'manual',
    });
    expect(result.bestStrike).toBe(92);
  });
});
