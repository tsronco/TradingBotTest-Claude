import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RuleCard from '../../src/components/rules/RuleCard';
import type { ManualRule } from '../../src/lib/rules-types';

const mkRule = (over: Partial<ManualRule> = {}): ManualRule => ({
  id: 'r-1',
  title: 'No earnings week',
  body: 'never trade through earnings',
  severity: 'block',
  triggers: [{ type: 'earnings_within_days', value: 7 }],
  source: 'manual',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  ...over,
});

describe('RuleCard', () => {
  it('shows title, body, and severity', () => {
    render(<RuleCard rule={mkRule()} />);
    expect(screen.getByText(/No earnings week/)).toBeTruthy();
    expect(screen.getByText(/never trade through earnings/)).toBeTruthy();
    expect(screen.getByText(/block/i)).toBeTruthy();
  });

  it('summarizes triggers', () => {
    render(<RuleCard rule={mkRule({ triggers: [
      { type: 'symbol_in', symbols: ['TSLA', 'F'] },
      { type: 'side', value: 'sell' },
    ] })} />);
    expect(screen.getByText(/symbol ∈ \{TSLA, F\}/)).toBeTruthy();
    expect(screen.getByText(/AND/)).toBeTruthy();
  });

  it('shows "from tendency" badge when source is tendency', () => {
    render(<RuleCard rule={mkRule({ source: 'tendency' })} />);
    expect(screen.getByText(/from tendency/i)).toBeTruthy();
  });

  it('calls onEdit and onDelete handlers', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<RuleCard rule={mkRule()} onEdit={onEdit} onDelete={onDelete} />);
    fireEvent.click(screen.getByText('[edit]'));
    fireEvent.click(screen.getByText('[delete]'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-1' }));
    expect(onDelete).toHaveBeenCalledWith('r-1');
  });

  it('hides edit/delete buttons when handlers not provided', () => {
    render(<RuleCard rule={mkRule()} />);
    expect(screen.queryByText('[edit]')).toBeNull();
    expect(screen.queryByText('[delete]')).toBeNull();
  });

  it('summarizes max_risk_per_spread trigger with dollar cap', () => {
    render(<RuleCard rule={mkRule({
      title: 'Max risk per spread',
      severity: 'warn',
      triggers: [{ type: 'max_risk_per_spread', max_dollars: 500 }],
    })} />);
    expect(screen.getByText(/Max risk per spread/)).toBeTruthy();
    expect(screen.getByText(/\$500/)).toBeTruthy();
  });
});
