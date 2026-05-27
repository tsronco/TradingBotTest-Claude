import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WatchlistTicker from '../../src/components/layout/WatchlistTicker';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WatchlistTicker />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFetch(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const key = Object.keys(routes).find((k) => typeof url === 'string' && url.includes(k));
    const body = key ? routes[key] : {};
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  }) as unknown as typeof fetch;
}

describe('WatchlistTicker', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('renders nothing while the watchlist is loading', () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const { container } = setup();
    expect(container.querySelector('.ticker-track')).toBeNull();
  });

  it('renders nothing when the watchlist is empty', async () => {
    mockFetch({ '/api/kv/watchlist': { watchlist: [] } });
    const { container } = setup();
    await waitFor(() => {
      expect(container.querySelector('.ticker-track')).toBeNull();
    });
  });

  it('renders each symbol twice (duplicated for seamless looping)', async () => {
    mockFetch({
      '/api/kv/watchlist': { watchlist: ['WMT', 'NVDA'] },
      '/api/alpaca/quote': { snapshot: { latestTrade: { p: 100 }, prevDailyBar: { c: 95 } } },
      '/api/alpaca/bars': { bars: [{ t: 'a', c: 90 }, { t: 'b', c: 100 }] },
    });
    setup();
    await waitFor(() => {
      // Each symbol appears 2× because the marquee renders the list twice.
      expect(screen.getAllByText('WMT')).toHaveLength(2);
      expect(screen.getAllByText('NVDA')).toHaveLength(2);
    });
  });

  it('marquee duration scales with symbol count (longer list, longer cycle)', async () => {
    mockFetch({
      '/api/kv/watchlist': { watchlist: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
      '/api/alpaca/quote': { snapshot: {} },
      '/api/alpaca/bars': { bars: [] },
    });
    const { container } = setup();
    await waitFor(() => {
      const track = container.querySelector('.ticker-track') as HTMLElement | null;
      expect(track).not.toBeNull();
      const dur = track!.style.animationDuration;
      // 8 symbols * 200px / 45px/s ≈ 35.5s — comfortably above the 20s floor.
      const seconds = parseFloat(dur);
      expect(seconds).toBeGreaterThan(20);
    });
  });
});
