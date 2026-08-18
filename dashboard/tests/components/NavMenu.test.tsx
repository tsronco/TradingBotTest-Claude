// Grouped sidebar nav — open/close behavior and active highlighting.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NavMenu from '../../src/components/layout/NavMenu';

function renderNav(initial = '/', onNavigate?: () => void) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <NavMenu onNavigate={onNavigate} />
    </MemoryRouter>,
  );
}

const groupBtn = (name: RegExp) => screen.getByRole('button', { name });

describe('NavMenu — collapsed state', () => {
  it('shows 5 top-level rows instead of the old flat 10', () => {
    renderNav();
    for (const label of ['home', 'portfolio', 'research', 'insights', 'agent']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('hides nested pages until their group is opened', () => {
    renderNav();
    expect(screen.queryByText('positions')).not.toBeInTheDocument();
    expect(screen.queryByText('watchlist')).not.toBeInTheDocument();
    expect(screen.queryByText('performance')).not.toBeInTheDocument();
  });

  it('marks groups as collapsed for assistive tech', () => {
    renderNav();
    expect(groupBtn(/portfolio/i)).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('NavMenu — opening a group', () => {
  it('reveals that group\'s pages', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    const panel = screen.getByRole('group', { name: 'portfolio' });
    expect(within(panel).getByText('positions')).toBeInTheDocument();
    expect(within(panel).getByText('orders')).toBeInTheDocument();
    expect(within(panel).getByText('trades')).toBeInTheDocument();
  });

  it('renders the panel exactly once — not one copy per breakpoint', () => {
    // Two copies would duplicate every link and the panel id.
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    expect(screen.getAllByText('positions')).toHaveLength(1);
    expect(document.querySelectorAll('#nav-panel-portfolio')).toHaveLength(1);
  });

  it('wires the button to the panel it controls', () => {
    renderNav();
    const btn = groupBtn(/portfolio/i);
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn.getAttribute('aria-controls')).toBe('nav-panel-portfolio');
  });

  it('opens only one group at a time', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.click(groupBtn(/research/i));
    expect(screen.queryByText('positions')).not.toBeInTheDocument();
    expect(screen.getByText('watchlist')).toBeInTheDocument();
  });

  it('toggles closed when the same group is tapped again', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.click(groupBtn(/portfolio/i));
    expect(screen.queryByText('positions')).not.toBeInTheDocument();
  });
});

describe('NavMenu — dismissing', () => {
  it('closes on Escape', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('positions')).not.toBeInTheDocument();
  });

  it('closes on an outside click', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('positions')).not.toBeInTheDocument();
  });

  it('stays open when the click is inside the menu', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.mouseDown(screen.getByRole('group', { name: 'portfolio' }));
    expect(screen.getByText('positions')).toBeInTheDocument();
  });

  it('offers a back row to return to the list', () => {
    renderNav();
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.click(screen.getByText('back'));
    expect(screen.queryByText('positions')).not.toBeInTheDocument();
    expect(screen.getByText('portfolio')).toBeInTheDocument();
  });
});

describe('NavMenu — active highlighting', () => {
  it('lights the group you are currently inside, while collapsed', () => {
    renderNav('/positions');
    expect(groupBtn(/portfolio/i).className).toContain('active');
    expect(groupBtn(/research/i).className).not.toContain('active');
  });

  it('lights the group from a detail route that does not share the prefix', () => {
    renderNav('/trade/T-2026-08-18-001');
    expect(groupBtn(/portfolio/i).className).toContain('active');
  });

  it('lights a top-level row when you are on it', () => {
    renderNav('/agent');
    expect(screen.getByText('agent').closest('a')!.className).toContain('active');
  });

  it('does not light home on a non-home route', () => {
    renderNav('/positions');
    expect(screen.getByText('home').closest('a')!.className).not.toContain('active');
  });
});

describe('NavMenu — navigation', () => {
  it('calls onNavigate when a nested page is chosen (closes the mobile drawer)', () => {
    const onNavigate = vi.fn();
    renderNav('/', onNavigate);
    fireEvent.click(groupBtn(/portfolio/i));
    fireEvent.click(screen.getByText('orders'));
    expect(onNavigate).toHaveBeenCalled();
  });

  it('calls onNavigate for a top-level page too', () => {
    const onNavigate = vi.fn();
    renderNav('/', onNavigate);
    fireEvent.click(screen.getByText('agent'));
    expect(onNavigate).toHaveBeenCalled();
  });

  it('sends lookup to a concrete symbol, since the route requires one', () => {
    renderNav();
    fireEvent.click(groupBtn(/research/i));
    expect(screen.getByText('lookup').closest('a')).toHaveAttribute('href', '/lookup/SPY');
  });
});
