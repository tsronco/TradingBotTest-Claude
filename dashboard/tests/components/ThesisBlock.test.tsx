// Shared thesis renderer.
//
// Regression cover for a readability bug that shipped in two places at once:
// the field "tone" was applied to the prose as well as the label, so
// `rejected alternatives` rendered its entire body in --color-dim against a
// near-black background — technically present, practically invisible.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThesisBlock, ThesisField } from '../../src/components/agent/ThesisBlock';

const THESIS = {
  thesis: 'CVS carries the lowest implied vol in my shortlist.',
  getting_paid: 'Net debit 2.45 on a 7-wide.',
  key_risk: 'CVS goes flat and the vertical bleeds.',
  invalidation: 'Wrong if CVS closes below $90.00.',
  rejected: 'Rejected a plain long Sep-25 96 call.',
};

describe('ThesisBlock', () => {
  it('renders every field the agent supplies', () => {
    render(<ThesisBlock thesis={THESIS} />);
    for (const v of Object.values(THESIS)) {
      expect(screen.getByText(v)).toBeInTheDocument();
    }
  });

  it('never renders body prose in the dim chrome colour', () => {
    render(<ThesisBlock thesis={THESIS} />);
    for (const v of Object.values(THESIS)) {
      const el = screen.getByText(v);
      expect(el.className).not.toContain('text-dim');
      expect(el.className).toContain('text-fg');
    }
  });

  it('keeps rejected alternatives as readable as the rest', () => {
    // This is the field that regressed — de-emphasis belongs on the label.
    render(<ThesisBlock thesis={THESIS} />);
    const body = screen.getByText(THESIS.rejected);
    const label = screen.getByText(/rejected alternatives/i);
    expect(body.className).toContain('text-fg');
    expect(label.className).not.toContain('text-fg');
  });

  it('tints the risk and invalidation labels without touching their prose', () => {
    render(<ThesisBlock thesis={THESIS} />);
    expect(screen.getByText(/key risk/i).className).toContain('text-amber');
    expect(screen.getByText(/invalidation/i).className).toContain('text-red');
    expect(screen.getByText(THESIS.key_risk).className).toContain('text-fg');
    expect(screen.getByText(THESIS.invalidation).className).toContain('text-fg');
  });

  it('omits a field the agent left empty instead of showing a bare label', () => {
    render(<ThesisBlock thesis={{ thesis: 'only this' }} />);
    expect(screen.getByText('only this')).toBeInTheDocument();
    expect(screen.queryByText(/rejected alternatives/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invalidation/i)).not.toBeInTheDocument();
  });

  it('says so when there is no thesis at all', () => {
    render(<ThesisBlock thesis={null} />);
    expect(screen.getByText(/no thesis recorded/i)).toBeInTheDocument();
  });
});

describe('ThesisField', () => {
  it('renders nothing for an absent value', () => {
    const { container } = render(<ThesisField label="thesis" value={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty string', () => {
    const { container } = render(<ThesisField label="thesis" value="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
