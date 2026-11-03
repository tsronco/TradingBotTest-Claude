import { describe, it, expect } from 'vitest';
import { botStopFor, exitPlanProblems, BOT_STOP_PCT } from '../../src/lib/exit-plan';

describe('botStopFor', () => {
  it('is 10% below entry, rounded to cents (CMG: 32.86 → 29.57, the bot\'s actual stop)', () => {
    expect(BOT_STOP_PCT).toBe(0.10);
    expect(botStopFor(32.86)).toBe(29.57);
  });
  it('null for a missing or bad entry', () => {
    expect(botStopFor(0)).toBeNull();
    expect(botStopFor(NaN)).toBeNull();
  });
});

describe('exitPlanProblems', () => {
  it('nothing typed is fine', () => {
    expect(exitPlanProblems('buy', null, null)).toEqual([]);
    expect(exitPlanProblems('buy', undefined, undefined)).toEqual([]);
  });
  it('either field alone is fine', () => {
    expect(exitPlanProblems('buy', 29, null)).toEqual([]);
    expect(exitPlanProblems('buy', null, 40)).toEqual([]);
  });
  it('buy: stop must be below target', () => {
    expect(exitPlanProblems('buy', 29, 40)).toEqual([]);
    expect(exitPlanProblems('buy', 40, 29)).toEqual(['planned_stop_must_be_below_target']);
  });
  it('sell_short: stop must be above target', () => {
    expect(exitPlanProblems('sell_short', 40, 29)).toEqual([]);
    expect(exitPlanProblems('sell_short', 29, 40)).toEqual(['planned_stop_must_be_above_target']);
  });
  it('flags non-positive or non-numeric values', () => {
    expect(exitPlanProblems('buy', 0, null)).toEqual(['planned_stop_invalid']);
    expect(exitPlanProblems('buy', null, -5)).toEqual(['planned_target_invalid']);
  });
});
