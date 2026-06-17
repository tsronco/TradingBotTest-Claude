// dashboard/tests/components/ConfirmModal-idempotency.test.tsx
//
// D2 — ConfirmModal idempotency: stable idempotency key per modal instance,
// button disabled synchronously before any await, key reused on re-click.
//
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmModal } from '../../src/components/order/ConfirmModal';

// ----- mocks -----
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const apiMock = vi.fn();
vi.mock('../../src/lib/api', () => ({
  api: (...args: any[]) => apiMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  apiMock.mockReset();
});

function buildPreview(overrides: any = {}) {
  return {
    exposure: 1000,
    requires_totp: false,
    rule_warnings: [],
    draft: {
      account: 'conservative_paper',
      asset_class: 'stock',
      symbol: 'TSLA',
      side: 'buy',
      qty: 10,
      order_type: 'market',
      tif: 'day',
      entry_grade: 'B',
      entry_reasoning: 'test trade',
    },
    ...overrides,
  };
}

function withRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ConfirmModal — D2 idempotency', () => {
  it('includes an idempotency_key in the submit payload', async () => {
    apiMock.mockResolvedValue({ id: 'T-2026-06-17-001' });
    withRouter(<ConfirmModal preview={buildPreview()} onClose={() => {}} />);

    const placeBtn = screen.getByRole('button', { name: /place order/i });
    fireEvent.click(placeBtn);

    await waitFor(() => expect(apiMock).toHaveBeenCalled());

    const [, init] = apiMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(typeof body.idempotency_key).toBe('string');
    expect(body.idempotency_key.length).toBeGreaterThan(0);
  });

  it('reuses the SAME idempotency_key across two place() calls on the same modal instance', async () => {
    // First call: simulate a network error so the button re-enables
    apiMock
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ id: 'T-2026-06-17-002' });

    withRouter(<ConfirmModal preview={buildPreview()} onClose={() => {}} />);

    const placeBtn = screen.getByRole('button', { name: /place order/i });

    // First click — network error, button re-enables
    fireEvent.click(placeBtn);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    // Wait for the error state (button re-enables)
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /place order/i });
      expect(btn).not.toBeDisabled();
    });

    // Second click — same modal, should reuse the same key
    fireEvent.click(placeBtn);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));

    const key1 = JSON.parse(apiMock.mock.calls[0][1].body).idempotency_key;
    const key2 = JSON.parse(apiMock.mock.calls[1][1].body).idempotency_key;

    expect(key1).toBe(key2);
    expect(typeof key1).toBe('string');
    expect(key1.length).toBeGreaterThan(0);
  });

  it('button is disabled synchronously (before API resolves) when place() fires', async () => {
    // Use a promise we control so we can inspect the button state MID-call
    let resolveApi!: (v: any) => void;
    apiMock.mockReturnValueOnce(new Promise((r) => { resolveApi = r; }));

    withRouter(<ConfirmModal preview={buildPreview()} onClose={() => {}} />);

    const placeBtn = screen.getByRole('button', { name: /place order/i });
    expect(placeBtn).not.toBeDisabled(); // not yet submitting

    fireEvent.click(placeBtn);

    // After the synchronous part of the click handler completes the button
    // must be disabled before any await inside place() has resolved
    await waitFor(() => expect(placeBtn).toBeDisabled());

    // Clean up the dangling promise
    resolveApi({ id: 'T-2026-06-17-003' });
  });
});
