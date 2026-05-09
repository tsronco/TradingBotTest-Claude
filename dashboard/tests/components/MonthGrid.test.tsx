import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MonthGrid from '../../src/components/calendar/MonthGrid';

const days = {
  '2026-04-15': {
    realized_pnl: 100,
    trade_count: 2,
    closed_trade_ids: ['t1', 't2'],
    open_options_expiring: [],
  },
  '2026-04-22': {
    realized_pnl: -50,
    trade_count: 1,
    closed_trade_ids: ['t3'],
    open_options_expiring: [{ trade_id: 't4', symbol: 'TSLA', option_type: 'put' as const, strike: 200 }],
  },
};

describe('MonthGrid', () => {
  it('renders day-of-week headers', () => {
    render(<MonthGrid year={2026} month={4} days={days} monthTotal={50} onDayClick={() => {}} />);
    expect(screen.getByText(/Sun/)).toBeTruthy();
    expect(screen.getByText(/Sat/)).toBeTruthy();
  });

  it('renders the month total with sign + color', () => {
    render(<MonthGrid year={2026} month={4} days={days} monthTotal={50} onDayClick={() => {}} />);
    expect(screen.getByText(/\+\$50\.00/)).toBeTruthy();
  });

  it('renders P&L on the day with formatted dollar value', () => {
    render(<MonthGrid year={2026} month={4} days={days} monthTotal={50} onDayClick={() => {}} />);
    expect(screen.getByText(/\+\$100/)).toBeTruthy();
    expect(screen.getByText(/-\$50/)).toBeTruthy();
  });

  it('shows expiration badge "○ N" on days with open options expiring', () => {
    render(<MonthGrid year={2026} month={4} days={days} monthTotal={50} onDayClick={() => {}} />);
    expect(screen.getByText(/○ 1/)).toBeTruthy();
  });

  it('calls onDayClick with the date when a day cell is clicked', () => {
    const onDayClick = vi.fn();
    render(<MonthGrid year={2026} month={4} days={days} monthTotal={50} onDayClick={onDayClick} />);
    const cell = screen.getByTitle(/2 trades/);
    fireEvent.click(cell);
    expect(onDayClick).toHaveBeenCalledWith('2026-04-15');
  });
});
