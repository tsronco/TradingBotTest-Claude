import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FundingPanel from '../../src/components/account/FundingPanel';

const MOCK_ACTIVITIES = [
  { id: '1', activity_type: 'CSD', net_amount: '1000', date: '2026-06-30' },
  { id: '2', activity_type: 'CSW', net_amount: '-250', date: '2026-06-29' },
];

function mockFetch(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FundingPanel mode="live" />
    </QueryClientProvider>,
  );
}

describe('FundingPanel', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('shows deposits/withdrawals and a deposit deep-link', async () => {
    mockFetch({ activities: MOCK_ACTIVITIES });
    renderPanel();
    // "Deposit funds" link is always rendered; wait for it to confirm mount.
    const link = await screen.findByRole('link', { name: /deposit funds/i });
    expect(link).toHaveAttribute('href', 'https://app.alpaca.markets/brokerage/funding/deposit/ach');
    expect(link).toHaveAttribute('target', '_blank');
    // Verify both rows are visible after data loads.
    await waitFor(() => {
      expect(screen.getByText('2026-06-30')).toBeInTheDocument();
      expect(screen.getByText('2026-06-29')).toBeInTheDocument();
    });
  });
});
