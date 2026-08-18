import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
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

describe('AppShell market pill', () => {
  it('tap toggles the market-reason popover (mobile fix — native title is hover-only)', () => {
    renderShell();
    expect(screen.queryByRole('tooltip')).toBeNull();
    const pill = screen.getByRole('button', { name: /^market/i });
    fireEvent.click(pill);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(pill);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a click outside closes the market-reason popover', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /^market/i }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('HOME_PAGE'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('AppShell NET / API health', () => {
  it('shows a red API ERR when the health ping fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    renderShell();
    // the /api/alpaca/clock probe rejects → API indicator flips to ERR
    expect(await screen.findByText('ERR')).toBeInTheDocument();
  });
});

/**
 * Mobile drawer overflow — regression guard.
 *
 * The drawer is `fixed inset-y-0` and AppShell locks body scroll while it is
 * open, so its own `overflow-y` is the ONLY thing that makes content past the
 * bottom edge reachable. Without it the settings / changelog / sign_out
 * cluster is unreachable on a short phone (reported 2026-08-18, after a third
 * account chip and a tenth nav row pushed it over the fold).
 *
 * jsdom does not apply stylesheets, so asserting computed style would pass
 * vacuously. Assert against the stylesheet source instead — crude, but it
 * actually fails if someone deletes the rule.
 */
describe('mobile drawer scrolling (globals.css)', () => {
  // import.meta.url is not a file: URL under the jsdom environment, so resolve
  // from the vitest root (dashboard/) instead. Comments are stripped first —
  // otherwise a commented-out declaration still satisfies the match and the
  // guard passes vacuously (verified: it did, before this strip was added).
  const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const mobileBlock = css.slice(css.indexOf('.term-sidebar-wrap'));

  it('the drawer wrapper scrolls its own overflow', () => {
    expect(mobileBlock).toMatch(/\.term-sidebar-wrap\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('scrolling does not chain out to the scroll-locked body', () => {
    expect(mobileBlock).toMatch(/\.term-sidebar-wrap\s*\{[^}]*overscroll-behavior:\s*contain/);
  });

  it('the aside fills the drawer without being pinned to a viewport unit', () => {
    // 100vh here re-creates the bug on any phone whose usable height < 100vh.
    expect(mobileBlock).toMatch(/aside\.term-sidebar\s*\{\s*min-height:\s*100%/);
    expect(mobileBlock).not.toMatch(/aside\.term-sidebar\s*\{\s*min-height:\s*100vh/);
  });
});
