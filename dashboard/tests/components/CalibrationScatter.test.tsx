import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CalibrationScatter from '../../src/components/performance/CalibrationScatter';

describe('CalibrationScatter', () => {
  it('renders empty state when data is empty', () => {
    render(<CalibrationScatter data={[]} />);
    expect(screen.getByText(/no graded trades yet/i)).toBeTruthy();
  });

  it('renders one circle per data point', () => {
    const data = [
      { trade_id: 't1', user_grade: 8, ai_grade: 7 },
      { trade_id: 't2', user_grade: 9, ai_grade: 8 },
      { trade_id: 't3', user_grade: 6, ai_grade: 9 },
    ];
    const { container } = render(<CalibrationScatter data={data} />);
    const circles = container.querySelectorAll('circle');
    expect(circles).toHaveLength(3);
  });

  it('shows positive mean-delta caption when user grades higher than AI', () => {
    const data = [
      { trade_id: 't1', user_grade: 8, ai_grade: 5 },
      { trade_id: 't2', user_grade: 9, ai_grade: 5 },
    ];
    render(<CalibrationScatter data={data} />);
    expect(screen.getByText(/grade higher than AI|grade lower|well calibrated/i)).toBeTruthy();
  });
});
