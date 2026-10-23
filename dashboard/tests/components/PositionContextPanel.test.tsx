import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PositionContextPanel from '../../src/components/lookup/PositionContextPanel';

// A BAC put credit spread (Bull Put Spread): short the 49 put, long the 48 put.
const BAC_SPREAD = [
  {
    symbol: 'BAC261120P00048000', asset_class: 'us_option', qty: '1',
    avg_entry_price: '0.48', current_price: '0.43', market_value: '43',
    unrealized_pl: '-5', unrealized_plpc: '-0.1042',
  },
  {
    symbol: 'BAC261120P00049000', asset_class: 'us_option', qty: '-1',
    avg_entry_price: '0.71', current_price: '0.74', market_value: '-74',
    unrealized_pl: '-3', unrealized_plpc: '-0.0423',
  },
];

const BAC_LONG_CALL = [{
  symbol: 'BAC261120C00055000', asset_class: 'us_option', qty: '2',
  avg_entry_price: '1.20', current_price: '1.40', market_value: '280',
  unrealized_pl: '40', unrealized_plpc: '0.1667',
}];

// Route /api/alpaca/positions?mode=X to a per-mode position list.
function mockPositionsByMode(byMode: Record<string, unknown[]>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const mode = new URL(url, 'http://x').searchParams.get('mode') ?? '';
    const positions = byMode[mode] ?? [];
    return Promise.resolve(new Response(JSON.stringify({ positions }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }) as unknown as typeof fetch;
}

function renderPanel(symbol: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PositionContextPanel symbol={symbol} />
    </QueryClientProvider>,
  );
}

describe('PositionContextPanel', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('surfaces an options spread on the underlying (was the "you don\'t hold BAC" bug)', async () => {
    mockPositionsByMode({ live: BAC_SPREAD, manual: [], agent: [] });
    renderPanel('BAC');
    // The spread is recognized and named — NOT reported as un-held.
    expect(await screen.findByText('Bull Put Spread')).toBeTruthy();
    expect(screen.queryByText(/you don't hold BAC/)).toBeNull();
    // Defined-risk numbers render (net credit $23, max loss -$77 for the 48/49).
    expect(screen.getByText(/credit \$23/)).toBeTruthy();
    expect(screen.getByText(/48\/49 PUT/)).toBeTruthy();
  });

  it('surfaces a lone long option on the underlying with a LONG badge', async () => {
    mockPositionsByMode({ live: [], manual: BAC_LONG_CALL, agent: [] });
    renderPanel('BAC');
    expect(await screen.findByText('LONG')).toBeTruthy();
    expect(screen.getByText(/CALL \$55/)).toBeTruthy();
    expect(screen.queryByText(/you don't hold BAC/)).toBeNull();
  });

  it('still reports "you don\'t hold" when there is no stock OR option position', async () => {
    mockPositionsByMode({ live: [], manual: [], agent: [] });
    renderPanel('BAC');
    expect(await screen.findByText(/you don't hold BAC/)).toBeTruthy();
  });

  it('does not match an option on a DIFFERENT underlying', async () => {
    // Holding an AAPL option must not make BAC look held.
    mockPositionsByMode({
      live: [{
        symbol: 'AAPL261120P00180000', asset_class: 'us_option', qty: '-1',
        avg_entry_price: '2.00', current_price: '2.00', market_value: '-200',
        unrealized_pl: '0', unrealized_plpc: '0',
      }],
      manual: [], agent: [],
    });
    renderPanel('BAC');
    expect(await screen.findByText(/you don't hold BAC/)).toBeTruthy();
  });
});
