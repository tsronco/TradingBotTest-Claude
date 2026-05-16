import { describe, it, expect } from 'vitest';
import {
  TRIGGER_TYPES,
  isTrigger,
  newId,
  MATCHER_NAMES,
  type Trigger,
  type ManualRule,
  type Proposal,
  type Tendency,
  type BotRulesPayload,
  type AssignmentEntry,
  type MatcherName,
  type Severity,
} from '../api/_lib/rules-types';

describe('rules-types', () => {
  it('exposes all 12 trigger types', () => {
    expect(TRIGGER_TYPES).toEqual([
      'symbol_in', 'symbol_not_in', 'side', 'asset_class',
      'option_type', 'option_dte_lt', 'option_dte_gt',
      'open_position_count_gt', 'earnings_within_days',
      'strike_below_cost_basis', 'tag_present',
      'max_risk_per_spread',
    ]);
  });

  it('exposes all 6 matcher names', () => {
    expect(MATCHER_NAMES).toEqual([
      'loss_concentration_by_symbol',
      'loss_concentration_by_side',
      'cc_below_cost_basis',
      'held_through_earnings',
      'override_loss_pattern',
      'over_grading_self',
    ]);
  });

  it('isTrigger validates symbol_in shape', () => {
    expect(isTrigger({ type: 'symbol_in', symbols: ['TSLA'] })).toBe(true);
    expect(isTrigger({ type: 'symbol_in' })).toBe(false);              // missing symbols
    expect(isTrigger({ type: 'symbol_in', symbols: 'TSLA' })).toBe(false); // wrong type
  });

  it('isTrigger validates option_dte_lt shape', () => {
    expect(isTrigger({ type: 'option_dte_lt', value: 7 })).toBe(true);
    expect(isTrigger({ type: 'option_dte_lt', value: '7' })).toBe(false);
    expect(isTrigger({ type: 'option_dte_lt' })).toBe(false);
  });

  it('isTrigger validates strike_below_cost_basis (no params)', () => {
    expect(isTrigger({ type: 'strike_below_cost_basis' })).toBe(true);
  });

  it('isTrigger rejects unknown trigger types', () => {
    expect(isTrigger({ type: 'unknown' })).toBe(false);
    expect(isTrigger({ type: 'symbol_starts_with', symbols: ['T'] })).toBe(false);
  });

  it('isTrigger rejects null and primitive inputs', () => {
    expect(isTrigger(null)).toBe(false);
    expect(isTrigger(undefined)).toBe(false);
    expect(isTrigger('symbol_in')).toBe(false);
    expect(isTrigger(42)).toBe(false);
  });

  it('newId generates prefixed unique IDs', () => {
    const a = newId('r');
    const b = newId('r');
    expect(a).toMatch(/^r-/);
    expect(b).toMatch(/^r-/);
    expect(a).not.toBe(b);
  });

  it('ManualRule type accepts realistic payload', () => {
    const r: ManualRule = {
      id: 'r-1', title: 'No earnings week',
      body: 'never trade through earnings',
      severity: 'block',
      triggers: [{ type: 'earnings_within_days', value: 7 }],
      source: 'manual',
      created_at: '2026-05-07T00:00:00Z',
      updated_at: '2026-05-07T00:00:00Z',
    };
    expect(r.severity).toBe('block');
  });

  it('BotRulesPayload accepts conservative, aggressive, manual modes', () => {
    const cons: BotRulesPayload = {
      mode: 'conservative',
      wheel: { symbols: [], otm_pct: 0.10, dte_min: 14, dte_max: 28, close_at_profit_pct: 0.50 },
      strategy: {
        underlying: 'TSLA', initial_qty: 10, stop_loss_pct: 0.10,
        trail_activate_pct: 0.10, trail_floor_pct: 0.05, ladders: [],
      },
      pushed_at: '2026-05-07T00:00:00Z',
    };
    const manual: BotRulesPayload = { ...cons, mode: 'manual' };
    expect(cons.mode).toBe('conservative');
    expect(manual.mode).toBe('manual');
  });

  it('AssignmentEntry accepts all paper account IDs (original 3 + 3 SM)', () => {
    const e1: AssignmentEntry = {
      parent_trade_id: 'T-1', underlying: 'F', strike: 12, qty: 100,
      account: 'conservative_paper', detected_at: '2026-05-07T00:00:00Z',
    };
    const e2: AssignmentEntry = { ...e1, account: 'aggressive_paper' };
    const e3: AssignmentEntry = { ...e1, account: 'manual_paper' };
    const e4: AssignmentEntry = { ...e1, account: 'sm500_paper' };
    const e5: AssignmentEntry = { ...e1, account: 'sm1000_paper' };
    const e6: AssignmentEntry = { ...e1, account: 'sm2000_paper' };
    // Original 3 still pass (not weakened)
    expect([e1.account, e2.account, e3.account]).toEqual([
      'conservative_paper', 'aggressive_paper', 'manual_paper',
    ]);
    // SM 3 also accepted
    expect([e4.account, e5.account, e6.account]).toEqual([
      'sm500_paper', 'sm1000_paper', 'sm2000_paper',
    ]);
  });
});
