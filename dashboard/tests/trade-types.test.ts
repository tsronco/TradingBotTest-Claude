import { describe, it, expect } from 'vitest';
import type { Trade, RuleWarning } from '../api/_lib/trade-types';

describe('Trade type extensions (Phase 3)', () => {
  it('accepts parent_id, source, ai_grade_inherited as optional fields', () => {
    const t: Trade = {
      id: 'T-2026-05-07-001',
      account: 'manual_paper',
      asset_class: 'stock',
      symbol: 'F',
      side: 'buy',
      qty: 100,
      order_type: 'market',
      limit_price: null,
      stop_price: null,
      trail_pct: null,
      tif: 'day',
      contract_symbol: null,
      strike: null,
      expiration: null,
      contract_type: null,
      greeks_at_entry: null,
      alpaca_order_id: 'a-1',
      alpaca_close_order_id: null,
      submitted_at: '2026-05-07T13:00:00Z',
      filled_at: null,
      filled_avg_price: null,
      closed_at: null,
      closed_avg_price: null,
      realized_pnl: null,
      closed_by: null,
      tags: [],
      entry_grade: 'B',
      entry_reasoning: 'assigned from put',
      journal: '',
      exposure_at_submit: 0,
      rule_warnings_at_entry: [],
      schema: 1,
      parent_id: 'T-2026-05-01-002',
      source: 'assignment',
      ai_grade_inherited: true,
    };
    expect(t.parent_id).toBe('T-2026-05-01-002');
    expect(t.source).toBe('assignment');
    expect(t.ai_grade_inherited).toBe(true);
  });

  it('accepts block severity and override_reason on RuleWarning', () => {
    const w: RuleWarning = {
      rule: 'no_earnings_week',
      severity: 'block',
      message: 'TSLA earnings in 3 days',
      override_reason: 'IV crush already priced in based on last 4 cycles',
    };
    expect(w.severity).toBe('block');
    expect(w.override_reason).toBeDefined();
  });
});
