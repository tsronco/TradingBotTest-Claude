import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PnLBySymbolTable from '../../src/components/performance/PnLBySymbolTable';

const data = [
  { symbol: 'F', trades: 5, wins: 3, total_pnl: 100, avg_grade: 7.5 },
  { symbol: 'TSLA', trades: 3, wins: 1, total_pnl: -50, avg_grade: 6.2 },
  { symbol: 'NVDA', trades: 8, wins: 7, total_pnl: 500, avg_grade: 9.0 },
];

describe('PnLBySymbolTable', () => {
  it('shows empty state when no data', () => {
    render(<PnLBySymbolTable data={[]} />);
    expect(screen.getByText(/no closed trades/i)).toBeTruthy();
  });

  it('renders rows for each symbol', () => {
    render(<PnLBySymbolTable data={data} />);
    expect(screen.getByText('F')).toBeTruthy();
    expect(screen.getByText('TSLA')).toBeTruthy();
    expect(screen.getByText('NVDA')).toBeTruthy();
  });

  it('defaults to total_pnl descending', () => {
    const { container } = render(<PnLBySymbolTable data={data} />);
    const symbolCells = Array.from(container.querySelectorAll('tbody tr td:first-child')).map((c) => c.textContent);
    expect(symbolCells).toEqual(['NVDA', 'F', 'TSLA']);
  });

  it('clicking a header toggles sort direction', () => {
    const { container } = render(<PnLBySymbolTable data={data} />);
    const tradesHeader = screen.getByText(/trades/);
    fireEvent.click(tradesHeader);
    let symbolCells = Array.from(container.querySelectorAll('tbody tr td:first-child')).map((c) => c.textContent);
    expect(symbolCells).toEqual(['NVDA', 'F', 'TSLA']);
    fireEvent.click(tradesHeader);
    symbolCells = Array.from(container.querySelectorAll('tbody tr td:first-child')).map((c) => c.textContent);
    expect(symbolCells).toEqual(['TSLA', 'F', 'NVDA']);
  });
});
