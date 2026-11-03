import { describe, it, expect } from 'vitest';
import { groupPositions, summarizeCollateral, type RawPosition } from '../../src/lib/position-spreads';

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

// BAC 48/49 bull put spread on the live account, 2026-11-03 pre-market:
// the short leg marked $3.25 (last-session/one-sided) on a $1-wide spread.
const BAC_LONG = pos({
  symbol: 'BAC261120P00048000', qty: '1', avg_entry_price: '0.48',
  current_price: '0.15', market_value: '15', unrealized_pl: '-33',
});
const BAC_SHORT = pos({
  symbol: 'BAC261120P00049000', qty: '-1', avg_entry_price: '0.71',
  current_price: '3.25', market_value: '-325', unrealized_pl: '-254',
});

describe('spread collateral, clamped value, stale quote', () => {
  it('BAC: collateral is width × 100, value clamps to width, P/L flagged stale', () => {
    const [g] = groupPositions([BAC_LONG, BAC_SHORT]);
    if (g.kind !== 'spread') throw new Error('expected spread');
    const m = g.metrics;
    expect(m.collateral).toBeCloseTo(100, 6);
    expect(m.rawMarkValue).toBeCloseTo(3.10, 6);
    expect(m.markValue).toBe(1);
    expect(m.markClamped).toBe(true);
    expect(m.maxLoss).toBeCloseTo(-77, 6);
    expect(m.groupPL).toBe(-287);
    expect(m.staleQuote).toBe(true);
  });

  it('a sane credit spread is neither clamped nor stale', () => {
    const [g] = groupPositions([
      { ...BAC_LONG, current_price: '0.30', unrealized_pl: '-18' },
      { ...BAC_SHORT, current_price: '0.60', unrealized_pl: '11' },
    ]);
    if (g.kind !== 'spread') throw new Error('expected spread');
    expect(g.metrics.markValue).toBeCloseTo(0.30, 6);
    expect(g.metrics.markClamped).toBe(false);
    expect(g.metrics.staleQuote).toBe(false);
  });

  it('clamps a negative value to 0 and flags P/L above max profit', () => {
    const [g] = groupPositions([
      { ...BAC_LONG, current_price: '0.50', unrealized_pl: '2' },
      { ...BAC_SHORT, current_price: '0.05', unrealized_pl: '66' },
    ]);
    if (g.kind !== 'spread') throw new Error('expected spread');
    expect(g.metrics.markValue).toBe(0);
    expect(g.metrics.markClamped).toBe(true);
    // max profit is $23; $68 is impossible
    expect(g.metrics.staleQuote).toBe(true);
  });

  it('debit spread value = long − short, clamped', () => {
    const [g] = groupPositions([TSLA_LONG, TSLA_SHORT]);
    if (g.kind !== 'spread') throw new Error('expected spread');
    expect(g.metrics.markValue).toBeCloseTo(4.95, 6);
    expect(g.metrics.collateral).toBeCloseTo(1250, 6);
    expect(g.metrics.staleQuote).toBe(false);
  });

  it('does not judge staleness when leg counts differ', () => {
    const [g] = groupPositions([BAC_LONG, { ...BAC_SHORT, qty: '-2', unrealized_pl: '-508' }]);
    if (g.kind !== 'spread') throw new Error('expected spread');
    expect(g.metrics.staleQuote).toBe(false);
  });
});

describe('summarizeCollateral', () => {
  it('a spread short put is NOT counted as a CSP', () => {
    const c = summarizeCollateral(groupPositions([BAC_LONG, BAC_SHORT]));
    expect(c).toEqual({ cspCount: 0, cspCollateral: 0, spreadCount: 1, spreadCollateral: 100 });
  });

  it('a lone short put is a CSP at strike × 100 × qty', () => {
    const c = summarizeCollateral(groupPositions([{ ...BAC_SHORT, qty: '-2' }]));
    expect(c.cspCount).toBe(1);
    expect(c.cspCollateral).toBeCloseTo(9800, 6);
    expect(c.spreadCount).toBe(0);
  });

  it('short contracts beyond the paired count are CSPs', () => {
    const c = summarizeCollateral(groupPositions([BAC_LONG, { ...BAC_SHORT, qty: '-3' }]));
    expect(c.spreadCollateral).toBeCloseTo(100, 6);
    expect(c.cspCount).toBe(1);
    expect(c.cspCollateral).toBeCloseTo(49 * 100 * 2, 6);
  });

  it('short calls and stocks contribute nothing', () => {
    const c = summarizeCollateral(groupPositions([
      TSLA_SHORT,
      pos({ symbol: 'BAC', asset_class: 'us_equity', qty: '100' }),
    ]));
    expect(c).toEqual({ cspCount: 0, cspCollateral: 0, spreadCount: 0, spreadCollateral: 0 });
  });
});
