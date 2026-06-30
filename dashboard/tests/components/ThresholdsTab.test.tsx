// dashboard/tests/components/ThresholdsTab.test.tsx
//
// Two accounts since the 2026-06-29 sunset: manual (paper) + live (real money).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThresholdsTab } from '../../src/components/settings/ThresholdsTab';

// Mock the api helper to return a stable snapshot of both thresholds
vi.mock('../../src/lib/api', () => ({
  api: vi.fn().mockResolvedValue({
    thresholds: {
      manual_paper: 2500,
      live: 1500,
    },
  }),
}));

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ThresholdsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders both account threshold rows', async () => {
    withQuery(<ThresholdsTab />);
    expect(await screen.findByText(/manual_paper/)).toBeInTheDocument();
    expect(screen.getByText(/live/)).toBeInTheDocument();
  });

  it('renders exactly 2 threshold input fields', async () => {
    withQuery(<ThresholdsTab />);
    await screen.findByText(/manual_paper/);
    const inputs = screen.getAllByRole('spinbutton');
    expect(inputs).toHaveLength(2);
  });
});
