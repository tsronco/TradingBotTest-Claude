// The agent thesis panel on the trade detail page.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentThesisPanel } from '../../src/components/trade/AgentThesisPanel';
import type { Trade } from '../../src/lib/trade-types';

const SHORT = 'DIS260828P00103000';
const LONG = 'DIS260828P00100000';

const AGENT_STATE = {
  positions: {
    open1: {
      opened_at: '2026-08-17T18:12:45Z',
      legs: [{ symbol: 'CVS260925C00096000' }, { symbol: 'CVS260925C00103000' }],
      thesis: {
        thesis: 'CVS carries the lowest implied vol in my shortlist.',
        getting_paid: 'Net debit 2.45 on a 7-wide.',
        key_risk: 'CVS goes flat and the vertical bleeds.',
        invalidation: 'Wrong if CVS closes below $90.00.',
        rejected: 'Rejected a plain long call.',
        confidence: 3,
      },
    },
  },
  closed: [{
    opened_at: '2026-08-14T18:12:55Z',
    closed_at: '2026-08-17T16:12:41Z',
    legs: [{ symbol: SHORT }, { symbol: LONG }],
    thesis: { thesis: 'DIS holds above 103.', invalidation: 'DIS closes under 103.', confidence: 3 },
    outcome: { estimated_pnl: -57, days_held: 2.9, estimated_pnl_basis: 'last mid before close' },
    grade: {
      graded: true, process_grade: 'B', outcome_grade: 'D', loss_type: 'blind_spot',
      lesson: 'A low-delta credit spread can bleed from ordinary IV noise.',
      exit_quality: 'unclear',
    },
  }],
};

vi.mock('../../src/lib/api', () => ({
  api: vi.fn(() => Promise.resolve({
    key: 'bot:agent:state', payload: AGENT_STATE, lastUpdate: '2026-08-18T14:12:00Z',
  })),
}));

function tradeFor(over: Partial<Trade> = {}): Trade {
  return {
    id: 'T-2026-08-18-002',
    account: 'agent_paper',
    asset_class: 'spread',
    symbol: 'DIS',
    contract_symbol: SHORT,
    filled_at: '2026-08-14T18:12:55Z',
    submitted_at: '2026-08-14T18:12:55Z',
    spread: { short_leg: { occ: SHORT }, long_leg: { occ: LONG } },
    ...over,
  } as unknown as Trade;
}

function renderPanel(trade: Trade) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><AgentThesisPanel trade={trade} /></QueryClientProvider>,
  );
}

describe('AgentThesisPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing at all for a non-agent trade', () => {
    const { container } = renderPanel(tradeFor({ account: 'manual_paper' } as Partial<Trade>));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the entry thesis for a matched trade', async () => {
    renderPanel(tradeFor());
    expect(await screen.findByText(/DIS holds above 103/)).toBeInTheDocument();
    expect(screen.getByText(/DIS closes under 103/)).toBeInTheDocument();
  });

  it('shows the confidence the agent stated at entry', async () => {
    renderPanel(tradeFor());
    expect(await screen.findByText(/confidence 3\/5/)).toBeInTheDocument();
    expect(screen.getByText(/★★★☆☆/)).toBeInTheDocument();
  });

  it('appends the close grades, loss type and lesson once closed', async () => {
    renderPanel(tradeFor());
    expect(await screen.findByText('on close')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();     // process
    expect(screen.getByText('D')).toBeInTheDocument();     // outcome
    expect(screen.getByText('BLIND SPOT')).toBeInTheDocument();
    expect(screen.getByText(/ordinary IV noise/)).toBeInTheDocument();
  });

  it('marks a still-held position as open and shows no close section', async () => {
    renderPanel(tradeFor({
      symbol: 'CVS',
      contract_symbol: 'CVS260925C00103000',
      filled_at: '2026-08-17T18:12:45Z',
      spread: {
        short_leg: { occ: 'CVS260925C00103000' },
        long_leg: { occ: 'CVS260925C00096000' },
      },
    } as Partial<Trade>));
    expect(await screen.findByText('still held')).toBeInTheDocument();
    expect(screen.getByText(/lowest implied vol/)).toBeInTheDocument();
    expect(screen.queryByText('on close')).not.toBeInTheDocument();
  });

  it('explains itself when no agent record matches, rather than showing a blank panel', async () => {
    renderPanel(tradeFor({
      spread: {
        short_leg: { occ: 'AAPL260828P00200000' },
        long_leg: { occ: 'AAPL260828P00195000' },
      },
    } as Partial<Trade>));
    expect(await screen.findByText(/No matching entry in the agent/)).toBeInTheDocument();
  });
});
