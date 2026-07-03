import { describe, expect, it } from 'vitest';
import {
  buildPositionFacts,
  buildCoachPrompt,
  deterministicReadout,
  coachSignature,
  computeTrailingCoach,
  TRAIL_TRIGGER_PCT,
  TRAIL_DISTANCE_PCT,
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
    expect(SYSTEM_PROMPT).toContain('at most 6 sentences');
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

describe('computeTrailingCoach', () => {
  const base = {
    asset_class: 'stock' as const,
    avg_cost: 4.53,
    entry_price: 4.53,
    qty: 5,
  };

  it('exposes the bot constants as fractions', () => {
    expect(TRAIL_TRIGGER_PCT).toBe(0.10);
    expect(TRAIL_DISTANCE_PCT).toBe(0.05);
  });

  it('OFF: reports the activation price and the gap from CURRENT price', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: false, stop_price: 4.08, high_water_mark: 4.53, current_price: 4.42 })!;
    expect(tc.state).toBe('off');
    expect(tc.activation_price).toBe(4.98); // 4.53 * 1.10 = 4.983 -> 4.98
    expect(tc.activation_gap_abs).toBe(0.56); // 4.98 - 4.42, from CURRENT not HWM
    expect(tc.activation_gap_pct).toBeCloseTo(12.67, 1);
    expect(tc.trigger_price).toBeNull();
    expect(tc.trail_distance_pct).toBe(0.05);
  });

  it('OFF: uses entry_price (not avg_cost) for the activation price after a ladder', () => {
    // entry stayed at 4.53 but avg_cost blended up to 5.00 after a ladder buy
    const tc = computeTrailingCoach({ ...base, avg_cost: 5.00, entry_price: 4.53, trailing_active: false, stop_price: 4.50, high_water_mark: 4.53, current_price: 4.42 })!;
    expect(tc.activation_price).toBe(4.98); // keyed off entry 4.53, not avg 5.00
  });

  it('OFF: falls back to avg_cost when entry_price is missing', () => {
    const tc = computeTrailingCoach({ ...base, entry_price: null, trailing_active: false, stop_price: 4.08, high_water_mark: 4.53, current_price: 4.42 })!;
    expect(tc.activation_price).toBe(4.98); // avg_cost 4.53 * 1.10
  });

  it('ON: reports the trigger, the locked-in gain per-share + total, and the next-raise price', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: true, stop_price: 4.94, high_water_mark: 5.20, current_price: 5.00 })!;
    expect(tc.state).toBe('on');
    expect(tc.trigger_price).toBe(4.94);
    expect(tc.locked_kind).toBe('gain');
    expect(tc.locked_per_share).toBe(0.41); // 4.94 - 4.53
    expect(tc.locked_total).toBe(2.05);     // 0.41 * 5
    expect(tc.next_raise_above).toBe(5.20);
    expect(tc.activation_price).toBeNull();
  });

  it('ON: flips to a worst-case LOSS when the trigger sits below avg cost', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: true, stop_price: 4.40, high_water_mark: 4.75, current_price: 4.60 })!;
    expect(tc.state).toBe('on');
    expect(tc.locked_kind).toBe('loss');
    expect(tc.locked_per_share).toBe(0.13); // |4.40 - 4.53|
    expect(tc.locked_total).toBe(0.65);     // 0.13 * 5
  });

  it('SANITY GUARD: trigger at/above current price => "triggering", no locked-in figure', () => {
    const tc = computeTrailingCoach({ ...base, trailing_active: true, stop_price: 4.94, high_water_mark: 5.20, current_price: 4.90 })!;
    expect(tc.state).toBe('triggering');
    expect(tc.trigger_price).toBe(4.94);
    expect(tc.locked_kind).toBeNull();
    expect(tc.locked_per_share).toBeNull();
    expect(tc.next_raise_above).toBeNull();
  });

  it('returns null for non-stock instruments', () => {
    expect(computeTrailingCoach({ ...base, asset_class: 'option', trailing_active: false, stop_price: 4.08, high_water_mark: 4.53, current_price: 4.42 })).toBeNull();
  });

  it('returns null when the bot has no trailing state or stop recorded', () => {
    expect(computeTrailingCoach({ ...base, asset_class: 'stock', trailing_active: null, stop_price: null, high_water_mark: null, current_price: 4.42 })).toBeNull();
  });

  it('returns null when the trail flag is set but no stop is recorded yet (transient)', () => {
    expect(computeTrailingCoach({ ...base, trailing_active: true, stop_price: null, high_water_mark: 5.0, current_price: 4.5 })).toBeNull();
  });
});

describe('buildPositionFacts trailing_coach wiring', () => {
  const POS_OFF: RawPosition = { symbol: 'SNAP', qty: '5', avg_entry_price: '4.53', current_price: '4.42', asset_class: 'us_equity', side: 'long' };
  it('attaches a computed trailing_coach when the bot manages the stock', () => {
    const strat: RawStrategySym = { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53, ladder_done: [false, false, false], initial_qty: 5 };
    const f = buildPositionFacts('SNAP', 'live', POS_OFF, strat, null, []);
    expect(f.trailing_coach?.state).toBe('off');
    expect(f.trailing_coach?.activation_price).toBe(4.98);
  });
  it('leaves trailing_coach null when there is no bot state', () => {
    const f = buildPositionFacts('SNAP', 'manual', POS_OFF, null, null, []);
    expect(f.trailing_coach).toBeNull();
  });
});

describe('trailing-stop rendering', () => {
  const P = (over: Partial<RawPosition> = {}): RawPosition => ({ symbol: 'SNAP', qty: '5', avg_entry_price: '4.53', current_price: '4.42', asset_class: 'us_equity', side: 'long', ...over });

  it('prompt (OFF): hands the LLM the activation price and gap from current', () => {
    const f = buildPositionFacts('SNAP', 'live', P(), { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53 }, null, []);
    const p = buildCoachPrompt(f);
    expect(p).toContain('Trailing stop: OFF');
    expect(p).toContain('$4.98'); // activation price
    expect(p).toContain('$0.56'); // gap above current
  });

  it('prompt (ON): hands the LLM the trigger, locked-in floor, and next-raise price', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '5.00' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const p = buildCoachPrompt(f);
    expect(p).toContain('Trailing stop: ON');
    expect(p).toContain('$4.94');            // trigger
    expect(p).toContain('$0.41');            // per-share locked in
    expect(p).toContain('$2.05');            // total across 5 shares
    expect(p).toContain('$5.20');            // next-raise (HWM)
  });

  it('prompt (triggering): tells the LLM the bot will sell next cycle', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '4.90' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const p = buildCoachPrompt(f);
    expect(p).toMatch(/sells? on its next cycle/i);
    expect(p).toContain('$4.94');
  });

  it('readout (OFF): states off + activation price + distance from current', () => {
    const f = buildPositionFacts('SNAP', 'live', P(), { stop_price: 4.08, high_water_mark: 4.53, trailing_active: false, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toMatch(/trailing stop is off/i);
    expect(t).toContain('$4.98');
    expect(t).toContain('$0.56');
  });

  it('readout (ON gain): trigger + locked-in per-share and total + next-raise', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '5.00' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toContain('$4.94');
    expect(t).toContain('$0.41');
    expect(t).toContain('$2.05');
    expect(t).toContain('$5.20');
    expect(t).toMatch(/locks in|locked in|at least/i);
  });

  it('readout (ON loss): frames a worst-case loss, not a negative gain', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '4.60' }), { stop_price: 4.40, high_water_mark: 4.75, trailing_active: true, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toMatch(/loss/i);
    expect(t).not.toMatch(/-\$/); // never print a negative dollar amount
    expect(t).toContain('$0.13');
  });

  it('readout (triggering): sell-next-cycle language, no locked-in figure', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '4.90' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    const t = deterministicReadout(f);
    expect(t).toMatch(/sells? on its next cycle/i);
  });

  it('readout stays advice-free with the new trailing detail', () => {
    const f = buildPositionFacts('SNAP', 'live', P({ current_price: '5.00' }), { stop_price: 4.94, high_water_mark: 5.20, trailing_active: true, entry_price: 4.53 }, null, []);
    expect(deterministicReadout(f)).not.toMatch(/you should|recommend|good entry|consider|i'?d (buy|sell)/i);
  });

  it('prompt: falls back to a plain ON label when the trail flag is set but no stop yet', () => {
    const f = buildPositionFacts('SNAP', 'live', P(), { trailing_active: true, stop_price: null, high_water_mark: 5.0 }, null, []);
    expect(f.trailing_coach).toBeNull();
    expect(buildCoachPrompt(f)).toContain('Trailing stop: ON');
  });
});
