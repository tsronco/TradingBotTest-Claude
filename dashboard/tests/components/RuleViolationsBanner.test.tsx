import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RuleViolationsBanner from '../../src/components/order/RuleViolationsBanner';

describe('RuleViolationsBanner', () => {
  it('renders nothing when violations array is empty', () => {
    const { container } = render(<RuleViolationsBanner violations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an OK message when violations array is empty AND showOkWhenEmpty is true', () => {
    render(<RuleViolationsBanner violations={[]} showOkWhenEmpty />);
    expect(screen.getByText(/no warnings/i)).toBeTruthy();
  });

  it('renders block-severity violations with red styling', () => {
    render(<RuleViolationsBanner violations={[
      { rule: 'r-1', severity: 'block', message: 'No earnings week' },
    ]} />);
    const text = screen.getByText(/No earnings week/);
    expect(text).toBeTruthy();
    expect(screen.getByText(/block/i)).toBeTruthy();
  });

  it('renders warn-severity violations with amber styling', () => {
    render(<RuleViolationsBanner violations={[
      { rule: 'r-2', severity: 'warn', message: 'Symbol outside wheel' },
    ]} />);
    expect(screen.getByText(/Symbol outside wheel/)).toBeTruthy();
    expect(screen.getByText(/warn/i)).toBeTruthy();
  });

  it('renders info-severity violations', () => {
    render(<RuleViolationsBanner violations={[
      { rule: 'sizing_1x', severity: 'info', message: 'order is 2× normal size' },
    ]} />);
    expect(screen.getByText(/order is 2× normal size/)).toBeTruthy();
  });

  it('lists multiple violations', () => {
    render(<RuleViolationsBanner violations={[
      { rule: 'r-1', severity: 'block', message: 'foo' },
      { rule: 'r-2', severity: 'warn', message: 'bar' },
    ]} />);
    expect(screen.getByText(/foo/)).toBeTruthy();
    expect(screen.getByText(/bar/)).toBeTruthy();
  });
});
