import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TradeDetail from '../../src/routes/TradeDetail';

function mockTradeResponse(trade: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        trade,
        grade: { entry: null, hindsight: null },
        assignment_child_id: null,
      }),
      { status: 200 }
    )
  );
}

function renderDetail(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/trade/${id}`]}>
        <Routes>
          <Route path="/trade/:id" element={<TradeDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TradeDetail route — spread rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders spread metadata block with both legs and net credit', async () => {
    mockTradeResponse({
      id: 'T-2026-05-15-001',
      account: 'manual_paper',
      asset_class: 'spread',
      symbol: 'AAL',
      side: 'sell_to_open',
      qty: 1,
      order_type: 'limit',
      tif: 'day',
      submitted_at: '2026-05-15T14:00:00Z',
      filled_at: '2026-05-15T14:05:00Z',
      filled_avg_price: 0.25,
      closed_at: null,
      closed_avg_price: null,
      realized_pnl: null,
      exposure_at_submit: 75,
      entry_grade: 'B+',
      entry_reasoning: '',
      journal: '',
      tags: [],
      rule_warnings_at_entry: [],
      schema: 1,
      alpaca_order_id: 'x',
      alpaca_close_order_id: null,
      contract_symbol: null,
      strike: null,
      expiration: null,
      contract_type: null,
      greeks_at_entry: null,
      limit_price: null,
      stop_price: null,
      trail_pct: null,
      closed_by: null,
      spread: {
        spread_type: 'put_credit',
        short_leg: { strike: 12.5, occ: 'AAL260529P00012500', entry_premium: 0.37, fill_price: 0.37, qty: 1 },
        long_leg: { strike: 11.5, occ: 'AAL260529P00011500', entry_premium: 0.12, fill_price: 0.12, qty: 1 },
        net_credit: 0.25,
        max_loss: 0.75,
        width: 1,
        expiration: '2026-05-29',
      },
    });

    renderDetail('T-2026-05-15-001');
    await waitFor(() => screen.getByText(/Trade T-2026-05-15-001/i));
    expect(screen.getByText(/put credit/i)).toBeInTheDocument();
    expect(screen.getByText(/short.*12\.50/i)).toBeInTheDocument();
    expect(screen.getByText(/long.*11\.50/i)).toBeInTheDocument();
    expect(screen.getByText(/net credit.*0\.25/i)).toBeInTheDocument();
    expect(screen.getByText(/max loss.*0\.75/i)).toBeInTheDocument();
  });
});
