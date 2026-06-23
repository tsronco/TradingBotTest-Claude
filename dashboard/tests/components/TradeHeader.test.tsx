import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TradeHeader } from '../../src/components/trade/TradeHeader';
import { fmtUsd } from '../../src/lib/format';
import type { Trade } from '../../src/lib/trade-types';

function mkTrade(p: Partial<Trade>): Trade {
  return {
    id: 'T-2026-06-23-001', account: 'live', asset_class: 'option',
    symbol: 'F', side: 'BTO', qty: 1, order_type: 'limit', limit_price: 2.0,
    stop_price: null, trail_pct: null, tif: 'day', contract_symbol: 'F260717C00400000',
    strike: 400, expiration: '2026-07-17', contract_type: 'call', greeks_at_entry: null,
    alpaca_order_id: 'x', alpaca_close_order_id: null, submitted_at: '2026-06-23T13:00:00Z',
    filled_at: '2026-06-23T13:01:00Z', filled_avg_price: 2.0, closed_at: null,
    closed_avg_price: null, realized_pnl: null, closed_by: null, tags: [],
    entry_grade: 'B', entry_reasoning: 'r', journal: '', exposure_at_submit: 200,
    rule_warnings_at_entry: [], schema: 1, ...p,
  } as Trade;
}

describe('TradeHeader break-even readout', () => {
  it('renders the break-even for an open option trade (strike + premium)', () => {
    render(<TradeHeader trade={mkTrade({})} />);
    expect(screen.getByText(/break-even/i)).toBeTruthy();
    expect(screen.getByText(fmtUsd(402))).toBeTruthy();
  });

  it('renders an em-dash when break-even is not computable', () => {
    render(<TradeHeader trade={mkTrade({ filled_avg_price: null, limit_price: null })} />);
    expect(screen.getByText(/break-even/i)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
