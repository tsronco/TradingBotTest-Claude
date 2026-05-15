import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmModal } from '../../src/components/order/ConfirmModal';

function withRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ConfirmModal', () => {
  it('renders single-leg stock copy when draft has no kind=spread', () => {
    const preview = {
      exposure: 1000,
      requires_totp: false,
      rule_warnings: [],
      draft: {
        account: 'manual_paper',
        symbol: 'AAPL',
        side: 'buy',
        qty: 10,
        order_type: 'market',
        tif: 'day',
        entry_grade: 'B',
        entry_reasoning: 'sound setup',
      },
    };
    withRouter(<ConfirmModal preview={preview} onClose={() => {}} />);
    expect(screen.getByText(/BUY 10 AAPL/)).toBeInTheDocument();
  });

  it('renders spread-aware copy when draft.kind === spread', () => {
    const preview = {
      exposure: 75,
      requires_totp: false,
      rule_warnings: [],
      draft: {
        kind: 'spread',
        account: 'manual_paper',
        symbol: 'AAL',
        spread_type: 'put_credit',
        short_leg: { occ: 'AAL260529P00012500', strike: 12.5, entry_premium: 0.37 },
        long_leg: { occ: 'AAL260529P00011500', strike: 11.5, entry_premium: 0.12 },
        expiration: '2026-05-29',
        qty: 1,
        limit_price: -0.25,
        entry_grade: 'B',
        entry_reasoning: 'tight spread, decent credit',
      },
    };
    withRouter(<ConfirmModal preview={preview} onClose={() => {}} />);
    expect(screen.getByText(/AAL/i)).toBeInTheDocument();
    expect(screen.getByText(/put credit/i)).toBeInTheDocument();
    // Both strikes visible
    expect(screen.getByText(/12\.50/)).toBeInTheDocument();
    expect(screen.getByText(/11\.50/)).toBeInTheDocument();
    // Credit and max loss in $ terms (credit 0.25 → $0.25 per-share / $25 total;
    // max loss = width 1.00 − credit 0.25 = $0.75 per-share / $75 total)
    expect(screen.getByText(/\$0\.25/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.75.*\$75\.00/)).toBeInTheDocument();
  });
});
