// dashboard/tests/components/ThresholdsTab.test.tsx
//
// Asserts that all 7 account threshold rows render — including the 3 SM accounts
// that were missing before the security fix. A missing SM row means Tim can't see
// or set the threshold, and a POST from the old 4-key form would drop SM keys.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThresholdsTab } from '../../src/components/settings/ThresholdsTab';

// Mock the api helper to return a stable snapshot of all 7 thresholds
vi.mock('../../src/lib/api', () => ({
  api: vi.fn().mockResolvedValue({
    thresholds: {
      conservative_paper: 5000,
      aggressive_paper: 10000,
      manual_paper: 2500,
      live: 1500,
      sm500_paper: 2500,
      sm1000_paper: 2500,
      sm2000_paper: 2500,
    },
  }),
}));

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ThresholdsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders all 7 account threshold rows', async () => {
    withQuery(<ThresholdsTab />);
    // Rows are keyed by account id — check all 7 labels appear
    expect(await screen.findByText(/conservative_paper/)).toBeInTheDocument();
    expect(screen.getByText(/aggressive_paper/)).toBeInTheDocument();
    expect(screen.getByText(/manual_paper/)).toBeInTheDocument();
    expect(screen.getByText(/live/)).toBeInTheDocument();
    // SM rows — these are the ones that were missing before the fix
    expect(screen.getByText(/sm500_paper/)).toBeInTheDocument();
    expect(screen.getByText(/sm1000_paper/)).toBeInTheDocument();
    expect(screen.getByText(/sm2000_paper/)).toBeInTheDocument();
  });

  it('renders exactly 7 threshold input fields', async () => {
    withQuery(<ThresholdsTab />);
    // Wait for the data to load (the component shows "loading…" until then)
    await screen.findByText(/conservative_paper/);
    const inputs = screen.getAllByRole('spinbutton');
    expect(inputs).toHaveLength(7);
  });
});
