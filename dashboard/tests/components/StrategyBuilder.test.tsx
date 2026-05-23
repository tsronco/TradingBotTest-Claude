import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StrategyBuilder from '../../src/routes/StrategyBuilder';

function renderBuilder(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/strategy/:symbol" element={<StrategyBuilder />} />
          {/* destination stubs for navigation assertions */}
          <Route path="/order/new" element={<div data-testid="dest-order">order page</div>} />
          <Route path="/strategy/:symbol/pick" element={<div data-testid="dest-pick">picker page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation(() => {
    // Return a spot quote for the symbol so cards have a current price.
    return Promise.resolve(
      new Response(
        JSON.stringify({ snapshot: { SPY: { latestTrade: { p: 425.5 } } } }),
        { status: 200 }
      )
    );
  });
});

describe('StrategyBuilder route', () => {
  it('renders the page title and the symbol in the breadcrumb', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByText(/Options Strategy Builder/i));
    expect(screen.getByText(/Options Strategy Builder/i)).toBeInTheDocument();
    // Symbol appears both in breadcrumb and title
    const matches = screen.getAllByText(/SPY/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders all 4 section headers', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByRole('heading', { name: /Single Leg/ }));
    expect(screen.getByRole('heading', { name: /Single Leg/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Vertical Spreads/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Straddles and Strangles/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Calendar Spreads/ })).toBeInTheDocument();
  });

  it('renders all 13 strategy cards', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByText('Long Call'));
    // Each card is a <button> with a data-strategy-id attribute
    const cards = document.querySelectorAll('button[data-strategy-id]');
    expect(cards.length).toBe(13);
  });

  it('"coming_soon" cards are rendered but disabled', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByText(/Long Straddle/));
    const straddleCard = document.querySelector('button[data-strategy-id="long_straddle"]') as HTMLButtonElement;
    expect(straddleCard).not.toBeNull();
    expect(straddleCard.disabled).toBe(true);
    expect(straddleCard.getAttribute('data-status')).toBe('coming_soon');
  });

  it('clicking Put Credit Spread navigates to /order/new?spread=put_credit', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByText(/Put Credit Spread/));
    const card = document.querySelector('button[data-strategy-id="put_credit_spread"]') as HTMLButtonElement;
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByTestId('dest-order')).toBeInTheDocument());
  });

  it('clicking Long Call navigates to /strategy/SPY/pick?leg=call&side=BTO', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByText('Long Call'));
    const card = document.querySelector('button[data-strategy-id="long_call"]') as HTMLButtonElement;
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByTestId('dest-pick')).toBeInTheDocument());
  });

  it('clicking a coming_soon card is a no-op (does not navigate)', async () => {
    renderBuilder('/strategy/SPY');
    await waitFor(() => screen.getByText(/Long Straddle/));
    const straddleCard = document.querySelector('button[data-strategy-id="long_straddle"]') as HTMLButtonElement;
    fireEvent.click(straddleCard);
    // Still on the strategy builder page
    expect(screen.getByText(/Options Strategy Builder/i)).toBeInTheDocument();
    expect(screen.queryByTestId('dest-order')).toBeNull();
    expect(screen.queryByTestId('dest-pick')).toBeNull();
  });
});
