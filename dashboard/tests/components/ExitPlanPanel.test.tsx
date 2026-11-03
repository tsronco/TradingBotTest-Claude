import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExitPlanPanel } from '../../src/components/trade/ExitPlanPanel';

const stock = (over: any = {}): any => ({
  id: 'T-2026-09-23-001', account: 'live', asset_class: 'stock', symbol: 'CMG', side: 'buy', qty: 4,
  limit_price: 32.95, filled_avg_price: 32.86, closed_at: null, closed_avg_price: null, ...over,
});

describe('ExitPlanPanel', () => {
  it('shows your stop, target and the bot\'s stop', () => {
    render(<ExitPlanPanel trade={stock({ planned_stop: 29, planned_target: 40 })} />);
    expect(screen.getByText('$29.00')).toBeTruthy();
    expect(screen.getByText('$40.00')).toBeTruthy();
    expect(screen.getByText('$29.57')).toBeTruthy(); // 32.86 × 0.90
    expect(screen.queryByTestId('no-exit-plan')).toBeNull();
  });

  it('shows the actual exit once closed', () => {
    render(<ExitPlanPanel trade={stock({ planned_stop: 29, closed_at: '2026-10-19T13:33:32Z', closed_avg_price: 29.55 })} />);
    expect(screen.getByText('actual exit')).toBeTruthy();
    expect(screen.getByText('$29.55')).toBeTruthy();
  });

  it('says so when no plan was recorded (older trades)', () => {
    render(<ExitPlanPanel trade={stock()} />);
    expect(screen.getByTestId('no-exit-plan')).toBeTruthy();
    expect(screen.getByText('$29.57')).toBeTruthy();
  });

  it('renders nothing for options or a closing sale', () => {
    const { container: a } = render(<ExitPlanPanel trade={stock({ asset_class: 'option', side: 'STO' })} />);
    expect(a.innerHTML).toBe('');
    const { container: b } = render(<ExitPlanPanel trade={stock({ side: 'sell' })} />);
    expect(b.innerHTML).toBe('');
  });
});
