import { describe, it, expect } from 'vitest';
import { priceVsCost, priceVsCostClass } from '../../src/lib/price-vs-cost';

describe('priceVsCost', () => {
  it('long stock: above cost is favorable (green), below is not (red)', () => {
    const up = priceVsCost(33.5, 32.86, 4);
    expect(up.direction).toBe('above');
    expect(up.favorable).toBe(true);
    expect(priceVsCostClass(up)).toBe('text-hi');
    expect(up.delta).toBeCloseTo(0.64);
    expect(up.deltaPct).toBeCloseTo(1.95, 1);

    const down = priceVsCost(32.04, 32.86, 4); // the CMG row from the 2026-09-24 screenshot
    expect(down.direction).toBe('below');
    expect(down.favorable).toBe(false);
    expect(priceVsCostClass(down)).toBe('text-red');
    expect(down.delta).toBeCloseTo(-0.82);
  });

  it('short option: the comparison flips — price BELOW the premium collected is favorable', () => {
    const decayed = priceVsCost(0.25, 0.55, -1);
    expect(decayed.direction).toBe('below');
    expect(decayed.favorable).toBe(true);
    expect(priceVsCostClass(decayed)).toBe('text-hi');

    const blownOut = priceVsCost(1.1, 0.55, -1);
    expect(blownOut.direction).toBe('above');
    expect(blownOut.favorable).toBe(false);
    expect(priceVsCostClass(blownOut)).toBe('text-red');
  });

  it('flat (sub-cent) is neutral', () => {
    const v = priceVsCost(10.004, 10.0, 1);
    expect(v.direction).toBe('flat');
    expect(v.favorable).toBeNull();
    expect(priceVsCostClass(v)).toBe('text-fg');
  });

  it('zero avg cost yields null pct without dividing by zero', () => {
    expect(priceVsCost(1, 0, 1).deltaPct).toBeNull();
  });
});
