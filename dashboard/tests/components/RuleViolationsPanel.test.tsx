import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RuleViolationsPanel } from '../../src/components/trade/RuleViolationsPanel';
import type { Trade, RuleWarning } from '../../src/lib/trade-types';

function mkTrade(over: Partial<Trade> = {}): Trade {
  return {
    id: 'T-2026-05-09-001',
    account: 'conservative_paper',
    asset_class: 'stock',
    symbol: 'F',
    side: 'buy',
    qty: 10,
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
    submitted_at: '2026-05-09T13:00:00Z',
    filled_at: null,
    filled_avg_price: null,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    tags: [],
    entry_grade: 'B',
    entry_reasoning: 'because',
    journal: '',
    exposure_at_submit: 0,
    rule_warnings_at_entry: [],
    schema: 1,
    ...over,
  };
}

describe('RuleViolationsPanel', () => {
  it('shows the empty state when trade has no rule warnings', () => {
    render(<RuleViolationsPanel trade={mkTrade()} />);
    expect(screen.getByText(/no rule violations for this trade/i)).toBeTruthy();
  });

  it('renders a block-severity violation with red styling and override reason', () => {
    const violations: RuleWarning[] = [
      {
        rule: 'r-test-1',
        severity: 'block',
        message: 'TEST: NO F',
        override_reason: 'IV crush already priced in',
      },
    ];
    render(<RuleViolationsPanel trade={mkTrade({ rule_warnings_at_entry: violations })} />);
    expect(screen.getByText('TEST: NO F')).toBeTruthy();
    expect(screen.getByText(/block/i)).toBeTruthy();
    expect(screen.getByText(/IV crush already priced in/)).toBeTruthy();
    // Confirm the empty-state message is NOT rendered when violations exist
    expect(screen.queryByText(/no rule violations/i)).toBeNull();
  });

  it('renders a warn-severity violation without override reason', () => {
    const violations: RuleWarning[] = [
      {
        rule: 'bot_wheel_overlap',
        severity: 'warn',
        message: 'bot has an open wheel on F in conservative.',
      },
    ];
    render(<RuleViolationsPanel trade={mkTrade({ rule_warnings_at_entry: violations })} />);
    expect(screen.getByText(/warn/i)).toBeTruthy();
    expect(screen.getByText(/bot has an open wheel/)).toBeTruthy();
    // Block-severity-only override-reason field shouldn't render
    expect(screen.queryByText(/↳ override:/)).toBeNull();
  });

  it('renders multiple violations sorted as the trade record provides them', () => {
    const violations: RuleWarning[] = [
      { rule: 'r-1', severity: 'block', message: 'No F', override_reason: 'reason text' },
      { rule: 'r-2', severity: 'warn', message: 'Wheel overlap' },
      { rule: 'r-3', severity: 'info', message: 'Sizing 1x' },
    ];
    render(<RuleViolationsPanel trade={mkTrade({ rule_warnings_at_entry: violations })} />);
    expect(screen.getByText('No F')).toBeTruthy();
    expect(screen.getByText('Wheel overlap')).toBeTruthy();
    expect(screen.getByText('Sizing 1x')).toBeTruthy();
  });

  it('shows the rule id in monospace next to each violation', () => {
    const violations: RuleWarning[] = [
      { rule: 'r-moyoo9r9-z0q9wp57', severity: 'block', message: 'TEST: NO F', override_reason: 'x' },
    ];
    render(<RuleViolationsPanel trade={mkTrade({ rule_warnings_at_entry: violations })} />);
    expect(screen.getByText('r-moyoo9r9-z0q9wp57')).toBeTruthy();
  });
});
