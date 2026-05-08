import { describe, it, expect } from 'vitest';
import {
  dateRangeToAfter,
  underlyingFromSymbol,
  collectUnderlyings,
} from '../../src/lib/order-filters';

describe('dateRangeToAfter', () => {
  // Anchor to a fixed midweek timestamp so all assertions are deterministic.
  const NOW = new Date('2026-05-08T14:30:00.000Z');

  it('returns null for "all"', () => {
    expect(dateRangeToAfter('all', NOW)).toBeNull();
  });

  it('day anchors to local midnight (so it covers the whole calendar day)', () => {
    const after = dateRangeToAfter('day', NOW);
    expect(after).not.toBeNull();
    const parsed = new Date(after!);
    // Same calendar date as NOW, but at 00:00 in the user's local TZ.
    expect(parsed.getDate()).toBe(NOW.getDate());
    expect(parsed.getMonth()).toBe(NOW.getMonth());
    expect(parsed.getFullYear()).toBe(NOW.getFullYear());
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
    expect(parsed.getSeconds()).toBe(0);
  });

  it('week is exactly 7 days back', () => {
    const after = dateRangeToAfter('week', NOW);
    expect(new Date(after!).getTime()).toBe(NOW.getTime() - 7 * 86400000);
  });

  it('month-rolling is exactly 30 days back', () => {
    const after = dateRangeToAfter('month-rolling', NOW);
    expect(new Date(after!).getTime()).toBe(NOW.getTime() - 30 * 86400000);
  });

  it('month anchors to the 1st of the current calendar month at local midnight', () => {
    const after = dateRangeToAfter('month', NOW);
    const parsed = new Date(after!);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getMonth()).toBe(NOW.getMonth());
    expect(parsed.getFullYear()).toBe(NOW.getFullYear());
    expect(parsed.getHours()).toBe(0);
  });

  it('year anchors to Jan 1 of the current calendar year at local midnight', () => {
    const after = dateRangeToAfter('year', NOW);
    const parsed = new Date(after!);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getMonth()).toBe(0);
    expect(parsed.getFullYear()).toBe(NOW.getFullYear());
    expect(parsed.getHours()).toBe(0);
  });
});

describe('underlyingFromSymbol', () => {
  it('passes stock tickers through unchanged', () => {
    expect(underlyingFromSymbol('AAPL')).toBe('AAPL');
    expect(underlyingFromSymbol('TSLA')).toBe('TSLA');
    expect(underlyingFromSymbol('F')).toBe('F');
  });

  it('extracts the underlying from OCC option symbols', () => {
    expect(underlyingFromSymbol('AMD260116P00120000')).toBe('AMD');
    expect(underlyingFromSymbol('TSLA260620C00500000')).toBe('TSLA');
    expect(underlyingFromSymbol('F260918P00011000')).toBe('F');
    expect(underlyingFromSymbol('SOFI260918P00009000')).toBe('SOFI');
  });

  it('returns the raw symbol when it does not match OCC format', () => {
    // Exotic / unrecognized symbols are passed through rather than corrupted.
    expect(underlyingFromSymbol('BRK.B')).toBe('BRK.B');
    expect(underlyingFromSymbol('')).toBe('');
  });
});

describe('collectUnderlyings', () => {
  it('aggregates and de-duplicates across multiple streams, sorted alphabetically', () => {
    const cons = ['TSLA', 'AMD260116P00120000', 'BAC'];
    const agg = ['AMD', 'F260918P00011000', 'TSLA'];
    expect(collectUnderlyings(cons, agg)).toEqual(['AMD', 'BAC', 'F', 'TSLA']);
  });

  it('tolerates undefined streams (cards that have not loaded yet)', () => {
    expect(collectUnderlyings(undefined, ['AMD', 'F'])).toEqual(['AMD', 'F']);
    expect(collectUnderlyings(undefined, undefined)).toEqual([]);
  });
});
