// dashboard/tests/components/OrderFormSmRouting.test.tsx
//
// Phase 6.x critical fix: StockOrderForm + OptionOrderForm derived `mode` from
// a hardcoded 4-branch if-chain that silently mapped SM accounts to
// 'conservative'. Quotes/BP/positions then hit the WRONG account. These tests
// assert the SM mode now flows into the quote query (mode=sm500/sm1000/sm2000,
// never conservative) and that the SM account buttons render in both forms.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StockOrderForm } from '../../src/components/order/StockOrderForm';
import { OptionOrderForm } from '../../src/components/order/OptionOrderForm';

const tagsResponse = { tags: ['bullish', 'wheel'] };
const stockQuote = { snapshot: { TSLA: { latestQuote: { lp: 321.4, ap: 321.45, bp: 321.35 } } } };
const optionQuote = {
  snapshot: {
    snapshots: {
      PLTR260605P00100000: {
        latestQuote: { ap: 1.55, bp: 1.5 },
        greeks: { delta: -0.3, gamma: 0.04, theta: -0.05, vega: 0.1, implied_volatility: 0.65 },
      },
    },
  },
};
const positionsResponse = { positions: [] };
const acctResponse = { account: { buying_power: '5000', options_buying_power: '5000', cash: '5000' } };

let fetchedUrls: string[] = [];

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

beforeEach(() => {
  fetchedUrls = [];
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    fetchedUrls.push(String(url));
    const u = String(url);
    if (u.includes('/api/settings/tags')) return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
    if (u.includes('/api/alpaca/positions')) return Promise.resolve(new Response(JSON.stringify(positionsResponse), { status: 200 }));
    if (u.includes('/api/alpaca/account')) return Promise.resolve(new Response(JSON.stringify(acctResponse), { status: 200 }));
    if (u.includes('kind=option')) return Promise.resolve(new Response(JSON.stringify(optionQuote), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify(stockQuote), { status: 200 }));
  });
});

describe('StockOrderForm — SM cross-account routing', () => {
  it.each([
    ['sm500_paper', 'sm500'],
    ['sm1000_paper', 'sm1000'],
    ['sm2000_paper', 'sm2000'],
  ] as const)('derives mode %s → quote query carries mode=%s, never conservative', async (account, expectedMode) => {
    const qc = makeQc();
    render(
      <QueryClientProvider client={qc}>
        <StockOrderForm symbol="TSLA" account={account} setAccount={vi.fn()} onReview={vi.fn()} />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(fetchedUrls.some((u) => u.includes('/api/alpaca/quote') && u.includes(`mode=${expectedMode}`))).toBe(true);
    });
    const quoteUrls = fetchedUrls.filter((u) => u.includes('/api/alpaca/quote'));
    expect(quoteUrls.every((u) => !u.includes('mode=conservative'))).toBe(true);
  });

  it('renders the SM account buttons alongside the original four', async () => {
    const qc = makeQc();
    render(
      <QueryClientProvider client={qc}>
        <StockOrderForm symbol="TSLA" account="conservative_paper" setAccount={vi.fn()} onReview={vi.fn()} />
      </QueryClientProvider>
    );
    expect(screen.getByRole('button', { name: /conservative_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aggressive_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manual_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$500/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$1,000/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$2,000/ })).toBeInTheDocument();
  });
});

describe('OptionOrderForm — SM cross-account routing', () => {
  it.each([
    ['sm500_paper', 'sm500'],
    ['sm1000_paper', 'sm1000'],
    ['sm2000_paper', 'sm2000'],
  ] as const)('derives mode %s → option-quote query carries mode=%s, never conservative', async (account, expectedMode) => {
    const qc = makeQc();
    render(
      <QueryClientProvider client={qc}>
        <OptionOrderForm
          contractSymbol="PLTR260605P00100000"
          action="open"
          account={account}
          setAccount={vi.fn()}
          onReview={vi.fn()}
        />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(fetchedUrls.some((u) => u.includes('/api/alpaca/quote') && u.includes(`mode=${expectedMode}`))).toBe(true);
    });
    const quoteUrls = fetchedUrls.filter((u) => u.includes('/api/alpaca/quote'));
    expect(quoteUrls.every((u) => !u.includes('mode=conservative'))).toBe(true);
  });

  it('renders the SM account buttons alongside the original four', async () => {
    const qc = makeQc();
    render(
      <QueryClientProvider client={qc}>
        <OptionOrderForm
          contractSymbol="PLTR260605P00100000"
          action="open"
          account="conservative_paper"
          setAccount={vi.fn()}
          onReview={vi.fn()}
        />
      </QueryClientProvider>
    );
    expect(screen.getByRole('button', { name: /conservative_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aggressive_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manual_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$500/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$1,000/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$2,000/ })).toBeInTheDocument();
  });
});
