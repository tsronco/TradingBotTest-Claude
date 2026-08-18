// dashboard/tests/components/Agent.test.tsx
//
// The /agent page — the read-only window onto the autonomous Claude-driven
// paper account. The fixture mirrors the real agent_state.json shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Agent, { legLine, underlyingsOf } from '../../src/routes/Agent';

const AGENT_STATE = {
  _meta: {
    created_at: '2026-08-13T20:42:57Z',
    cycle_count: 18,
    last_cycle_at: '2026-08-17T20:12:45Z',
    last_market_read: 'CVS is 93.99, essentially flat vs my 94.19 entry.',
    last_cycle_outcome: {
      opened: [],
      closed: [],
      rejected: [
        { legs: 'sell 1 XYZ260828P00100000', source: 'alpaca', reason: 'Alpaca 403: naked short not permitted' },
      ],
    },
    seed_capital: 2000,
  },
  positions: {
    'order-1': {
      opened_at: '2026-08-17T18:12:45Z',
      legs: [
        { asset: 'option', qty: 3, side: 'buy', symbol: 'CVS260925C00096000' },
        { asset: 'option', qty: 3, side: 'sell', symbol: 'CVS260925C00103000' },
      ],
      thesis: {
        thesis: 'CVS carries the lowest implied vol in my shortlist.',
        invalidation: 'Wrong if CVS closes below $90.00.',
        key_risk: 'CVS goes flat or drifts down.',
        confidence: 3,
      },
      fill: { fill_available: true, intended_net_credit: -2.5, actual_net_credit: -2.41, slippage: 0.09 },
      last_snapshot: { unrealized_pl: -151.5, pnl_basis: "mid-based, qty-scaled to this order's share" },
    },
  },
  closed: [
    {
      opened_at: '2026-08-14T18:12:55Z',
      closed_at: '2026-08-17T16:12:41Z',
      legs: [
        { asset: 'option', qty: 1, side: 'sell', symbol: 'DIS260828P00103000' },
        { asset: 'option', qty: 1, side: 'buy', symbol: 'DIS260828P00100000' },
      ],
      thesis: { thesis: 'DIS holds above 103 into expiry.', confidence: 3 },
      outcome: { days_held: 2.9, estimated_pnl: -57 },
      grade: {
        graded: true,
        process_grade: 'B',
        outcome_grade: 'D',
        loss_type: 'blind_spot',
        lesson: 'A low-delta credit spread can still bleed from ordinary IV noise.',
      },
    },
  ],
};

vi.mock('../../src/lib/api', () => ({
  api: vi.fn((url: string) => {
    if (url.includes('/api/kv/bot-state')) {
      return Promise.resolve({
        key: 'bot:agent:state',
        payload: AGENT_STATE,
        lastUpdate: '2026-08-17T20:13:00Z',
      });
    }
    if (url.includes('/api/alpaca/account')) {
      return Promise.resolve({ account: { equity: '2150', last_equity: '2100', cash: '1221' } });
    }
    return Promise.resolve({});
  }),
}));

function renderAgent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Agent /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Agent page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the account heading and read-only framing', async () => {
    renderAgent();
    expect(await screen.findByRole('heading', { name: /agent/i })).toBeInTheDocument();
    expect(screen.getByText(/read-only here/i)).toBeInTheDocument();
  });

  it("shows the agent's own market read", async () => {
    renderAgent();
    expect(await screen.findByText(/CVS is 93\.99/)).toBeInTheDocument();
  });

  it('surfaces a rejected order with its reason — the highest-signal cycle event', async () => {
    renderAgent();
    expect(await screen.findByText(/rejected/)).toBeInTheDocument();
    expect(screen.getByText(/naked short not permitted/)).toBeInTheDocument();
  });

  it('lists the open position with its underlying', async () => {
    renderAgent();
    expect(await screen.findByText(/OPEN POSITIONS \[1\]/)).toBeInTheDocument();
    expect(screen.getAllByText('CVS').length).toBeGreaterThan(0);
  });

  it('reveals the entry thesis when a position is expanded', async () => {
    renderAgent();
    const row = await screen.findByText('CVS');
    expect(screen.queryByText(/lowest implied vol/)).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText(/lowest implied vol/)).toBeInTheDocument();
    expect(screen.getByText(/Wrong if CVS closes below/)).toBeInTheDocument();
  });

  it('renders the lesson card with process and outcome graded separately', async () => {
    renderAgent();
    expect(await screen.findByText(/CLOSED — LESSONS \[1\]/)).toBeInTheDocument();
    expect(screen.getByText(/can still bleed from ordinary IV noise/)).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();   // process
    expect(screen.getByText('D')).toBeInTheDocument();   // outcome
    expect(screen.getByText('BLIND SPOT')).toBeInTheDocument();
  });

  it('renders the confidence calibration axis with all five buckets', async () => {
    renderAgent();
    expect(await screen.findByText(/CONFIDENCE CALIBRATION/)).toBeInTheDocument();
    expect(screen.getByText('★')).toBeInTheDocument();
    expect(screen.getByText('★★★★★')).toBeInTheDocument();
  });

  it('explains what to check when no state has been pushed yet', async () => {
    const { api } = await import('../../src/lib/api');
    (api as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.includes('/api/kv/bot-state')
        ? Promise.resolve({ key: 'bot:agent:state', payload: null, lastUpdate: null })
        : Promise.resolve({ account: { equity: '2000', last_equity: '2000', cash: '2000' } }),
    );
    renderAgent();
    expect(await screen.findByText(/no agent state yet/i)).toBeInTheDocument();
    expect(screen.getByText(/BOT_PUSH_TOKEN/)).toBeInTheDocument();
  });
});

describe('Agent page pure helpers', () => {
  it('legLine renders each leg as side/qty/symbol', () => {
    expect(legLine([{ side: 'sell', qty: 1, symbol: 'DIS260828P00103000' }]))
      .toBe('sell 1 DIS260828P00103000');
  });

  it('legLine handles missing legs without throwing', () => {
    expect(legLine(undefined)).toBe('—');
    expect(legLine([])).toBe('—');
  });

  it('underlyingsOf extracts the root ticker from OCC symbols, deduped', () => {
    expect(underlyingsOf([
      { symbol: 'CVS260925C00096000' },
      { symbol: 'CVS260925C00103000' },
    ])).toEqual(['CVS']);
  });

  it('underlyingsOf keeps multiple distinct underlyings in first-seen order', () => {
    expect(underlyingsOf([
      { symbol: 'DIS260828P00103000' },
      { symbol: 'CVS260925C00096000' },
    ])).toEqual(['DIS', 'CVS']);
  });

  it('underlyingsOf skips legs with no symbol', () => {
    expect(underlyingsOf([{}, { symbol: 'AAPL' }])).toEqual(['AAPL']);
  });
});
