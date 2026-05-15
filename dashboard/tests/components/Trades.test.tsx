import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Trades from '../../src/routes/Trades';

function mockTradesResponse(trade: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        trades: [trade],
        grades: [{ trade_id: trade.id, ai_letter: null, calibration: null }],
        total: 1,
        summary: { count: 1, win_rate: 0, calibration: { matched: 0, over: 0, under: 0 } },
      }),
      { status: 200 }
    )
  );
}

function renderTrades() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Trades />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Trades route — spread rendering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a spread trade as a single row with both strikes inline', async () => {
    mockTradesResponse({
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
      entry_grade: 'B+',
      tags: [],
      rule_warnings_at_entry: [],
      schema: 1,
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

    renderTrades();
    await waitFor(() => screen.getByText(/AAL/i));
    expect(screen.getByText(/AAL.*put credit.*12\.50.*11\.50/i)).toBeInTheDocument();
  });
});
