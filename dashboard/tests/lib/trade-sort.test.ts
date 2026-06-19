import { describe, it, expect } from 'vitest';
import type { Trade } from '../../src/lib/trade-types';
import {
  sortTradePairs,
  defaultDir,
  type TradeRowPair,
  type SortKey,
  type SortDir,
} from '../../src/lib/trade-sort';

// Minimal pair factory — sortValue only reads a handful of fields, so the rest
// are filled with neutral defaults and cast to Trade.
function pair(over: Partial<Trade> & { ai_letter?: string | null } = {}): TradeRowPair {
  const { ai_letter = null, ...tradeOver } = over;
  const trade = {
    id: 't', account: 'manual_paper', asset_class: 'option', symbol: 'AAA',
    side: 'BTO', qty: 1, submitted_at: '2026-01-01T00:00:00Z',
    filled_avg_price: null, closed_avg_price: null, realized_pnl: null,
    entry_grade: 'C', tags: [],
    ...tradeOver,
  } as unknown as Trade;
  return { trade, grade: { trade_id: trade.id, ai_letter, calibration: null } };
}

function order(pairs: TradeRowPair[], key: SortKey, dir: SortDir): string[] {
  return sortTradePairs(pairs, { key, dir }).map((p) => p.trade.id);
}

describe('trade-sort — sortTradePairs', () => {
  it('returns the input order unchanged when sort is null', () => {
    const pairs = [pair({ id: 'b' }), pair({ id: 'a' }), pair({ id: 'c' })];
    expect(sortTradePairs(pairs, null)).toBe(pairs);
  });

  it('sorts by date ascending and descending', () => {
    const pairs = [
      pair({ id: 'mid', submitted_at: '2026-02-01T00:00:00Z' }),
      pair({ id: 'new', submitted_at: '2026-03-01T00:00:00Z' }),
      pair({ id: 'old', submitted_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(order(pairs, 'date', 'asc')).toEqual(['old', 'mid', 'new']);
    expect(order(pairs, 'date', 'desc')).toEqual(['new', 'mid', 'old']);
  });

  it('sorts qty numerically, not lexically (10 > 2)', () => {
    const pairs = [pair({ id: 'q2', qty: 2 }), pair({ id: 'q10', qty: 10 }), pair({ id: 'q1', qty: 1 })];
    expect(order(pairs, 'qty', 'asc')).toEqual(['q1', 'q2', 'q10']);
    expect(order(pairs, 'qty', 'desc')).toEqual(['q10', 'q2', 'q1']);
  });

  it('sorts P&L with winners/losers ordered, nulls always last', () => {
    const pairs = [
      pair({ id: 'open', realized_pnl: null }),
      pair({ id: 'win', realized_pnl: 120 }),
      pair({ id: 'loss', realized_pnl: -45 }),
    ];
    // desc: biggest win first, open (null) last
    expect(order(pairs, 'pnl', 'desc')).toEqual(['win', 'loss', 'open']);
    // asc: biggest loss first, open (null) STILL last (not flipped)
    expect(order(pairs, 'pnl', 'asc')).toEqual(['loss', 'win', 'open']);
  });

  it('keeps nulls last in both directions for exit price', () => {
    const pairs = [
      pair({ id: 'a', closed_avg_price: 5 }),
      pair({ id: 'open', closed_avg_price: null }),
      pair({ id: 'b', closed_avg_price: 9 }),
    ];
    expect(order(pairs, 'exit', 'asc')).toEqual(['a', 'b', 'open']);
    expect(order(pairs, 'exit', 'desc')).toEqual(['b', 'a', 'open']);
  });

  it('sorts symbol alphabetically', () => {
    const pairs = [pair({ id: 'z', symbol: 'ZM' }), pair({ id: 'a', symbol: 'AAPL' }), pair({ id: 'm', symbol: 'MSFT' })];
    expect(order(pairs, 'symbol', 'asc')).toEqual(['a', 'm', 'z']);
    expect(order(pairs, 'symbol', 'desc')).toEqual(['z', 'm', 'a']);
  });

  it('sorts grade best→worst on ascending (A+ before F)', () => {
    const pairs = [
      pair({ id: 'f', entry_grade: 'F' }),
      pair({ id: 'aplus', entry_grade: 'A+' }),
      pair({ id: 'bminus', entry_grade: 'B-' }),
    ];
    expect(order(pairs, 'grade', 'asc')).toEqual(['aplus', 'bminus', 'f']);
    expect(order(pairs, 'grade', 'desc')).toEqual(['f', 'bminus', 'aplus']);
  });

  it('sorts by AI grade, ungraded (null) last', () => {
    const pairs = [
      pair({ id: 'ungraded', ai_letter: null }),
      pair({ id: 'good', ai_letter: 'A' }),
      pair({ id: 'bad', ai_letter: 'D' }),
    ];
    expect(order(pairs, 'ai', 'asc')).toEqual(['good', 'bad', 'ungraded']);
  });

  it('sorts tags by first tag, untagged last', () => {
    const pairs = [
      pair({ id: 'none', tags: [] }),
      pair({ id: 'wheel', tags: ['wheel', 'csp'] }),
      pair({ id: 'earnings', tags: ['earnings'] }),
    ];
    expect(order(pairs, 'tags', 'asc')).toEqual(['earnings', 'wheel', 'none']);
  });

  it('is stable — equal keys keep original relative order', () => {
    const pairs = [
      pair({ id: 'first', symbol: 'TIE' }),
      pair({ id: 'second', symbol: 'TIE' }),
      pair({ id: 'third', symbol: 'TIE' }),
    ];
    expect(order(pairs, 'symbol', 'asc')).toEqual(['first', 'second', 'third']);
    expect(order(pairs, 'symbol', 'desc')).toEqual(['first', 'second', 'third']);
  });

  it('does not mutate the input array', () => {
    const pairs = [pair({ id: 'b', qty: 2 }), pair({ id: 'a', qty: 1 })];
    const before = pairs.map((p) => p.trade.id);
    sortTradePairs(pairs, { key: 'qty', dir: 'asc' });
    expect(pairs.map((p) => p.trade.id)).toEqual(before);
  });
});

describe('trade-sort — defaultDir', () => {
  it('leads numeric/date columns descending', () => {
    for (const k of ['date', 'qty', 'entry', 'exit', 'pnl'] as SortKey[]) {
      expect(defaultDir(k)).toBe('desc');
    }
  });

  it('leads text and grade columns ascending', () => {
    for (const k of ['symbol', 'side', 'tags', 'grade', 'ai'] as SortKey[]) {
      expect(defaultDir(k)).toBe('asc');
    }
  });
});
