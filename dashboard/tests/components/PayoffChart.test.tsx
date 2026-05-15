// dashboard/tests/components/PayoffChart.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PayoffChart from '../../src/components/order/PayoffChart';
import type { Leg } from '../../src/lib/payoff';

const csp: Leg[] = [{ kind: 'option', dir: 'short', type: 'put', strike: 100, premium: 2, contracts: 1 }];

describe('PayoffChart', () => {
  it('renders the stat strip from buildPayoff', () => {
    render(<PayoffChart legs={csp} currentPrice={101} />);
    expect(screen.getByText(/max profit/i)).toBeInTheDocument();
    expect(screen.getByText(/break-?even/i)).toBeInTheDocument();
    expect(screen.getByText(/max loss/i)).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument(); // max profit
  });
  it('exposes an accessible slider with a P/L readout that updates on keyboard', () => {
    render(<PayoffChart legs={csp} currentPrice={101} />);
    const slider = screen.getByRole('slider', { name: /p\/l at underlying/i });
    expect(slider).toBeInTheDocument();
    const before = screen.getByTestId('payoff-readout').textContent;
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(screen.getByTestId('payoff-readout').textContent).not.toBe(before);
  });
});
