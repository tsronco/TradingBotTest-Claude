import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RefreshButton from '../../src/components/trades/RefreshButton';

// Mock the api helper so we don't hit a real endpoint.
vi.mock('../../src/lib/api', () => ({
  api: vi.fn(),
}));

import { api } from '../../src/lib/api';

function renderWith() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RefreshButton />
    </QueryClientProvider>,
  );
}

describe('RefreshButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders in default ready state', () => {
    renderWith();
    expect(screen.getByRole('button')).toHaveTextContent(/refresh/i);
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('shows "nothing to update" when result has no changes', async () => {
    (api as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      graded: 0,
      synced: 0,
      remaining_open: 3,
      assignments_spawned: 0,
      assignments_skipped: 0,
    });
    renderWith();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getByText(/nothing to update · 3 open/i)).toBeInTheDocument();
    });
  });

  it('summarizes synced/closed/assigned counts when changes happen', async () => {
    (api as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      graded: 2,
      synced: 1,
      remaining_open: 5,
      assignments_spawned: 1,
      assignments_skipped: 0,
    });
    renderWith();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(
        screen.getByText(/1 synced · 2 closed · 1 assigned · 5 still open/i),
      ).toBeInTheDocument();
    });
  });

  it('enters cooldown after success and disables button', async () => {
    (api as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      graded: 0,
      synced: 0,
      remaining_open: 0,
      assignments_spawned: 0,
      assignments_skipped: 0,
    });
    renderWith();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getByRole('button')).toBeDisabled();
    });
    expect(screen.getByRole('button')).toHaveTextContent(/refresh · 15s/i);
  });

  it('shows error message when the request fails', async () => {
    (api as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    renderWith();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getByText(/error: boom/i)).toBeInTheDocument();
    });
    // No cooldown on failure — button should be clickable again
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('does not call the API again when clicked during cooldown', async () => {
    (api as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      graded: 0,
      synced: 0,
      remaining_open: 0,
      assignments_spawned: 0,
      assignments_skipped: 0,
    });
    renderWith();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getByRole('button')).toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button')); // ignored
    expect(api).toHaveBeenCalledTimes(1);
  });
});
