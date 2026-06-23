import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GradePanel } from '../../src/components/trade/GradePanel';
import type { Trade, GradeRecord } from '../../src/lib/trade-types';

vi.mock('../../src/lib/api', () => ({ api: vi.fn() }));

function mkTrade(account: Trade['account']): Trade {
  return {
    id: 'T-1', account, asset_class: 'stock', symbol: 'F', side: 'buy', qty: 1,
    order_type: 'market', limit_price: null, stop_price: null, trail_pct: null, tif: 'day',
    contract_symbol: null, strike: null, expiration: null, contract_type: null, greeks_at_entry: null,
    alpaca_order_id: 'x', alpaca_close_order_id: null, submitted_at: '2026-06-23T13:00:00Z',
    filled_at: '2026-06-23T13:01:00Z', filled_avg_price: 14, closed_at: '2026-06-23T15:00:00Z',
    closed_avg_price: 15, realized_pnl: 1, closed_by: 'manual', tags: [], entry_grade: 'B',
    entry_reasoning: 'r', journal: '', exposure_at_submit: 14, rule_warnings_at_entry: [], schema: 1,
  } as Trade;
}
const ungraded: GradeRecord = { trade_id: 'T-1', entry: { letter: 'B', reasoning: 'r', ts: '' }, hindsight: null, history: [] };

function renderPanel(trade: Trade) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><GradePanel trade={trade} grade={ungraded} /></QueryClientProvider>);
}

describe('GradePanel regrade gating', () => {
  it('shows grade/re-grade buttons on a manual trade', () => {
    renderPanel(mkTrade('manual_paper'));
    expect(screen.getByText(/grade now/)).toBeTruthy();
    expect(screen.getByText(/re-grade/)).toBeTruthy();
  });
  it('hides them on a conservative trade and explains why', () => {
    renderPanel(mkTrade('conservative_paper'));
    expect(screen.queryByText(/grade now/)).toBeNull();
    expect(screen.queryByText(/re-grade/)).toBeNull();
    expect(screen.getByText(/grading is off for bot accounts/i)).toBeTruthy();
  });
});
