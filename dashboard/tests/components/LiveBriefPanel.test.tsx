import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveBriefPanel from '../../src/components/account/LiveBriefPanel';
import { easternDateKey, type LiveBriefState } from '../../src/lib/live-brief';

const TODAY = easternDateKey(new Date());

const IDEA = {
  symbol: 'F', structure: 'long stock', legs: 'buy 3 F @ $11.20 limit', direction: 'bullish' as const,
  why: 'above SMA20, IV low', getting_paid: 'n/a — shares', max_loss_usd: 33.6,
  capital_required_usd: 33.6, invalidation: 'wrong if F closes below $10.50 before Sep 30',
  key_risk: 'auto tariffs headline', fits_account: true, confidence: 3,
};

function state(over: Partial<NonNullable<LiveBriefState['last_brief']>> = {}): LiveBriefState {
  return {
    last_brief: {
      date: TODAY, generated_at: '2026-09-10T13:40:12Z', model: 'claude-opus-5',
      account: { equity: 150.72, cash: 44.61, options_buying_power: 0 },
      market_read: 'quiet open, small caps bid', ideas: [IDEA],
      held: [{ symbol: 'WMT', watch: '$113 GTC sell resting; share is reserved' }],
      no_trade_reason: '', refused: false, ...over,
    },
    _meta: { runs: 1 },
  };
}

function mockFetch(payload: LiveBriefState | null) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ key: 'bot:live:brief', payload, lastUpdate: null }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LiveBriefPanel /></QueryClientProvider>);
}

describe('LiveBriefPanel', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('shows the empty state before the first brief lands', async () => {
    mockFetch(null);
    renderPanel();
    expect(await screen.findByText(/no brief yet/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only · ideas, not signals/i)).toBeInTheDocument();
  });

  it("renders today's brief: read, idea row, fit verdict, held line, no STALE tag", async () => {
    mockFetch(state());
    renderPanel();
    expect(await screen.findByText('quiet open, small caps bid')).toBeInTheDocument();
    expect(screen.getByText('F')).toBeInTheDocument();
    expect(screen.getByText('long stock')).toBeInTheDocument();
    expect(screen.getByText('✓ fits')).toBeInTheDocument();
    expect(screen.getByText('WMT')).toBeInTheDocument();
    expect(screen.getByText(/\$113 GTC sell resting/)).toBeInTheDocument();
    expect(screen.queryByText('STALE')).not.toBeInTheDocument();
    // Details are collapsed until the row is expanded.
    expect(screen.queryByText(/wrong if F closes below/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /long stock/ }));
    expect(screen.getByText(/wrong if F closes below \$10\.50/)).toBeInTheDocument();
    expect(screen.getByText(/auto tariffs headline/)).toBeInTheDocument();
  });

  it('marks a previous-session brief STALE', async () => {
    mockFetch(state({ date: '2026-01-02' }));
    renderPanel();
    expect(await screen.findByText('STALE')).toBeInTheDocument();
  });

  it('shows the no-trade reason when nothing fits', async () => {
    mockFetch(state({ ideas: [], no_trade_reason: 'Needs ~$1,100 of options BP; account has $0.' }));
    renderPanel();
    expect(await screen.findByText(/no actionable trade today/i)).toBeInTheDocument();
    expect(screen.getByText(/Needs ~\$1,100 of options BP/)).toBeInTheDocument();
  });

  it('flags an idea the account cannot place with the capital it needs', async () => {
    mockFetch(state({ ideas: [{ ...IDEA, symbol: 'NVDA', fits_account: false, capital_required_usd: 1100 }],
                      no_trade_reason: 'Fund the account to ~$1,100 for this.' }));
    renderPanel();
    expect(await screen.findByText(/✗ needs \$1,100/)).toBeInTheDocument();
    expect(screen.getByText(/Fund the account to ~\$1,100/)).toBeInTheDocument();
  });
});
