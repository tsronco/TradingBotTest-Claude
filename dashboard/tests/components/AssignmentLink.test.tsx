import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AssignmentLink from '../../src/components/trade/AssignmentLink';

function withRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('AssignmentLink', () => {
  it('renders up direction with "Assigned from" + parent id link', () => {
    withRouter(<AssignmentLink direction="up" tradeId="T-PARENT-001" />);
    expect(screen.getByText(/Assigned from/)).toBeTruthy();
    const link = screen.getByText('T-PARENT-001');
    expect(link.getAttribute('href')).toBe('/trade/T-PARENT-001');
  });

  it('renders down direction with "Assignment spawned" + child id link', () => {
    withRouter(<AssignmentLink direction="down" tradeId="T-CHILD-001" />);
    expect(screen.getByText(/Assignment spawned/)).toBeTruthy();
    const link = screen.getByText('T-CHILD-001');
    expect(link.getAttribute('href')).toBe('/trade/T-CHILD-001');
  });

  it('shows inherited-grade caption only on up direction with inherited prop', () => {
    withRouter(<AssignmentLink direction="up" tradeId="T-1" inherited />);
    expect(screen.getByText(/grades inherited from parent/i)).toBeTruthy();
  });

  it('does not show inherited caption on down direction', () => {
    withRouter(<AssignmentLink direction="down" tradeId="T-1" />);
    expect(screen.queryByText(/grades inherited/i)).toBeNull();
  });
});
