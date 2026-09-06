import { describe, it, expect } from 'vitest';
import { groupPositions, type RawPosition } from '../../src/lib/position-spreads';

// Minimal position factory — only the fields groupPositions reads.
function pos(over: Partial<RawPosition> & { symbol: string }): RawPosition {
  return {
    asset_class: 'us_option',
    qty: '1',
    avg_entry_price: '1',
    current_price: '1',
    market_value: '0',
    unrealized_pl: '0',
    unrealized_plpc: '0',
    ...over,
  };
}

// TSLA 352.5/365 call debit spread — the real agent position.
const TSLA_LONG = pos({
  symbol: 'TSLA260918C00352500', qty: '1', avg_entry_price: '12.00',
  current_price: '11.50', market_value: '1150', unrealized_pl: '-50',
});
const TSLA_SHORT = pos({
  symbol: 'TSLA260918C00365000', qty: '-1', avg_entry_price: '6.85',
  current_price: '6.55', market_value: '-655', unrealized_pl: '30',
});

describe('groupPositions — vertical spread detection', () => {
  it('pairs a call debit spread and computes builder numbers', () => {
    const groups = groupPositions([TSLA_LONG, TSLA_SHORT]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe('spread');
    if (g.kind !== 'spread') return;
    const m = g.metrics;
    expect(m.name).toBe('Bull Call Spread');
    expect(m.optionType).toBe('call');
    expect(m.isDebit).toBe(true);
    // net debit = (12.00 − 6.85) × 100 = 515
    expect(m.netCost).toBeCloseTo(515, 2);
    expect(m.maxLoss).toBeCloseTo(-515, 2);
    // max profit = (12.5 width − 5.15) × 100 = 735
    expect(m.maxProfit).toBeCloseTo(735, 2);
    // breakeven = long strike 352.5 + 5.15 net = 357.65
    expect(m.breakeven).toBeCloseTo(357.65, 2);
    expect(m.width).toBe(12.5);
    expect(m.contracts).toBe(1);
    expect(m.longStrike).toBe(352.5);
    expect(m.shortStrike).toBe(365);
    // live group P&L = −50 + 30 = −20
    expect(m.groupPL).toBeCloseTo(-20, 2);
    // max loss + max profit == full width value
    expect(Math.abs(m.maxLoss!) + m.maxProfit!).toBeCloseTo(1250, 2);
  });

  it('names and prices a put credit spread (net credit, correct risk)', () => {
    // Bull put: short 365P @6, long 352.5P @3 → credit 3, width 12.5
    const shortPut = pos({ symbol: 'TSLA260918P00365000', qty: '-1', avg_entry_price: '6.00' });
    const longPut = pos({ symbol: 'TSLA260918P00352500', qty: '1', avg_entry_price: '3.00' });
    const groups = groupPositions([shortPut, longPut]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe('spread');
    if (g.kind !== 'spread') return;
    const m = g.metrics;
    expect(m.name).toBe('Bull Put Spread');
    expect(m.isDebit).toBe(false);
    // net credit = (3 − 6) × 100 = −300
    expect(m.netCost).toBeCloseTo(-300, 2);
    // max profit = credit = 300; max loss = (12.5 − 3) × 100 = 950
    expect(m.maxProfit).toBeCloseTo(300, 2);
    expect(m.maxLoss).toBeCloseTo(-950, 2);
    // breakeven = short strike 365 − credit 3 = 362
    expect(m.breakeven).toBeCloseTo(362, 2);
  });

  it('scales metrics by paired contract count', () => {
    const long2 = pos({ ...TSLA_LONG, qty: '2', unrealized_pl: '-100' });
    const short2 = pos({ ...TSLA_SHORT, qty: '-2', unrealized_pl: '60' });
    const g = groupPositions([long2, short2])[0];
    expect(g.kind).toBe('spread');
    if (g.kind !== 'spread') return;
    expect(g.metrics.contracts).toBe(2);
    expect(g.metrics.netCost).toBeCloseTo(1030, 2);   // 515 × 2
    expect(g.metrics.maxLoss).toBeCloseTo(-1030, 2);
    expect(g.metrics.maxProfit).toBeCloseTo(1470, 2);  // 735 × 2
    expect(g.metrics.groupPL).toBeCloseTo(-40, 2);
  });

  it('leaves a lone long option as a single', () => {
    const groups = groupPositions([TSLA_LONG]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('single');
  });

  it('does not pair two long calls (no short leg)', () => {
    const l2 = pos({ symbol: 'TSLA260918C00360000', qty: '1', avg_entry_price: '9' });
    const groups = groupPositions([TSLA_LONG, l2]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === 'single')).toBe(true);
  });

  it('does not pair legs across different expirations', () => {
    const shortDiffExp = pos({ symbol: 'TSLA261016C00365000', qty: '-1', avg_entry_price: '7' });
    const groups = groupPositions([TSLA_LONG, shortDiffExp]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === 'single')).toBe(true);
  });

  it('does not pair legs of different option types (call vs put)', () => {
    const shortPut = pos({ symbol: 'TSLA260918P00340000', qty: '-1', avg_entry_price: '4' });
    const groups = groupPositions([TSLA_LONG, shortPut]);
    expect(groups.every((g) => g.kind === 'single')).toBe(true);
  });

  it('treats stock as a single and keeps a spread + stock together in order', () => {
    const stock = pos({ symbol: 'AAPL', asset_class: 'us_equity', qty: '10', avg_entry_price: '200' });
    const groups = groupPositions([stock, TSLA_LONG, TSLA_SHORT]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'single' });
    expect(groups[1].kind).toBe('spread');
  });

  it('picks the narrowest-width short when several are available', () => {
    // Long 352.5C; shorts at 365 (12.5 wide) and 357.5 (5 wide) → 357.5 wins.
    const near = pos({ symbol: 'TSLA260918C00357500', qty: '-1', avg_entry_price: '9' });
    const far = pos({ symbol: 'TSLA260918C00365000', qty: '-1', avg_entry_price: '6.85' });
    const groups = groupPositions([TSLA_LONG, near, far]);
    const spread = groups.find((g) => g.kind === 'spread');
    expect(spread?.kind).toBe('spread');
    if (spread?.kind !== 'spread') return;
    expect(spread.metrics.shortStrike).toBe(357.5);
    expect(spread.metrics.width).toBe(5);
    // the wider short falls through to a single
    expect(groups.some((g) => g.kind === 'single' && g.pos.symbol === far.symbol)).toBe(true);
  });
});
