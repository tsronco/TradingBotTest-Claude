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

function renderBtn(account?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RefreshButton account={account} />
    </QueryClientProvider>,
  );
}

describe('RefreshButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders in default ready state', () => {
    renderWith();
    expect(screen.getByRole('button', { name: /refresh/i })).toHaveTextContent(/refresh/i);
    expect(screen.getByRole('button', { name: /refresh/i })).not.toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: /refresh/i })).toHaveTextContent(/refresh · 15s/i);
  });

  it('shows error message when the request fails', async () => {
    (api as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    renderWith();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => {
      expect(screen.getByText(/error: boom/i)).toBeInTheDocument();
    });
    // No cooldown on failure — button should be clickable again
    expect(screen.getByRole('button', { name: /refresh/i })).not.toBeDisabled();
  });

  it('drain button calls the refresh endpoint in drain mode', async () => {
    (api as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, drain: true, graded: 40, synced: 0, remaining_open: 12,
      assignments_spawned: 0, assignments_skipped: 0,
    });
    renderWith();
    fireEvent.click(screen.getByRole('button', { name: /drain backlog/i }));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/trades/refresh?mode=drain', { method: 'POST' });
    });
    expect(screen.getByText(/40 closed · 12 still open/i)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i })); // ignored
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('RefreshButton account scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, graded: 0, synced: 0, remaining_open: 2,
      assignments_spawned: 0, assignments_skipped: 0,
    });
  });

  it('sends ?account when an account is selected and labels the count', async () => {
    renderBtn('manual_paper');
    fireEvent.click(screen.getByText('[↻ refresh]'));
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/api/trades/refresh?account=manual_paper', { method: 'POST' });
    await waitFor(() => expect(screen.getByText(/· manual/)).toBeTruthy());
  });

  it('omits ?account when no account is selected (global)', async () => {
    renderBtn(undefined);
    fireEvent.click(screen.getByText('[↻ refresh]'));
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/api/trades/refresh', { method: 'POST' });
  });

  it('scopes the drain button too', async () => {
    renderBtn('sm500_paper');
    fireEvent.click(screen.getByText('[drain backlog]'));
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('/api/trades/refresh?mode=drain&account=sm500_paper', { method: 'POST' });
  });
});
