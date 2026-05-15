import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrderNew from '../../src/routes/OrderNew';

const chainResponse = {
  contracts: [
    { symbol: 'AAL260529P00012500', strike_price: '12.50', expiration_date: '2026-05-29', type: 'put' },
  ],
  snapshots: {},
};

beforeEach(() => {
  // Mock both the chain fetch (SpreadOrderForm) and tags fetch (TagPicker)
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/settings/tags')) {
      return Promise.resolve(new Response(JSON.stringify({ tags: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
  });
});

function renderOrderNew(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <OrderNew />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('OrderNew route', () => {
  it('renders SpreadOrderForm when ?spread=put_credit&symbol=AAL', async () => {
    renderOrderNew('/order/new?spread=put_credit&symbol=AAL');
    await waitFor(() => expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument());
    // Spread-specific controls confirm the third branch fired
    expect(screen.getByLabelText(/expiration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/short strike/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/long strike/i)).toBeInTheDocument();
  });

  it('shows the spread flag in the breadcrumb header', async () => {
    renderOrderNew('/order/new?spread=put_credit&symbol=AAL');
    await waitFor(() => screen.getByText(/--spread=put_credit/));
    expect(screen.getByText(/--symbol=AAL/)).toBeInTheDocument();
  });
});
