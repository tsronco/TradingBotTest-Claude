import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Lookup from '../../src/routes/Lookup';

function renderLookup(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/lookup/:symbol" element={<Lookup />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Lookup — Build Put Credit Spread button', () => {
  it('shows the button when /api/alpaca/chain returns contracts', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/alpaca/chain')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              contracts: [
                {
                  symbol: 'AAL260529P00012500',
                  underlying_symbol: 'AAL',
                  strike_price: '12.50',
                  expiration_date: '2026-05-29',
                  type: 'put',
                },
              ],
              snapshots: {},
            }),
            { status: 200 }
          )
        );
      }
      // Any other request (quote, position, etc.) — return an empty success
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    renderLookup('/lookup/AAL');

    await waitFor(() => {
      const link =
        screen.queryByRole('link', { name: /build put credit spread/i }) ??
        screen.queryByRole('button', { name: /build put credit spread/i });
      expect(link).not.toBeNull();
    });
  });

  it('hides the button when the chain is empty', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/alpaca/chain')) {
        return Promise.resolve(
          new Response(JSON.stringify({ contracts: [], snapshots: {} }), { status: 200 })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    renderLookup('/lookup/NOOPTQ');

    // Wait for the page to settle (NOOPTQ symbol appears in the header)
    await waitFor(() => screen.getAllByText(/NOOPTQ/i)[0]);
    expect(screen.queryByRole('link', { name: /build put credit spread/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /build put credit spread/i })).toBeNull();
  });
});
