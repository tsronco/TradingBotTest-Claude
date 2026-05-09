import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TriggerBuilder from '../../src/components/rules/TriggerBuilder';
import type { Trigger } from '../../src/lib/rules-types';

describe('TriggerBuilder', () => {
  it('renders empty state with [+ add trigger]', () => {
    render(<TriggerBuilder triggers={[]} onChange={() => {}} />);
    expect(screen.getByText(/add trigger/i)).toBeTruthy();
    expect(screen.queryByText(/all triggers must match/i)).toBeNull();
  });

  it('clicking + adds a default symbol_in trigger', () => {
    const onChange = vi.fn();
    render(<TriggerBuilder triggers={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText(/add trigger/i));
    expect(onChange).toHaveBeenCalledWith([{ type: 'symbol_in', symbols: [] }]);
  });

  it('renders symbol_in input with comma-separated symbols', () => {
    const triggers: Trigger[] = [{ type: 'symbol_in', symbols: ['TSLA', 'F'] }];
    render(<TriggerBuilder triggers={triggers} onChange={() => {}} />);
    const input = screen.getByLabelText('symbols') as HTMLInputElement;
    expect(input.value).toBe('TSLA, F');
  });

  it('typing into symbol_in splits + uppercases on change', () => {
    const onChange = vi.fn();
    const triggers: Trigger[] = [{ type: 'symbol_in', symbols: [] }];
    render(<TriggerBuilder triggers={triggers} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('symbols'), { target: { value: 'tsla, f, nflx' } });
    expect(onChange).toHaveBeenCalledWith([{ type: 'symbol_in', symbols: ['TSLA', 'F', 'NFLX'] }]);
  });

  it('renders option_dte_lt as a number input with the value', () => {
    const triggers: Trigger[] = [{ type: 'option_dte_lt', value: 7 }];
    render(<TriggerBuilder triggers={triggers} onChange={() => {}} />);
    const input = screen.getByLabelText('value') as HTMLInputElement;
    expect(input.value).toBe('7');
  });

  it('strike_below_cost_basis shows "no params"', () => {
    const triggers: Trigger[] = [{ type: 'strike_below_cost_basis' }];
    render(<TriggerBuilder triggers={triggers} onChange={() => {}} />);
    expect(screen.getByText(/no params/i)).toBeTruthy();
  });

  it('changing trigger type swaps to default for that type', () => {
    const onChange = vi.fn();
    const triggers: Trigger[] = [{ type: 'symbol_in', symbols: [] }];
    render(<TriggerBuilder triggers={triggers} onChange={onChange} />);
    const select = screen.getByLabelText('trigger type') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'side' } });
    expect(onChange).toHaveBeenCalledWith([{ type: 'side', value: 'sell' }]);
  });

  it('remove button removes a trigger', () => {
    const onChange = vi.fn();
    const triggers: Trigger[] = [
      { type: 'symbol_in', symbols: ['TSLA'] },
      { type: 'side', value: 'sell' },
    ];
    render(<TriggerBuilder triggers={triggers} onChange={onChange} />);
    const removeButtons = screen.getAllByLabelText('remove trigger');
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([{ type: 'side', value: 'sell' }]);
  });
});
