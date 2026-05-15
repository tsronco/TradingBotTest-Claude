// dashboard/tests/components/FillHint.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FillHint from '../../src/components/order/FillHint';

describe('FillHint', () => {
  it('renders three tiers and fires onPick with the tier price', () => {
    const onPick = vi.fn();
    render(<FillHint side="sell" bid={2.30} ask={2.40} oi={500} onPick={onPick} />);
    expect(screen.getAllByText(/2\.35/).length).toBeGreaterThan(0);  // mid price shown
    fireEvent.click(screen.getByRole('button', { name: /balanced/i }));
    expect(onPick).toHaveBeenCalledWith(2.35);
  });
  it('shows a no-quote message when degraded', () => {
    render(<FillHint side="sell" bid={0} ask={0} onPick={vi.fn()} />);
    expect(screen.getByText(/no live quote/i)).toBeInTheDocument();
  });
});
