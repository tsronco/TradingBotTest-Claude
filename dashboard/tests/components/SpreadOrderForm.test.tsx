import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
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
    // Calls — used by call_credit / call_debit tests
    { symbol: 'AAL260529C00013000', strike_price: '13.0', expiration_date: '2026-05-29', type: 'call' as const },
    { symbol: 'AAL260529C00014000', strike_price: '14.0', expiration_date: '2026-05-29', type: 'call' as const },
    { symbol: 'AAL260529C00015000', strike_price: '15.0', expiration_date: '2026-05-29', type: 'call' as const },
  ],
  snapshots: {
    AAL260529P00012500: { latestQuote: { bp: 0.36, ap: 0.42 } },
    AAL260529P00011500: { latestQuote: { bp: 0.10, ap: 0.14 } },
    AAL260529P00010500: { latestQuote: { bp: 0.03, ap: 0.06 } },
    AAL260619P00012500: { latestQuote: { bp: 0.50, ap: 0.56 } },
    AAL260529C00013000: { latestQuote: { bp: 0.45, ap: 0.52 } },
    AAL260529C00014000: { latestQuote: { bp: 0.20, ap: 0.26 } },
    AAL260529C00015000: { latestQuote: { bp: 0.08, ap: 0.12 } },
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
      <MemoryRouter>
        <SpreadOrderForm {...defaults} {...props} />
      </MemoryRouter>
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

  it('renders account chips: manual_paper enabled; live disabled', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));

    // manual_paper is the only paper account since the 2026-06-29 sunset
    const manualBtn = screen.getByRole('button', { name: /manual_paper/i });
    expect(manualBtn).toBeInTheDocument();
    expect(manualBtn).not.toBeDisabled();

    // live chip stays disabled (real-money/bot-only)
    const liveBtn = screen.getByRole('button', { name: /\[live/i });
    expect(liveBtn).toBeDisabled();
    expect(liveBtn).toHaveAttribute('title', 'Live spreads are bot-managed only — not available for manual entry');
  });

  it('calls setAccount with manual_paper when the manual_paper chip is clicked', async () => {
    const setAccount = vi.fn();
    renderForm({ setAccount });
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.click(screen.getByRole('button', { name: /manual_paper/i }));
    expect(setAccount).toHaveBeenCalledWith('manual_paper');
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

  it('sends entry_grade as empty string when no grade chip is picked', async () => {
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
    // intentionally skip picking a grade chip
    fireEvent.change(screen.getByLabelText(/reasoning/i), {
      target: { value: 'No grade selected on purpose' },
    });
    fireEvent.click(screen.getByRole('button', { name: /review/i }));

    await waitFor(() => expect(onReview).toHaveBeenCalled());
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.entry_grade).toBe('');
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

  it('embeds an OptionsChain that shows premiums upfront after expiration is picked', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });

    // The chain block should render its "click bid / click ask" instructions
    await waitFor(() => {
      expect(screen.getByText(/click bid \(sell\)/i)).toBeInTheDocument();
    });

    // Bid and ask buttons from the chain should appear (with the prices from chainResponse).
    // strike 12.5 has bp=0.36, ap=0.42
    expect(screen.getByRole('button', { name: /bid 0\.36 — sell to open/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask 0\.42 — buy to open/i })).toBeInTheDocument();
  });

  it('clicking a bid in the embedded chain populates the SHORT strike', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });

    await waitFor(() => screen.getByRole('button', { name: /bid 0\.36 — sell to open/i }));
    fireEvent.click(screen.getByRole('button', { name: /bid 0\.36 — sell to open/i }));

    // Short dropdown should now show strike 12.5 selected
    const shortSelect = screen.getByLabelText(/short strike/i) as HTMLSelectElement;
    expect(shortSelect.value).toBe('12.5');
  });

  it('clicking an ask in the embedded chain populates the LONG strike (when below short)', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });

    // Set short via the dropdown first
    await waitFor(() => screen.getByLabelText(/short strike/i));
    fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });

    // Now click ask on strike 11.5 (below short) → populates long
    await waitFor(() => screen.getByRole('button', { name: /ask 0\.14 — buy to open/i }));
    fireEvent.click(screen.getByRole('button', { name: /ask 0\.14 — buy to open/i }));

    const longSelect = screen.getByLabelText(/long strike/i) as HTMLSelectElement;
    expect(longSelect.value).toBe('11.5');
  });

  it('shows DTE in the expiration dropdown options', async () => {
    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    const select = screen.getByLabelText(/expiration/i) as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.textContent ?? '');
    // At least one of the expiration options should carry a DTE suffix or "expired"
    expect(optionTexts.some((t) => /\(\d+ DTE\)|\(expired\)/.test(t))).toBe(true);
  });

  describe('spread_type generalization (all 4 verticals)', () => {
    function captureSubmit() {
      let captured: any = null;
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/settings/tags')) {
          return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
        }
        if (typeof url === 'string' && url.startsWith('/api/trades/preview')) {
          captured = JSON.parse(init?.body as string);
          return Promise.resolve(
            new Response(
              JSON.stringify({ exposure: 100, requires_totp: false, rule_warnings: [], draft: captured }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
      });
      return () => captured;
    }

    it('put_credit (default): negative limit_price (credit) + put legs + short ABOVE long', async () => {
      const getCaptured = captureSubmit();
      renderForm({ spreadType: 'put_credit' });
      await waitFor(() => screen.getByLabelText(/expiration/i));
      fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
      fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '12.5' } });
      fireEvent.change(screen.getByLabelText(/long strike/i), { target: { value: '11.5' } });
      fireEvent.click(screen.getByRole('button', { name: /^A$/ }));
      fireEvent.change(screen.getByLabelText(/reasoning/i), { target: { value: 'bullish put credit' } });
      fireEvent.click(screen.getByRole('button', { name: /review/i }));
      await waitFor(() => expect(getCaptured()).not.toBeNull());
      const c = getCaptured();
      expect(c.spread_type).toBe('put_credit');
      expect(c.limit_price).toBeLessThan(0); // credit
      expect(c.short_leg.strike).toBe(12.5);
      expect(c.long_leg.strike).toBe(11.5);
    });

    it('put_debit: positive limit_price (debit) + put legs + short BELOW long', async () => {
      const getCaptured = captureSubmit();
      renderForm({ spreadType: 'put_debit' });
      await waitFor(() => screen.getByLabelText(/expiration/i));
      fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
      // For put_debit the user BUYS the higher strike put (long) and SELLS the lower strike put (short)
      fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '11.5' } });
      // long-strike dropdown should now show strikes ABOVE 11.5 (cfg.shortVsLong = 'below' so long > short)
      const longSelect = screen.getByLabelText(/long strike/i) as HTMLSelectElement;
      const longValues = Array.from(longSelect.options).map((o) => o.value).filter((v) => v);
      expect(longValues).toContain('12.5');
      expect(longValues).not.toContain('10.5');
      fireEvent.change(longSelect, { target: { value: '12.5' } });
      fireEvent.click(screen.getByRole('button', { name: /^B\+$/ }));
      fireEvent.change(screen.getByLabelText(/reasoning/i), { target: { value: 'bearish put debit' } });
      fireEvent.click(screen.getByRole('button', { name: /review/i }));
      await waitFor(() => expect(getCaptured()).not.toBeNull());
      const c = getCaptured();
      expect(c.spread_type).toBe('put_debit');
      expect(c.limit_price).toBeGreaterThan(0); // debit
      expect(c.short_leg.strike).toBe(11.5);
      expect(c.long_leg.strike).toBe(12.5);
    });

    it('call_credit: negative limit_price (credit) + call legs + short BELOW long', async () => {
      const getCaptured = captureSubmit();
      renderForm({ spreadType: 'call_credit' });
      await waitFor(() => screen.getByLabelText(/expiration/i));
      fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
      fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '13' } });
      const longSelect = screen.getByLabelText(/long strike/i) as HTMLSelectElement;
      const longValues = Array.from(longSelect.options).map((o) => o.value).filter((v) => v);
      // shortVsLong='below' → long must be > short
      expect(longValues).toContain('14');
      expect(longValues).toContain('15');
      fireEvent.change(longSelect, { target: { value: '14' } });
      fireEvent.click(screen.getByRole('button', { name: /^B$/ }));
      fireEvent.change(screen.getByLabelText(/reasoning/i), { target: { value: 'bearish call credit' } });
      fireEvent.click(screen.getByRole('button', { name: /review/i }));
      await waitFor(() => expect(getCaptured()).not.toBeNull());
      const c = getCaptured();
      expect(c.spread_type).toBe('call_credit');
      expect(c.limit_price).toBeLessThan(0); // credit
      expect(c.short_leg.strike).toBe(13);
      expect(c.long_leg.strike).toBe(14);
    });

    it('call_debit: positive limit_price (debit) + call legs + short ABOVE long', async () => {
      const getCaptured = captureSubmit();
      renderForm({ spreadType: 'call_debit' });
      await waitFor(() => screen.getByLabelText(/expiration/i));
      fireEvent.change(screen.getByLabelText(/expiration/i), { target: { value: '2026-05-29' } });
      fireEvent.change(screen.getByLabelText(/short strike/i), { target: { value: '15' } });
      const longSelect = screen.getByLabelText(/long strike/i) as HTMLSelectElement;
      const longValues = Array.from(longSelect.options).map((o) => o.value).filter((v) => v);
      // shortVsLong='above' → long must be < short
      expect(longValues).toContain('13');
      expect(longValues).toContain('14');
      fireEvent.change(longSelect, { target: { value: '13' } });
      fireEvent.click(screen.getByRole('button', { name: /^B-$/ }));
      fireEvent.change(screen.getByLabelText(/reasoning/i), { target: { value: 'bullish call debit' } });
      fireEvent.click(screen.getByRole('button', { name: /review/i }));
      await waitFor(() => expect(getCaptured()).not.toBeNull());
      const c = getCaptured();
      expect(c.spread_type).toBe('call_debit');
      expect(c.limit_price).toBeGreaterThan(0); // debit
      expect(c.short_leg.strike).toBe(15);
      expect(c.long_leg.strike).toBe(13);
    });

    it('renders the "Bot will track but not auto-close" banner for non-managed types', async () => {
      // put_debit on manual_paper is not bot-managed (only put_credit on manual is)
      renderForm({ spreadType: 'put_debit' });
      await waitFor(() => screen.getByLabelText(/expiration/i));
      expect(screen.getByText(/bot will track this/i)).toBeInTheDocument();
    });

    it('hides the bot-management banner for put_credit on manual_paper', async () => {
      renderForm({ spreadType: 'put_credit', account: 'manual_paper' });
      await waitFor(() => screen.getByLabelText(/expiration/i));
      expect(screen.queryByText(/bot will track this/i)).toBeNull();
    });
  });

  // Regression: picking an expiration re-fetches the chain filtered to that
  // expiration. Before the fix, that overwrote the full chain in state and
  // collapsed the expiration dropdown to just the picked date — only a page
  // reload restored the list. Now the dropdown stays populated.
  it('keeps all expirations in the dropdown after picking one (no shrink-after-pick bug)', async () => {
    // Override fetch: the expiration-scoped refetch returns ONLY contracts
    // matching the requested expiration (mimics the real backend).
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/settings/tags')) {
        return Promise.resolve(new Response(JSON.stringify(tagsResponse), { status: 200 }));
      }
      const match = typeof url === 'string' ? url.match(/expiration=([^&]+)/) : null;
      if (match) {
        const exp = match[1];
        const filtered = {
          contracts: chainResponse.contracts.filter((c) => c.expiration_date === exp),
          snapshots: chainResponse.snapshots,
        };
        return Promise.resolve(new Response(JSON.stringify(filtered), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(chainResponse), { status: 200 }));
    });

    renderForm();
    await waitFor(() => screen.getByLabelText(/expiration/i));
    const select = screen.getByLabelText(/expiration/i) as HTMLSelectElement;

    // Before pick: both expirations available (3 options including "pick…")
    expect(select.options.length).toBe(3);

    // Pick the first real expiration → triggers filtered refetch
    fireEvent.change(select, { target: { value: '2026-05-29' } });

    // After pick + refetch: dropdown must still list BOTH expirations
    await waitFor(() => {
      const refetched = screen.getByLabelText(/expiration/i) as HTMLSelectElement;
      expect(refetched.options.length).toBe(3);
    });
  });
});
