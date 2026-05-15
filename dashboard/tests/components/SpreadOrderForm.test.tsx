import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpreadOrderForm } from '../../src/components/order/SpreadOrderForm';

// Matches the real /api/alpaca/chain response shape:
//   { contracts: [{ symbol, expiration_date, strike_price (string), type }], snapshots: {...} }
// The component derives the expiration dropdown from contracts itself, and pulls
// bid/ask from snapshots[symbol].latestQuote.{bp,ap}.
const chainResponse = {
  contracts: [
    { symbol: 'AAL260529P00012500', strike_price: '12.5', expiration_date: '2026-05-29', type: 'put' as const },
    { symbol: 'AAL260529P00011500', strike_price: '11.5', expiration_date: '2026-05-29', type: 'put' as const },
    { symbol: 'AAL260529P00010500', strike_price: '10.5', expiration_date: '2026-05-29', type: 'put' as const },
    { symbol: 'AAL260619P00012500', strike_price: '12.5', expiration_date: '2026-06-19', type: 'put' as const },
  ],
  snapshots: {
    AAL260529P00012500: { latestQuote: { bp: 0.36, ap: 0.42 } },
    AAL260529P00011500: { latestQuote: { bp: 0.10, ap: 0.14 } },
    AAL260529P00010500: { latestQuote: { bp: 0.03, ap: 0.06 } },
    AAL260619P00012500: { latestQuote: { bp: 0.50, ap: 0.56 } },
  },
};

// TagPicker calls /api/settings/tags via useQuery — mock it to return a list so
// the component can render without a live server.
const tagsResponse = { tags: ['bullish', 'wheel', 'test-tag'] };

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderForm(props: Partial<Parameters<typeof SpreadOrderForm>[0]> = {}) {
  const qc = makeQc();
  const defaults = {
    symbol: 'AAL',
    account: 'manual_paper' as const,
    setAccount: vi.fn(),
    onReview: vi.fn(),
  };
  return render(
    <QueryClientProvider client={qc}>
      <SpreadOrderForm {...defaults} {...props} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/settings/tags')) {
      return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
  });
});

describe('SpreadOrderForm', () => {
  it('renders expiration + both strike dropdowns + grade chips + reasoning', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    expect(screen.getByLabelText(/expiration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/short strike/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/long strike/i)).toBeInTheDocument();
    // grade is now a chip row (GradePicker) — no label element; verify chips render
    expect(screen.getByRole('button', { name: /^A\+$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^B$/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/reasoning/i)).toBeInTheDocument();
  });

  it('renders account chips for conservative_paper, aggressive_paper, manual_paper and a disabled live chip', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    expect(screen.getByRole('button', { name: /conservative_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aggressive_paper/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manual_paper/i })).toBeInTheDocument();
    const liveBtn = screen.getByRole('button', { name: /\[live/i });
    expect(liveBtn).toBeDisabled();
    expect(liveBtn).toHaveAttribute('title', 'Live spreads are bot-managed');
  });

  it('calls setAccount when an account chip is clicked', async () => {
    const setAccount = vi.fn();
    renderForm({ setAccount });
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.click(screen.getByRole('button', { name: /conservative_paper/i }));
    expect(setAccount).toHaveBeenCalledWith('conservative_paper');
    fireEvent.click(screen.getByRole('button', { name: /aggressive_paper/i }));
    expect(setAccount).toHaveBeenCalledWith('aggressive_paper');
  });

  it('filters long-strike options to strikes below the selected short strike', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
    fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
    const longSelect = screen.getByLabelText(/long strike/i) as HTMLSelectElement;
    const longOptions = Array.from(longSelect.options)
      .map((o) => o.value)
      .filter((v) => v);
    expect(longOptions).toContain('11.5');
    expect(longOptions).toContain('10.5');
    expect(longOptions).not.toContain('12.5');
  });

  it('submits a FLAT spread payload (no {action, payload} wrapper) so the server-side isSpreadPayload check works', async () => {
    const onReview = vi.fn();
    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/settings/tags')) {
        return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
      }
      if (typeof url === 'string' && url.startsWith('/api/trades/preview')) {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(
            JSON.stringify({ exposure: 75, requires_totp: false, rule_warnings: [], draft: capturedBody }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
    });

    renderForm({ onReview });
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
    fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText(/long strike/i), { target: { value: '11.5' } });
    // grade is now chips — click the B+ chip
    fireEvent.click(screen.getByRole('button', { name: /^B\+$/ }));
    fireEvent.change(screen.getByLabelText(/reasoning/i), {
      target: { value: 'Bullish AAL above $12.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: /review/i }));

    await waitFor(() => expect(onReview).toHaveBeenCalled());

    expect(capturedBody).not.toBeNull();
    // The body must be FLAT — not wrapped in {action, payload}
    expect(capturedBody.kind).toBe('spread');
    expect(capturedBody.action).toBeUndefined();
    expect(capturedBody.payload).toBeUndefined();
    expect(capturedBody.symbol).toBe('AAL');
    expect(capturedBody.short_leg.strike).toBe(12.5);
    expect(capturedBody.long_leg.strike).toBe(11.5);
    expect(capturedBody.limit_price).toBeLessThan(0); // negative = credit
    // entry_grade must reflect the chip selection (was formerly set via select)
    expect(capturedBody.entry_grade).toBe('B+');
    // tags field must be present in the payload (new in Phase 1)
    expect(Array.isArray(capturedBody.tags)).toBe(true);
  });

  it('includes selected tags in the spread payload', async () => {
    const onReview = vi.fn();
    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/settings/tags')) {
        return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
      }
      if (typeof url === 'string' && url.startsWith('/api/trades/preview')) {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(
            JSON.stringify({ exposure: 75, requires_totp: false, rule_warnings: [], draft: capturedBody }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
    });

    renderForm({ onReview });
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
    fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText(/long strike/i), { target: { value: '11.5' } });
    fireEvent.click(screen.getByRole('button', { name: /^A$/ }));
    fireEvent.change(screen.getByLabelText(/reasoning/i), {
      target: { value: 'Tagged spread entry' },
    });

    // Wait for tag chips to appear then click one
    await waitFor(() => screen.getByRole('button', { name: /^bullish$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^bullish$/ }));

    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    await waitFor(() => expect(onReview).toHaveBeenCalled());

    expect(capturedBody.tags).toContain('bullish');
  });

  it('submits the spread payload to /api/trades/preview when Review is clicked', async () => {
    const onReview = vi.fn();
    renderForm({ onReview });
    await waitFor(() => screen.getByLabelText(/expiration/i));

    // Swap the fetch mock now to return chain again on any subsequent chain calls,
    // and the preview payload on /api/trades/preview.
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/settings/tags')) {
        return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
      }
      if (typeof url === 'string' && url.startsWith('/api/trades/preview')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ exposure: 75, requires_totp: false, rule_warnings: [], draft: {} }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
    });

    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
    fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText(/long strike/i), { target: { value: '11.5' } });
    // grade is now chips — click the B+ chip
    fireEvent.click(screen.getByRole('button', { name: /^B\+$/ }));
    fireEvent.change(screen.getByLabelText(/reasoning/i), {
      target: { value: 'Bullish AAL above $12.50' },
    });

    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    await waitFor(() => expect(onReview).toHaveBeenCalled());
    expect(onReview.mock.calls[0][0].exposure).toBe(75);
  });
});
