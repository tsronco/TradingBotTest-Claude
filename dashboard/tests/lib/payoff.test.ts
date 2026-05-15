import { describe, it, expect } from 'vitest';
import { stockLegPL, optionLegPL, totalPL, buildPayoff, type Leg } from '../../src/lib/payoff';

describe('leg primitives', () => {
  it('long stock P/L is linear', () => {
    expect(stockLegPL(110, { kind: 'stock', dir: 'long', entry: 100, shares: 10 })).toBe(100);
    expect(stockLegPL(90, { kind: 'stock', dir: 'long', entry: 100, shares: 10 })).toBe(-100);
  });
  it('short stock P/L inverts', () => {
    expect(stockLegPL(90, { kind: 'stock', dir: 'short', entry: 100, shares: 10 })).toBe(100);
  });
  it('short put (CSP) pays the credit above strike, loses below', () => {
    const leg: Leg = { kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 };
    expect(optionLegPL(105, leg)).toBe(200);          // credit kept, ×100
    expect(optionLegPL(100, leg)).toBe(200);          // at strike
    expect(optionLegPL(90, leg)).toBe(2 * 100 - 10 * 100); // (2 - 10)*100 = -800
  });
  it('long call P/L', () => {
    const leg: Leg = { kind: 'option', dir: 'long', type: 'call', strike: 100, premium: 3, contracts: 2 };
    expect(optionLegPL(100, leg)).toBe(-3 * 100 * 2); // -600
    expect(optionLegPL(110, leg)).toBe((10 - 3) * 100 * 2); // 1400
  });
  it('totalPL sums legs', () => {
    const legs: Leg[] = [
      { kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 3, contracts: 1 },
      { kind: 'option', dir: 'long', type: 'put', strike: 95, premium: 1, contracts: 1 },
    ];
    expect(totalPL(120, legs)).toBe((3 - 1) * 100); // both OTM: net credit 2 ×100 = 200
  });
});

describe('buildPayoff', () => {
  it('CSP: short $100 put, $2 credit, 1 contract', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 }], 101);
    expect(r.maxProfit).toBe(200);
    expect(r.maxLoss).toBe(-(100 - 2) * 100); // -9800
    expect(r.breakevens).toEqual([98]);
    expect(r.window.lo).toBeLessThanOrEqual(101);
    expect(r.window.hi).toBeGreaterThanOrEqual(101);
    expect(r.points.length).toBeGreaterThan(64);
  });
  it('put credit spread: short 100 / long 95, $2 net credit', () => {
    const r = buildPayoff([
      { kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 3, contracts: 1 },
      { kind: 'option', dir: 'long', type: 'put', strike: 95, premium: 1, contracts: 1 },
    ], 102);
    expect(r.maxProfit).toBe(200);                 // credit 2 ×100
    expect(r.maxLoss).toBe(-((100 - 95) - 2) * 100); // -(width-credit)*100 = -300
    expect(r.breakevens).toEqual([98]);            // Ks - credit
  });
  it('long call: unbounded upside', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'long', type: 'call', strike: 100, premium: 3, contracts: 1 }], 100);
    expect(r.maxProfit).toBeNull();
    expect(r.maxLoss).toBe(-300);
    expect(r.breakevens).toEqual([103]);
  });
  it('long stock: maxLoss bounded at 0 price, upside unbounded', () => {
    const r = buildPayoff([{ kind: 'stock', dir: 'long', entry: 50, shares: 10 }], 50);
    expect(r.maxProfit).toBeNull();
    expect(r.maxLoss).toBe(-500);
    expect(r.breakevens).toEqual([50]);
  });
  it('window containment: CSP currentPrice is within window', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 }], 101);
    expect(r.window.lo).toBeLessThanOrEqual(r.currentPrice);
    expect(r.window.hi).toBeGreaterThanOrEqual(r.currentPrice);
  });
});

describe('buildPayoff robustness', () => {
  it('contracts=0: maxProfit/maxLoss are 0, no phantom breakevens', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 0 }], 101);
    expect(r.maxProfit).toBe(0);
    expect(r.maxLoss).toBe(0);
    expect(r.breakevens).toEqual([]);
  });

  it('empty legs: points length 0, extrema null, breakevens []', () => {
    const r = buildPayoff([], 100);
    expect(r.points.length).toBe(0);
    expect(r.maxProfit).toBeNull();
    expect(r.maxLoss).toBeNull();
    expect(r.breakevens).toEqual([]);
  });

  it('NaN premium: finite-guard returns empty result', () => {
    const r = buildPayoff([{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: NaN, contracts: 1 }], 101);
    expect(r.points.length).toBe(0);
    expect(r.maxProfit).toBeNull();
    expect(r.maxLoss).toBeNull();
  });

  it('iron condor: exactly 2 breakevens', () => {
    // short call 110 premium 2, long call 115 premium 0.5, short put 90 premium 2, long put 85 premium 0.5
    // net credit = (2 - 0.5) + (2 - 0.5) = 3.0 per share
    const r = buildPayoff([
      { kind: 'option', dir: 'short', type: 'call', strike: 110, premium: 2,   contracts: 1 },
      { kind: 'option', dir: 'long',  type: 'call', strike: 115, premium: 0.5, contracts: 1 },
      { kind: 'option', dir: 'short', type: 'put',  strike: 90,  premium: 2,   contracts: 1 },
      { kind: 'option', dir: 'long',  type: 'put',  strike: 85,  premium: 0.5, contracts: 1 },
    ], 100);
    expect(r.breakevens.length).toBe(2);
  });
});
