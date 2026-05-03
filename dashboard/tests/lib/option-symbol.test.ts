import { describe, it, expect } from 'vitest';
import { parseOptionSymbol, daysToExpiration } from '../../src/lib/option-symbol';

describe('parseOptionSymbol', () => {
  it('parses BAC260522P00050000 -> put $50 expiring 2026-05-22', () => {
    expect(parseOptionSymbol('BAC260522P00050000')).toEqual({
      underlying: 'BAC',
      expiration: '2026-05-22',
      type: 'put',
      strike: 50,
    });
  });

  it('parses TSLA260522C00355000 -> call $355', () => {
    const p = parseOptionSymbol('TSLA260522C00355000');
    expect(p?.type).toBe('call');
    expect(p?.strike).toBe(355);
    expect(p?.underlying).toBe('TSLA');
  });

  it('parses fractional strikes (KO260522P00067500 = $67.50)', () => {
    expect(parseOptionSymbol('KO260522P00067500')?.strike).toBe(67.5);
  });

  it('returns null for non-option symbols', () => {
    expect(parseOptionSymbol('TSLA')).toBeNull();
    expect(parseOptionSymbol('TSLA-USD')).toBeNull();
    expect(parseOptionSymbol('')).toBeNull();
  });
});

describe('daysToExpiration', () => {
  it('returns 0 when expiring today', () => {
    const today = new Date('2026-05-22T10:00:00-04:00');
    expect(daysToExpiration('2026-05-22', today)).toBe(0);
  });

  it('returns positive days when in future', () => {
    const today = new Date('2026-05-15T10:00:00-04:00');
    expect(daysToExpiration('2026-05-22', today)).toBe(7);
  });

  it('returns negative days when past expiration', () => {
    const today = new Date('2026-05-25T10:00:00-04:00');
    expect(daysToExpiration('2026-05-22', today)).toBeLessThan(0);
  });
});
