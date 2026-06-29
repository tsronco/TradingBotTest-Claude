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

  it('renders SpreadOrderForm for ?spread=call_credit (newly-supported type)', async () => {
    renderOrderNew('/order/new?spread=call_credit&symbol=AAL');
    await waitFor(() => expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument());
    // Spread-specific controls confirm we routed to SpreadOrderForm, not StockOrderForm
    expect(screen.getByLabelText(/expiration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/short strike/i)).toBeInTheDocument();
    // Title appears in the form header. The lowercased duplicate inside the
    // bot-management banner ("Bot will track this call credit spread…")
    // means we get matches at multiple text nodes — assert ≥1 instead.
    expect(screen.getAllByText(/Call Credit Spread/i).length).toBeGreaterThan(0);
  });

  it('renders SpreadOrderForm for ?spread=put_debit', async () => {
    renderOrderNew('/order/new?spread=put_debit&symbol=AAL');
    await waitFor(() => expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument());
    expect(screen.getAllByText(/Put Debit Spread/i).length).toBeGreaterThan(0);
  });

  it('renders SpreadOrderForm for ?spread=call_debit', async () => {
    renderOrderNew('/order/new?spread=call_debit&symbol=AAL');
    await waitFor(() => expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument());
    expect(screen.getAllByText(/Call Debit Spread/i).length).toBeGreaterThan(0);
  });

  it('ignores an unrecognized ?spread= value (falls through to stock/symbol form)', async () => {
    renderOrderNew('/order/new?spread=bogus&symbol=AAL');
    await waitFor(() => screen.getByText(/--type=null/i));
    // Breadcrumb shows the symbol+type form, not the spread form
    expect(screen.queryByText(/Put Credit Spread/i)).toBeNull();
  });

  it('prefills limit price and side when arriving with ?side=STO&price=1.23 (chain bid click)', async () => {
    // Use an option contract route. The chain-probe fetch returns the contract symbol,
    // OptionOrderForm reads the URL params we passed via OrderNew and seeds state.
    renderOrderNew('/order/new?contract=AAL260529P00012500&action=open&side=STO&price=1.23');
    await waitFor(() => screen.getByText(/option · opening · manual_paper/i));

    // The STO side chip should be active
    const stoBtn = screen.getByRole('button', { name: /STO/i });
    expect(stoBtn.className).toMatch(/active/);
    const btoBtn = screen.getByRole('button', { name: /BTO/i });
    expect(btoBtn.className).not.toMatch(/active/);

    // The limit price input should be prefilled with 1.23
    const limitInput = document.querySelector('input[type="number"]:not([min])') as HTMLInputElement;
    // There are multiple number inputs; find the one whose value is 1.23
    const allNumberInputs = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    expect(allNumberInputs.some((el) => el.value === '1.23')).toBe(true);
    // suppress lint about unused var
    void limitInput;
  });

  it('prefills BTO when arriving with ?side=BTO (chain ask click)', async () => {
    renderOrderNew('/order/new?contract=AAL260529P00012500&action=open&side=BTO&price=0.42');
    await waitFor(() => screen.getByText(/option · opening · manual_paper/i));
    const btoBtn = screen.getByRole('button', { name: /BTO/i });
    expect(btoBtn.className).toMatch(/active/);
  });
});
