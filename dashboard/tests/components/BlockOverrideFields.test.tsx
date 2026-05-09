import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BlockOverrideFields from '../../src/components/order/BlockOverrideFields';

describe('BlockOverrideFields', () => {
  const blocks = [
    { rule: 'r-1', severity: 'block' as const, message: 'No earnings week' },
    { rule: 'r-2', severity: 'block' as const, message: 'No CC below cost' },
  ];

  it('renders one textarea per block-severity rule', () => {
    render(
      <BlockOverrideFields
        blocks={blocks}
        reasonByRule={{}}
        onReasonChange={() => {}}
      />,
    );
    const textareas = screen.getAllByRole('textbox');
    expect(textareas).toHaveLength(2);
  });

  it('shows the rule message above each textarea', () => {
    render(
      <BlockOverrideFields
        blocks={blocks}
        reasonByRule={{}}
        onReasonChange={() => {}}
      />,
    );
    expect(screen.getByText(/No earnings week/)).toBeTruthy();
    expect(screen.getByText(/No CC below cost/)).toBeTruthy();
  });

  it('calls onReasonChange when typing into a textarea', () => {
    const onChange = vi.fn();
    render(
      <BlockOverrideFields
        blocks={blocks}
        reasonByRule={{}}
        onReasonChange={onChange}
      />,
    );
    const ta = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'because reasons' } });
    expect(onChange).toHaveBeenCalledWith('r-1', 'because reasons');
  });

  it('shows remaining-chars hint until 20 chars typed', () => {
    render(
      <BlockOverrideFields
        blocks={[blocks[0]]}
        reasonByRule={{ 'r-1': 'short' }}
        onReasonChange={() => {}}
      />,
    );
    expect(screen.getByText(/15 more chars/i)).toBeTruthy();
  });

  it('shows char count when at/over 20 chars', () => {
    render(
      <BlockOverrideFields
        blocks={[blocks[0]]}
        reasonByRule={{ 'r-1': 'long enough reason text' }}
        onReasonChange={() => {}}
      />,
    );
    expect(screen.getByText(/23\/500/i)).toBeTruthy();
  });

  it('renders nothing when blocks is empty', () => {
    const { container } = render(
      <BlockOverrideFields blocks={[]} reasonByRule={{}} onReasonChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
