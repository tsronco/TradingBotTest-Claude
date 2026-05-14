import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrderNew from '../../src/routes/OrderNew';

beforeEach(() => {
  // Mock the chain fetch that SpreadOrderForm makes on mount
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        contracts: [
          { symbol: 'AAL260529P00012500', strike_price: '12.50', expiration_date: '2026-05-29', type: 'put' },
        ],
        snapshots: {},
      }),
      { status: 200 }
    )
  );
});

describe('OrderNew route', () => {
  it('renders SpreadOrderForm when ?spread=put_credit&symbol=AAL', async () => {
    render(
      <MemoryRouter initialEntries={['/order/new?spread=put_credit&symbol=AAL']}>
        <OrderNew />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument());
    // Spread-specific controls confirm the third branch fired
    expect(screen.getByLabelText(/expiration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/short strike/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/long strike/i)).toBeInTheDocument();
  });

  it('shows the spread flag in the breadcrumb header', async () => {
    render(
      <MemoryRouter initialEntries={['/order/new?spread=put_credit&symbol=AAL']}>
        <OrderNew />
      </MemoryRouter>
    );
    await waitFor(() => screen.getByText(/--spread=put_credit/));
    expect(screen.getByText(/--symbol=AAL/)).toBeInTheDocument();
  });
});
