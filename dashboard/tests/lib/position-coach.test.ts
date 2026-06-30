import { describe, expect, it } from 'vitest';
import {
  buildPositionFacts,
  buildCoachPrompt,
  deterministicReadout,
  coachSignature,
  SYSTEM_PROMPT,
  type RawPosition,
  type RawStrategySym,
} from '../../api/_lib/position-coach';

const POS: RawPosition = {
  symbol: 'SNAP',
  qty: '5',
  avg_entry_price: '4.53',
  current_price: '4.42',
  unrealized_pl: '-0.55',
  unrealized_plpc: '-0.0243',
  asset_class: 'us_equity',
  side: 'long',
};

const STRAT: RawStrategySym = {
  stop_price: 4.08,
  high_water_mark: 4.53,
  trailing_active: false,
  ladder_done: [false, false, false],
  initial_qty: 5,
};

describe('buildPositionFacts', () => {
  it('computes position + bot-plan facts from raw inputs', () => {
    const f = buildPositionFacts('SNAP', 'live', POS, STRAT, null, []);
    expect(f.symbol).toBe('SNAP');
    expect(f.mode).toBe('live');
    expect(f.is_live).toBe(true);
    expect(f.asset_class).toBe('stock');
    expect(f.side).toBe('long');
    expect(f.qty).toBe(5);
    expect(f.avg_cost).toBe(4.53);
    expect(f.current_price).toBe(4.42);
    expect(f.unrealized_pl).toBeCloseTo(-0.55);
    expect(f.unrealized_pl_pct).toBeCloseTo(-2.43);
    expect(f.stop_price).toBe(4.08);
    expect(f.trailing_active).toBe(false);
    expect(f.ladder_rungs_total).toBe(3);
    expect(f.ladder_rungs_remaining).toBe(3);
    expect(f.wheel_stage).toBeNull();
    expect(f.is_excluded).toBe(false);
  });

  it('counts only the unfilled ladder rungs as remaining', () => {
    const f = buildPositionFacts('SNAP', 'live', POS, { ...STRAT, ladder_done: [true, false, false] }, null, []);
    expect(f.ladder_rungs_remaining).toBe(2);
    expect(f.ladder_rungs_total).toBe(3);
  });

  it('degrades to position-only facts when the bot has no state yet', () => {
    const f = buildPositionFacts('SNAP', 'manual', POS, null, null, []);
    expect(f.stop_price).toBeNull();
    expect(f.trailing_active).toBeNull();
    expect(f.ladder_rungs_total).toBeNull();
    expect(f.ladder_rungs_remaining).toBeNull();
    expect(f.is_live).toBe(false);
  });

  it('flags excluded symbols', () => {
    const f = buildPositionFacts('SNAP', 'manual', POS, STRAT, null, ['SNAP']);
    expect(f.is_excluded).toBe(true);
  });

  it('reads the wheel stage for option/wheel positions', () => {
    const optPos: RawPosition = { ...POS, asset_class: 'us_option' };
    const f = buildPositionFacts('SNAP', 'manual', optPos, null, { stage: 2 }, []);
    expect(f.asset_class).toBe('option');
    expect(f.wheel_stage).toBe(2);
  });

  it('handles a short side and missing P/L gracefully', () => {
    const f = buildPositionFacts('SNAP', 'manual', { symbol: 'SNAP', qty: '-1', avg_entry_price: '4.5', side: 'short' }, null, null, []);
    expect(f.side).toBe('short');
    expect(f.unrealized_pl).toBeNull();
    expect(f.unrealized_pl_pct).toBeNull();
  });
});

describe('SYSTEM_PROMPT', () => {
  it('hard-forbids advice and predictions', () => {
    expect(SYSTEM_PROMPT).toContain('NOT a financial advisor');
    expect(SYSTEM_PROMPT).toMatch(/NEVER tell the user to buy, sell, hold/);
    expect(SYSTEM_PROMPT).toMatch(/NEVER give a price target/);
    expect(SYSTEM_PROMPT).toContain('at most 4 sentences');
  });
});

describe('buildCoachPrompt', () => {
  const f = buildPositionFacts('SNAP', 'live', POS, STRAT, null, []);

  it('includes the real numbers and the real-money flag', () => {
    const p = buildCoachPrompt(f);
    expect(p).toContain('Symbol: SNAP');
    expect(p).toContain('REAL MONEY');
    expect(p).toContain('Average cost: $4.53');
    expect(p).toContain('Current price: $4.42');
    expect(p).toContain('Stop price: $4.08');
    expect(p).toContain('Ladder add-on buys remaining: 3 of 3');
  });

  it('notes when the bot has no plan recorded yet', () => {
    const p = buildCoachPrompt(buildPositionFacts('SNAP', 'manual', POS, null, null, []));
    expect(p).toContain('no plan recorded for this symbol yet');
  });

  it('notes the exclusion when the symbol is excluded', () => {
    const p = buildCoachPrompt(buildPositionFacts('SNAP', 'manual', POS, STRAT, null, ['SNAP']));
    expect(p).toContain('exclusion list');
  });
});

describe('deterministicReadout', () => {
  it('renders coherent, advice-free text with bot state', () => {
    const f = buildPositionFacts('SNAP', 'live', POS, STRAT, null, []);
    const t = deterministicReadout(f);
    expect(t).toContain('You hold 5 shares of SNAP');
    expect(t).toContain('average cost of $4.53');
    expect(t).toContain("stop is set at $4.08");
    expect(t).not.toMatch(/you should|recommend|good entry|i'?d (buy|sell)/i);
  });

  it('renders without bot state', () => {
    const f = buildPositionFacts('SNAP', 'manual', POS, null, null, []);
    const t = deterministicReadout(f);
    expect(t).toContain('You hold 5 shares of SNAP');
    expect(t).toContain("hasn't recorded a stop");
  });

  it('singularizes a one-share position', () => {
    const f = buildPositionFacts('SNAP', 'manual', { ...POS, qty: '1' }, null, null, []);
    expect(deterministicReadout(f)).toContain('You hold 1 share of SNAP');
  });
});

describe('coachSignature', () => {
  it('is stable across sub-dime price ticks but changes on a real move', () => {
    const base = buildPositionFacts('SNAP', 'live', POS, STRAT, null, []);
    const tick = buildPositionFacts('SNAP', 'live', { ...POS, current_price: '4.44' }, STRAT, null, []);
    const moved = buildPositionFacts('SNAP', 'live', { ...POS, current_price: '4.70' }, STRAT, null, []);
    expect(coachSignature(base)).toBe(coachSignature(tick)); // 4.42 and 4.44 both round to 4.4
    expect(coachSignature(base)).not.toBe(coachSignature(moved));
  });

  it('changes when the bot stop moves', () => {
    const base = buildPositionFacts('SNAP', 'live', POS, STRAT, null, []);
    const restopped = buildPositionFacts('SNAP', 'live', POS, { ...STRAT, stop_price: 4.20 }, null, []);
    expect(coachSignature(base)).not.toBe(coachSignature(restopped));
  });
});
