import { describe, it, expect } from 'vitest';
import { optionUnderlyings, parseUnderlyingQuotes } from '../../src/lib/underlying-quotes';

describe('optionUnderlyings', () => {
  it('collects unique underlyings of option positions only', () => {
    expect(optionUnderlyings([
      { symbol: 'BAC261120P00049000', asset_class: 'us_option' },
      { symbol: 'BAC261120P00048000', asset_class: 'us_option' },
      { symbol: 'TSLA260918C00352500', asset_class: 'us_option' },
      { symbol: 'WMT', asset_class: 'us_equity' },
    ])).toEqual(['BAC', 'TSLA']);
  });
  it('empty when no options', () => {
    expect(optionUnderlyings([{ symbol: 'WMT', asset_class: 'us_equity' }])).toEqual([]);
  });
});

describe('parseUnderlyingQuotes', () => {
  it('last trade + change vs previous close', () => {
    const q = parseUnderlyingQuotes({ BAC: { latestTrade: { p: 49.57 }, prevDailyBar: { c: 50.01 } } });
    expect(q.BAC.last).toBe(49.57);
    expect(q.BAC.changePct).toBeCloseTo(-0.8798, 3);
  });
  it('falls back to the daily bar close; null change without a prev close', () => {
    expect(parseUnderlyingQuotes({ X: { dailyBar: { c: 10 } } })).toEqual({ X: { last: 10, changePct: null } });
  });
  it('skips symbols with no usable price and tolerates junk input', () => {
    expect(parseUnderlyingQuotes({ A: null, B: {}, C: { latestTrade: { p: 0 } } })).toEqual({});
    expect(parseUnderlyingQuotes(undefined)).toEqual({});
  });
});
