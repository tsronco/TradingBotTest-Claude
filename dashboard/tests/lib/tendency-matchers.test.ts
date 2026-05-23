import { describe, it, expect } from 'vitest';
import { runMatchers, type ClosedTradeView } from '../../api/_lib/tendency-matchers';

function mk(over: Partial<ClosedTradeView>): ClosedTradeView {
  return {
    id: 't', symbol: 'TSLA', account: 'manual_paper',
    asset_class: 'option', option_type: 'put',
    side: 'STO',
    submitted_at: '2026-03-25T14:00:00Z',
    filled_at: '2026-03-25T14:05:00Z',
    closed_at: '2026-04-01T20:00:00Z',
    closed_by: 'manual',
    realized_pnl: -100,
    user_grade: 'B', ai_grade: 'C', tags: [], rule_violations: [],
    strike: 200, expiration: '2026-04-15',
    dte_at_entry: 21,
    chased_during_open: false,
    cost_basis_at_entry: null,
    earnings_during_hold: false,
    ...over,
  };
}

describe('tendency matchers', () => {
  describe('loss_concentration_by_symbol', () => {
    it('fires for ≥3 losing trades on same symbol with <40% win rate and total P&L < 0', () => {
      const trades = [
        mk({ id: 't1', symbol: 'F', realized_pnl: -100 }),
        mk({ id: 't2', symbol: 'F', realized_pnl: -50 }),
        mk({ id: 't3', symbol: 'F', realized_pnl: -200 }),
      ];
      const findings = runMatchers(trades);
      const f = findings.find((x) => x.matcher === 'loss_concentration_by_symbol');
      expect(f).toBeDefined();
      expect(f!.evidence_trade_ids.sort()).toEqual(['t1', 't2', 't3']);
      expect(f!.actionable).toBe(true);
      expect(f!.suggested_triggers).toContainEqual({ type: 'symbol_in', symbols: ['F'] });
    });

    it('does NOT fire with only 2 losing trades', () => {
      const trades = [
        mk({ id: 't1', symbol: 'F', realized_pnl: -100 }),
        mk({ id: 't2', symbol: 'F', realized_pnl: -50 }),
      ];
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'loss_concentration_by_symbol')).toBeUndefined();
    });

    it('does NOT fire when win rate is high enough', () => {
      const trades = [
        mk({ id: 't1', symbol: 'F', realized_pnl: 100 }),
        mk({ id: 't2', symbol: 'F', realized_pnl: 50 }),
        mk({ id: 't3', symbol: 'F', realized_pnl: -10 }),
      ];
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'loss_concentration_by_symbol')).toBeUndefined();
    });
  });

  describe('loss_concentration_by_side', () => {
    it('fires for ≥5 trades of same (asset_class, option_type) with <40% win rate', () => {
      const trades = Array.from({ length: 6 }, (_, i) =>
        mk({ id: `t${i}`, symbol: `S${i}`, asset_class: 'option', option_type: 'put', realized_pnl: -50 }),
      );
      const findings = runMatchers(trades);
      const f = findings.find((x) => x.matcher === 'loss_concentration_by_side');
      expect(f).toBeDefined();
      expect(f!.suggested_triggers).toContainEqual({ type: 'asset_class', value: 'option' });
      expect(f!.suggested_triggers).toContainEqual({ type: 'option_type', value: 'put' });
    });
  });

  describe('cc_below_cost_basis', () => {
    it('fires for ≥2 covered calls below cost basis with ≥1 loss', () => {
      const trades = [
        mk({ id: 'cc1', option_type: 'call', side: 'STO', strike: 10, cost_basis_at_entry: 12, realized_pnl: -50 }),
        mk({ id: 'cc2', option_type: 'call', side: 'STO', strike: 11, cost_basis_at_entry: 13, realized_pnl: 25 }),
      ];
      const findings = runMatchers(trades);
      const f = findings.find((x) => x.matcher === 'cc_below_cost_basis');
      expect(f).toBeDefined();
      expect(f!.actionable).toBe(true);
      expect(f!.suggested_severity).toBe('block');
    });

    it('does NOT fire when no losses among the below-basis CCs', () => {
      const trades = [
        mk({ id: 'cc1', option_type: 'call', side: 'STO', strike: 10, cost_basis_at_entry: 12, realized_pnl: 25 }),
        mk({ id: 'cc2', option_type: 'call', side: 'STO', strike: 11, cost_basis_at_entry: 13, realized_pnl: 25 }),
      ];
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'cc_below_cost_basis')).toBeUndefined();
    });
  });

  describe('held_through_earnings', () => {
    it('fires for ≥2 trades held through earnings with ≥50% loss rate', () => {
      const trades = [
        mk({ id: 'e1', earnings_during_hold: true, realized_pnl: -100 }),
        mk({ id: 'e2', earnings_during_hold: true, realized_pnl: 50 }),
        mk({ id: 'e3', earnings_during_hold: true, realized_pnl: -75 }),
      ];
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'held_through_earnings')).toBeDefined();
    });
  });

  describe('override_loss_pattern', () => {
    it('fires per rule when overrides≥3 and loss_pct≥60%', () => {
      const trades = [
        mk({ id: 'o1', realized_pnl: -100, rule_violations: [{ rule: 'r-1', severity: 'block', override_reason: 'r1' }] }),
        mk({ id: 'o2', realized_pnl: -50,  rule_violations: [{ rule: 'r-1', severity: 'block', override_reason: 'r1' }] }),
        mk({ id: 'o3', realized_pnl: -25,  rule_violations: [{ rule: 'r-1', severity: 'block', override_reason: 'r1' }] }),
        mk({ id: 'o4', realized_pnl:  10,  rule_violations: [{ rule: 'r-1', severity: 'block', override_reason: 'r1' }] }),
      ];
      const findings = runMatchers(trades);
      const f = findings.find((x) => x.matcher === 'override_loss_pattern');
      expect(f).toBeDefined();
      expect(f!.key).toBe('override_loss_pattern:r-1');
    });

    it('does NOT fire for rules with fewer than 3 overrides', () => {
      const trades = [
        mk({ id: 'o1', realized_pnl: -100, rule_violations: [{ rule: 'r-2', severity: 'block', override_reason: 'r1' }] }),
        mk({ id: 'o2', realized_pnl: -50,  rule_violations: [{ rule: 'r-2', severity: 'block', override_reason: 'r1' }] }),
      ];
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'override_loss_pattern')).toBeUndefined();
    });
  });

  describe('over_grading_self', () => {
    it('fires when avg(user-ai) ≤ -1 letter step over ≥10 trades, with actionable=false', () => {
      // user='A' (idx=1), ai='C' (idx=7). delta = 1 - 7 = -6. Each trade contributes -6.
      // Average -6 across 12 trades = -6, which is ≤ -1.
      const trades: ClosedTradeView[] = [];
      for (let i = 0; i < 12; i++) {
        trades.push(mk({ id: `t${i}`, user_grade: 'A', ai_grade: 'C', realized_pnl: 0 }));
      }
      const findings = runMatchers(trades);
      const f = findings.find((x) => x.matcher === 'over_grading_self');
      expect(f).toBeDefined();
      expect(f!.actionable).toBe(false);   // informational only
    });

    it('does NOT fire with fewer than 10 graded trades', () => {
      const trades: ClosedTradeView[] = [];
      for (let i = 0; i < 8; i++) {
        trades.push(mk({ id: `t${i}`, user_grade: 'A', ai_grade: 'F' }));
      }
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'over_grading_self')).toBeUndefined();
    });

    it('skips trades without ai_grade', () => {
      const trades = Array.from({ length: 12 }, (_, i) => mk({
        id: `t${i}`, user_grade: 'A', ai_grade: null, realized_pnl: 0,
      }));
      const findings = runMatchers(trades);
      expect(findings.find((x) => x.matcher === 'over_grading_self')).toBeUndefined();
    });
  });

  describe('revenge_trade_pattern', () => {
    it('fires when ≥3 trades open within 60min of a loser, ≥50% lose', () => {
      const trades: ClosedTradeView[] = [
        mk({ id: 'L1', account: 'manual_paper', submitted_at: '2026-03-25T13:00:00Z', closed_at: '2026-03-25T14:00:00Z', realized_pnl: -100 }),
        mk({ id: 'R1', account: 'manual_paper', submitted_at: '2026-03-25T14:30:00Z', closed_at: '2026-03-26T15:00:00Z', realized_pnl: -50 }),
        mk({ id: 'L2', account: 'manual_paper', submitted_at: '2026-03-27T13:00:00Z', closed_at: '2026-03-27T14:00:00Z', realized_pnl: -75 }),
        mk({ id: 'R2', account: 'manual_paper', submitted_at: '2026-03-27T14:15:00Z', closed_at: '2026-03-28T15:00:00Z', realized_pnl: -25 }),
        mk({ id: 'L3', account: 'manual_paper', submitted_at: '2026-03-29T13:00:00Z', closed_at: '2026-03-29T14:00:00Z', realized_pnl: -30 }),
        mk({ id: 'R3', account: 'manual_paper', submitted_at: '2026-03-29T14:45:00Z', closed_at: '2026-03-30T15:00:00Z', realized_pnl: 20 }),
      ];
      const f = runMatchers(trades).find((x) => x.matcher === 'revenge_trade_pattern');
      expect(f).toBeDefined();
      expect(f!.suggested_triggers).toContainEqual({ type: 'recent_loss_within_minutes', minutes: 60 });
    });

    it('does NOT fire when gap exceeds 60 minutes', () => {
      const trades: ClosedTradeView[] = [
        mk({ id: 'L1', account: 'manual_paper', submitted_at: '2026-03-25T13:00:00Z', closed_at: '2026-03-25T14:00:00Z', realized_pnl: -100 }),
        mk({ id: 'R1', account: 'manual_paper', submitted_at: '2026-03-25T15:30:00Z', closed_at: '2026-03-26T15:00:00Z', realized_pnl: -50 }),
        mk({ id: 'L2', account: 'manual_paper', submitted_at: '2026-03-27T13:00:00Z', closed_at: '2026-03-27T14:00:00Z', realized_pnl: -75 }),
        mk({ id: 'R2', account: 'manual_paper', submitted_at: '2026-03-27T15:30:00Z', closed_at: '2026-03-28T15:00:00Z', realized_pnl: -25 }),
      ];
      expect(runMatchers(trades).find((x) => x.matcher === 'revenge_trade_pattern')).toBeUndefined();
    });
  });

  describe('loss_concentration_by_tag', () => {
    it('fires when ≥4 trades share a tag with <40% win rate and negative total', () => {
      const trades = Array.from({ length: 6 }, (_, i) => mk({
        id: `tag${i}`, symbol: `S${i}`, tags: ['earnings_play'],
        realized_pnl: i === 0 ? 20 : -80,
      }));
      const f = runMatchers(trades).find((x) => x.matcher === 'loss_concentration_by_tag');
      expect(f).toBeDefined();
      expect(f!.suggested_triggers).toContainEqual({ type: 'tag_in', tags: ['earnings_play'] });
    });

    it('does NOT fire with only 3 trades on a tag', () => {
      const trades = Array.from({ length: 3 }, (_, i) => mk({
        id: `tag${i}`, symbol: `S${i}`, tags: ['earnings_play'], realized_pnl: -50,
      }));
      expect(runMatchers(trades).find((x) => x.matcher === 'loss_concentration_by_tag')).toBeUndefined();
    });

    it('skips system tags like imported', () => {
      const trades = Array.from({ length: 6 }, (_, i) => mk({
        id: `tag${i}`, symbol: `S${i}`, tags: ['imported'], realized_pnl: -50,
      }));
      expect(runMatchers(trades).find((x) => x.matcher === 'loss_concentration_by_tag')).toBeUndefined();
    });
  });

  describe('dte_bucket_loss_pattern', () => {
    it('fires when ≥5 option trades in a DTE bucket have <40% win rate', () => {
      const trades = Array.from({ length: 7 }, (_, i) => mk({
        id: `d${i}`, symbol: `S${i}`, dte_at_entry: 3,
        realized_pnl: i === 0 ? 30 : -40,
      }));
      const f = runMatchers(trades).find((x) => x.matcher === 'dte_bucket_loss_pattern');
      expect(f).toBeDefined();
      expect(f!.suggested_triggers).toContainEqual({ type: 'dte_at_entry_between', min: 0, max: 7 });
    });

    it('does NOT fire with only 4 trades in a bucket', () => {
      const trades = Array.from({ length: 4 }, (_, i) => mk({
        id: `d${i}`, symbol: `S${i}`, dte_at_entry: 3, realized_pnl: -50,
      }));
      expect(runMatchers(trades).find((x) => x.matcher === 'dte_bucket_loss_pattern')).toBeUndefined();
    });

    it('skips stocks (no dte_at_entry)', () => {
      const trades = Array.from({ length: 7 }, (_, i) => mk({
        id: `s${i}`, symbol: `S${i}`, asset_class: 'stock', option_type: null,
        strike: null, expiration: null, dte_at_entry: null, realized_pnl: -50,
      }));
      expect(runMatchers(trades).find((x) => x.matcher === 'dte_bucket_loss_pattern')).toBeUndefined();
    });
  });

  describe('chase_modify_pattern', () => {
    it('fires when ≥3 chased trades lose money', () => {
      const trades = Array.from({ length: 3 }, (_, i) => mk({
        id: `c${i}`, chased_during_open: true, realized_pnl: -50,
      }));
      const f = runMatchers(trades).find((x) => x.matcher === 'chase_modify_pattern');
      expect(f).toBeDefined();
    });

    it('does NOT fire when chased_during_open=false (non-monotonic walk)', () => {
      const trades = Array.from({ length: 5 }, (_, i) => mk({
        id: `c${i}`, chased_during_open: false, realized_pnl: -50,
      }));
      expect(runMatchers(trades).find((x) => x.matcher === 'chase_modify_pattern')).toBeUndefined();
    });

    it('does NOT fire when chased but profitable', () => {
      const trades = Array.from({ length: 5 }, (_, i) => mk({
        id: `c${i}`, chased_during_open: true, realized_pnl: 50,
      }));
      expect(runMatchers(trades).find((x) => x.matcher === 'chase_modify_pattern')).toBeUndefined();
    });
  });

  describe('winner_cut_short', () => {
    it('fires when winners avg <40% held and losers avg >70% held over ≥10 options', () => {
      const trades: ClosedTradeView[] = [];
      // 5 winners filled 2026-03-01, expiration 2026-03-31 (30 days), closed at +3 days → 10% held
      for (let i = 0; i < 5; i++) {
        trades.push(mk({
          id: `w${i}`, symbol: `W${i}`,
          filled_at: '2026-03-01T14:00:00Z',
          closed_at: '2026-03-04T14:00:00Z',
          expiration: '2026-03-31',
          realized_pnl: 50,
        }));
      }
      // 5 losers held to ~25 days = ~83% of available time
      for (let i = 0; i < 5; i++) {
        trades.push(mk({
          id: `l${i}`, symbol: `L${i}`,
          filled_at: '2026-03-01T14:00:00Z',
          closed_at: '2026-03-26T14:00:00Z',
          expiration: '2026-03-31',
          realized_pnl: -50,
        }));
      }
      const f = runMatchers(trades).find((x) => x.matcher === 'winner_cut_short');
      expect(f).toBeDefined();
      expect(f!.actionable).toBe(false);
    });

    it('does NOT fire with fewer than 10 closed options', () => {
      const trades: ClosedTradeView[] = [];
      for (let i = 0; i < 4; i++) {
        trades.push(mk({
          id: `w${i}`, filled_at: '2026-03-01T14:00:00Z',
          closed_at: '2026-03-04T14:00:00Z', expiration: '2026-03-31',
          realized_pnl: 50,
        }));
      }
      for (let i = 0; i < 4; i++) {
        trades.push(mk({
          id: `l${i}`, filled_at: '2026-03-01T14:00:00Z',
          closed_at: '2026-03-26T14:00:00Z', expiration: '2026-03-31',
          realized_pnl: -50,
        }));
      }
      expect(runMatchers(trades).find((x) => x.matcher === 'winner_cut_short')).toBeUndefined();
    });

    it('excludes assigned and expired trades from the calculation', () => {
      const trades: ClosedTradeView[] = [];
      // 15 trades, but all assigned/expired — should be excluded
      for (let i = 0; i < 15; i++) {
        trades.push(mk({
          id: `x${i}`, filled_at: '2026-03-01T14:00:00Z',
          closed_at: i % 2 === 0 ? '2026-03-04T14:00:00Z' : '2026-03-26T14:00:00Z',
          expiration: '2026-03-31',
          closed_by: i % 2 === 0 ? 'assigned' : 'expired',
          realized_pnl: i % 2 === 0 ? 50 : -50,
        }));
      }
      expect(runMatchers(trades).find((x) => x.matcher === 'winner_cut_short')).toBeUndefined();
    });
  });

  it('runMatchers returns empty array on no trades', () => {
    expect(runMatchers([])).toEqual([]);
  });
});
