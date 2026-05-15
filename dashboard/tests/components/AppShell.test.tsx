import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppShell from '../../src/components/layout/AppShell';

function renderShell(initial = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>HOME_PAGE</div>} />
            <Route path="/positions" element={<div>POSITIONS_PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AppShell drawer', () => {
  it('drawer starts closed (translate-x-full)', () => {
    renderShell();
    const wrap = document.querySelector('.term-sidebar-wrap')!;
    expect(wrap.className).toContain('-translate-x-full');
  });

  it('hamburger toggles the drawer open', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('translate-x-0');
  });

  it('backdrop click closes the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('-translate-x-full');
  });

  it('navigating via a nav row closes the drawer and changes route', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    fireEvent.click(screen.getByText('positions'));
    expect(screen.getByText('POSITIONS_PAGE')).toBeInTheDocument();
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('-translate-x-full');
  });

  it('Escape closes the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.term-sidebar-wrap')!.className).toContain('-translate-x-full');
  });

  it('locks body scroll while open and restores on close', () => {
    renderShell();
    expect(document.body.style.overflow).toBe('');
    fireEvent.click(screen.getByLabelText('Toggle navigation'));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });
});
