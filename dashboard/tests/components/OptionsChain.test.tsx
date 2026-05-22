import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OptionsChain from '../../src/components/lookup/OptionsChain';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateSpy };
});

// Minimal mock for the account hook used inside OptionsChain
vi.mock('../../src/hooks/useAccount', () => ({
  useAccount: () => ['conservative' as const, vi.fn()],
}));

function makeQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderChain(symbol = 'SPY') {
  const qc = makeQc();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OptionsChain symbol={symbol} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Canonical chain mock: strikes 95/100/105, spot 101
// The quote endpoint returns the spot; chain endpoints return contracts + snapshots.
function buildFetchMock(spot: number) {
  return vi.fn().mockImplementation((url: string) => {
    const u = typeof url === 'string' ? url : '';

    // Quote endpoint
    if (u.includes('/api/alpaca/quote')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            snapshot: {
              SPY: {
                latestTrade: { p: spot },
                dailyBar: { c: spot },
              },
            },
          }),
          { status: 200 }
        )
      );
    }

    // Chain endpoint (expirations + snapshots)
    if (u.includes('/api/alpaca/chain')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            contracts: [
              { symbol: 'SPY260620P00095000', underlying_symbol: 'SPY', expiration_date: '2026-06-20', strike_price: '95', type: 'put' as const },
              { symbol: 'SPY260620P00100000', underlying_symbol: 'SPY', expiration_date: '2026-06-20', strike_price: '100', type: 'put' as const },
              { symbol: 'SPY260620P00105000', underlying_symbol: 'SPY', expiration_date: '2026-06-20', strike_price: '105', type: 'put' as const },
            ],
            snapshots: {
              SPY260620P00095000: { latestQuote: { bp: 0.50, ap: 0.60 }, greeks: { delta: -0.10, gamma: 0.01, theta: -0.02, vega: 0.05 } },
              SPY260620P00100000: { latestQuote: { bp: 1.00, ap: 1.10 }, greeks: { delta: -0.30, gamma: 0.02, theta: -0.04, vega: 0.10 } },
              SPY260620P00105000: { latestQuote: { bp: 2.00, ap: 2.10 }, greeks: { delta: -0.55, gamma: 0.01, theta: -0.06, vega: 0.08 } },
            },
          }),
          { status: 200 }
        )
      );
    }

    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateSpy.mockReset();
});

describe('OptionsChain — spot divider', () => {
  it('renders a spot divider between the bracketing strikes (Task 3.1)', async () => {
    globalThis.fetch = buildFetchMock(101);
    renderChain('SPY');

    // Divider should appear with "Share price" text and the spot value
    const divider = await screen.findByText(/share price/i);
    expect(divider).toBeInTheDocument();
    // The spot value 101 should be rendered inside the divider cell
    expect(divider.textContent).toMatch(/101/);

    // Verify DOM order: strike-100 row comes before divider, divider before strike-105
    await waitFor(() => {
      const rows = [...document.querySelectorAll('tr')];
      const rowText = rows.map((r) => r.textContent ?? '');
      // Find the row indices
      const i100 = rowText.findIndex((t) => t.includes('$100') || t.includes('100.00'));
      const iDiv = rowText.findIndex((t) => /share price/i.test(t));
      const i105 = rowText.findIndex((t) => t.includes('$105') || t.includes('105.00'));
      expect(i100).toBeGreaterThan(-1);
      expect(iDiv).toBeGreaterThan(-1);
      expect(i105).toBeGreaterThan(-1);
      expect(i100).toBeLessThan(iDiv);
      expect(iDiv).toBeLessThan(i105);
    });
  });

  it('divider moves to the new rung when spot changes (Task 3.2)', async () => {
    // Spot 95 → divider goes before the first visible strike (at the top)
    // or in the lowest position. Spot 106 → divider goes after 105 (at bottom).
    // We test by re-rendering with a new spot that crosses a strike boundary.

    // First render: spot = 101 → divider between 100 and 105
    globalThis.fetch = buildFetchMock(101);
    const { unmount } = renderChain('SPY');

    await waitFor(() => {
      const rows = [...document.querySelectorAll('tr')];
      const rowText = rows.map((r) => r.textContent ?? '');
      const i100 = rowText.findIndex((t) => t.includes('$100') || t.includes('100.00'));
      const iDiv = rowText.findIndex((t) => /share price/i.test(t));
      const i105 = rowText.findIndex((t) => t.includes('$105') || t.includes('105.00'));
      expect(i100).toBeLessThan(iDiv);
      expect(iDiv).toBeLessThan(i105);
    });

    unmount();

    // Second render: spot = 106 → all visible strikes (95/100/105) ≤ spot
    // divider should appear after the last strike row (105), at the bottom
    globalThis.fetch = buildFetchMock(106);
    renderChain('SPY');

    await waitFor(() => {
      const rows = [...document.querySelectorAll('tr')];
      const rowText = rows.map((r) => r.textContent ?? '');
      const i105 = rowText.findIndex((t) => t.includes('$105') || t.includes('105.00'));
      const iDiv = rowText.findIndex((t) => /share price/i.test(t));
      expect(i105).toBeGreaterThan(-1);
      expect(iDiv).toBeGreaterThan(-1);
      // Divider should be after the 105 row when all strikes are below spot
      expect(iDiv).toBeGreaterThan(i105);
    });
  });
});

describe('OptionsChain — clickable bid/ask buttons (item 1)', () => {
  it('renders bid and ask as buttons with aria-labels', async () => {
    globalThis.fetch = buildFetchMock(101);
    renderChain('SPY');
    // Wait for snapshot rows to populate
    await waitFor(() => {
      // At least one bid button should appear
      expect(screen.getAllByRole('button', { name: /bid \d/i }).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /ask \d/i }).length).toBeGreaterThan(0);
  });

  it('clicking ask navigates to /order/new with side=BTO and the ask price', async () => {
    globalThis.fetch = buildFetchMock(101);
    renderChain('SPY');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /ask 1\.10/i }).length).toBeGreaterThan(0);
    });
    const askBtn = screen.getByRole('button', { name: /ask 1\.10 — buy to open/i });
    fireEvent.click(askBtn);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const url = navigateSpy.mock.calls[0][0] as string;
    expect(url).toContain('/order/new?');
    expect(url).toContain('contract=SPY260620P00100000');
    expect(url).toContain('side=BTO');
    expect(url).toContain('price=1.10');
  });

  it('clicking bid navigates to /order/new with side=STO and the bid price', async () => {
    globalThis.fetch = buildFetchMock(101);
    renderChain('SPY');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /bid 1\.00/i }).length).toBeGreaterThan(0);
    });
    const bidBtn = screen.getByRole('button', { name: /bid 1\.00 — sell to open/i });
    fireEvent.click(bidBtn);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const url = navigateSpy.mock.calls[0][0] as string;
    expect(url).toContain('side=STO');
    expect(url).toContain('price=1.00');
  });

  it('clicking ask in embedded mode (onPriceClick) calls the callback instead of navigating', async () => {
    globalThis.fetch = buildFetchMock(101);
    const onPriceClick = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <OptionsChain symbol="SPY" onPriceClick={onPriceClick} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /ask 1\.10/i }).length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: /ask 1\.10 — buy to open/i }));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(onPriceClick).toHaveBeenCalledTimes(1);
    const info = onPriceClick.mock.calls[0][0];
    expect(info.side).toBe('ask');
    expect(info.price).toBe(1.1);
    expect(info.contract.symbol).toBe('SPY260620P00100000');
  });
});

describe('OptionsChain — DTE in expiration dropdown (item 5)', () => {
  it('shows (N DTE) next to each expiration date in the dropdown', async () => {
    globalThis.fetch = buildFetchMock(101);
    renderChain('SPY');
    await waitFor(() => {
      const select = document.querySelector('select') as HTMLSelectElement;
      expect(select).toBeTruthy();
      const labels = Array.from(select.options).map((o) => o.textContent ?? '');
      // The expiration date is 2026-06-20; today's date when tests run is variable.
      // We just assert the "DTE" suffix is present on at least one option.
      expect(labels.some((l) => /\(\d+ DTE\)|\(expired\)/.test(l))).toBe(true);
    });
  });
});
