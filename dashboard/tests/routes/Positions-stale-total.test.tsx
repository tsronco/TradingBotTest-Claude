import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../src/hooks/useAccount', () => ({ useAccount: () => ['live', vi.fn()] }));
vi.mock('../../src/hooks/useBotState', () => ({ useBotWheelState: () => ({ data: null }) }));
vi.mock('../../src/hooks/useDisplayName', () => ({ useDisplayName: () => ({ handle: 'tim' }) }));
vi.mock('../../src/hooks/useMarketClock', () => ({ useMarketClock: () => ({ data: { is_open: true } }) }));

import Positions from '../../src/routes/Positions';

const leg = (symbol: string, qty: string, avg: string, cur: string, pl: string) => ({
  symbol, asset_class: 'us_option', qty, side: Number(qty) > 0 ? 'long' : 'short',
  avg_entry_price: avg, current_price: cur, market_value: '0', unrealized_pl: pl, unrealized_plpc: '0',
});

function setPositions(positions: any[]) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/alpaca/positions')) return Promise.resolve(new Response(JSON.stringify({ positions }), { status: 200 }));
    if (url.includes('/api/alpaca/account')) return Promise.resolve(new Response(JSON.stringify({ account: { cash: '159.72', options_buying_power: '59.72' } }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ snapshot: {} }), { status: 200 }));
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><Positions /></MemoryRouter></QueryClientProvider>);
}

describe('Positions — account total P/L', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads "stale quote" when a spread\'s legs add up to an impossible P/L (BAC 2026-11-05)', async () => {
    // short 49 @ 0.71 marked 1.18, long 48 @ 0.48 marked 0.02 → −$93 on a −$77 max loss
    setPositions([
      leg('BAC261120P00048000', '1', '0.48', '0.02', '-46'),
      leg('BAC261120P00049000', '-1', '0.71', '1.18', '-47'),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('total-pl-stale')).toHaveTextContent('stale quote'));
    expect(screen.queryByText('$93.00')).toBeNull();
  });

  it('shows the number when every spread is within its range', async () => {
    setPositions([
      leg('BAC261120P00048000', '1', '0.48', '0.56', '8'),
      leg('BAC261120P00049000', '-1', '0.71', '0.96', '-25'),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/\$17\.00/)).toBeInTheDocument());
    expect(screen.queryByTestId('total-pl-stale')).toBeNull();
  });
});
