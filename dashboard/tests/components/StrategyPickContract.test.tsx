import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StrategyPickContract from '../../src/routes/StrategyPickContract';

// Inline route-spy that surfaces the current URL into the DOM so click
// assertions can verify which /order/new query string we navigated to.
function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="dest-url">{loc.pathname}{loc.search}</div>;
}

const chainResponse = {
  contracts: [
    { symbol: 'AAL260529C00012500', strike_price: '12.50', expiration_date: '2026-05-29', type: 'call' as const },
    { symbol: 'AAL260529C00013500', strike_price: '13.50', expiration_date: '2026-05-29', type: 'call' as const },
    { symbol: 'AAL260529P00012500', strike_price: '12.50', expiration_date: '2026-05-29', type: 'put' as const },
  ],
  snapshots: {
    AAL260529C00012500: { latestQuote: { bp: 0.80, ap: 0.95 } },
    AAL260529C00013500: { latestQuote: { bp: 0.42, ap: 0.50 } },
    AAL260529P00012500: { latestQuote: { bp: 0.36, ap: 0.42 } },
  },
};

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/alpaca/chain')) {
      return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
    }
    if (typeof url === 'string' && url.includes('/api/alpaca/quote')) {
      return Promise.resolve(
        new Response(JSON.stringify({ snapshot: { AAL: { latestTrade: { p: 12.6 } } } }), { status: 200 })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
});

function renderPicker(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/strategy/:symbol/pick" element={<StrategyPickContract />} />
          <Route path="/order/new" element={<LocationSpy />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('StrategyPickContract route', () => {
  it('renders the strategy title and "Pick a call to BUY" banner for Long Call', async () => {
    renderPicker('/strategy/AAL/pick?leg=call&side=BTO');
    await waitFor(() => screen.getByText(/Long Call/));
    expect(screen.getByText(/Long Call/)).toBeInTheDocument();
    expect(screen.getAllByText(/pick a call to buy/i).length).toBeGreaterThan(0);
  });

  it('renders the strategy title and "Pick a put to SELL" banner for CSP', async () => {
    renderPicker('/strategy/AAL/pick?leg=put&side=STO');
    await waitFor(() => screen.getByText(/Cash-Secured Put/));
    expect(screen.getByText(/Cash-Secured Put/)).toBeInTheDocument();
    expect(screen.getAllByText(/pick a put to sell/i).length).toBeGreaterThan(0);
  });

  it('clicking a bid in the chain navigates to /order/new with the forced side from the URL', async () => {
    // Intent: Long Call (side=BTO). The user clicks a bid (a "sell" click in
    // the chain widget), but the picker should still navigate as BTO.
    renderPicker('/strategy/AAL/pick?leg=call&side=BTO');
    await waitFor(() => screen.getByRole('button', { name: /bid 0\.80 — sell to open/i }));
    fireEvent.click(screen.getByRole('button', { name: /bid 0\.80 — sell to open/i }));
    await waitFor(() => screen.getByTestId('dest-url'));
    const url = screen.getByTestId('dest-url').textContent ?? '';
    expect(url).toContain('/order/new');
    expect(url).toContain('contract=AAL260529C00012500');
    expect(url).toContain('side=BTO'); // forced by intent
    expect(url).toContain('action=open');
  });

  it('clicking an ask in the chain navigates with side=STO when intent is STO', async () => {
    renderPicker('/strategy/AAL/pick?leg=call&side=STO');
    await waitFor(() => screen.getByRole('button', { name: /ask 0\.95 — buy to open/i }));
    fireEvent.click(screen.getByRole('button', { name: /ask 0\.95 — buy to open/i }));
    await waitFor(() => screen.getByTestId('dest-url'));
    const url = screen.getByTestId('dest-url').textContent ?? '';
    expect(url).toContain('side=STO'); // forced by intent
  });

  it('locks the chain to calls when leg=call', async () => {
    renderPicker('/strategy/AAL/pick?leg=call&side=BTO');
    // Wait for chain to render. The puts row should NOT appear.
    await waitFor(() => screen.getByRole('button', { name: /bid 0\.80 — sell to open/i }));
    // The put quote (0.36) shouldn't show up in any button
    expect(screen.queryByRole('button', { name: /bid 0\.36/i })).toBeNull();
  });

  it('locks the chain to puts when leg=put', async () => {
    renderPicker('/strategy/AAL/pick?leg=put&side=STO');
    await waitFor(() => screen.getByRole('button', { name: /bid 0\.36 — sell to open/i }));
    // The call quotes (0.80, 0.42) shouldn't show
    expect(screen.queryByRole('button', { name: /bid 0\.80/i })).toBeNull();
  });
});
