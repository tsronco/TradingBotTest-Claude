// Spread summary panel.
//
// Regression cover for three defects found on the agent's CVS call debit
// spread (3 contracts), all of which came from a component written when the
// only spread that existed was a single-lot put credit spread.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SpreadMetadata } from '../../src/components/trade/SpreadMetadata';
import type { Trade } from '../../src/lib/trade-types';

/** The real CVS trade: bought 3× Sep-25 96 calls, sold 3× the 103s, $2.41 debit. */
function cvsCallDebit(over: Partial<Trade> = {}): Trade {
  return {
    asset_class: 'spread',
    qty: 3,
    spread: {
      spread_type: 'call_debit',
      short_leg: { occ: 'CVS260925C00103000', strike: 103, entry_premium: 0.40, fill_price: 0.40 },
      long_leg: { occ: 'CVS260925C00096000', strike: 96, entry_premium: 2.81, fill_price: 2.81 },
      expiration: '2026-09-25',
      width: 7,
      net_credit: 0,
      net_debit: 2.41,
      max_loss: 2.41,
      max_profit: 4.59,
    },
    ...over,
  } as unknown as Trade;
}

/** The DIS trade: single-lot put credit spread — the shape that always worked. */
function disPutCredit(): Trade {
  return {
    asset_class: 'spread',
    qty: 1,
    spread: {
      spread_type: 'put_credit',
      short_leg: { occ: 'DIS260828P00103000', strike: 103, entry_premium: 0.48, fill_price: 0.48 },
      long_leg: { occ: 'DIS260828P00100000', strike: 100, entry_premium: 0.19, fill_price: 0.19 },
      expiration: '2026-08-28',
      width: 3,
      net_credit: 0.29,
      max_loss: 2.71,
      max_profit: 0.29,
    },
  } as unknown as Trade;
}

describe('option type follows the spread type', () => {
  it('labels a call vertical as calls, not puts', () => {
    // Rendering "$103.00 put" on a $94 stock next to a $0.40 premium is
    // self-contradictory — a put that deep ITM would be worth ~$9.
    render(<SpreadMetadata trade={cvsCallDebit()} />);
    expect(screen.getByText(/Short \$103\.00 call/)).toBeInTheDocument();
    expect(screen.getByText(/Long \$96\.00 call/)).toBeInTheDocument();
    expect(screen.queryByText(/put/)).not.toBeInTheDocument();
  });

  it('still labels a put vertical as puts', () => {
    render(<SpreadMetadata trade={disPutCredit()} />);
    expect(screen.getByText(/Short \$103\.00 put/)).toBeInTheDocument();
    expect(screen.queryByText(/call/)).not.toBeInTheDocument();
  });
});

describe('dollar figures include position size', () => {
  it('scales max loss by contract count', () => {
    // $2.41 × 100 × 3 = $723. Dropping qty reported $241 — a third of the
    // real risk on the account's largest position. (On a debit spread the net
    // debit equals the max loss, so $723 legitimately appears on both lines —
    // assert against the max-loss line specifically.)
    render(<SpreadMetadata trade={cvsCallDebit()} />);
    expect(screen.getByText(/Max loss:/).textContent).toContain('$723.00');
    expect(screen.getByText(/Max loss:/).textContent).not.toContain('$241.00');
  });

  it('scales max profit by contract count', () => {
    render(<SpreadMetadata trade={cvsCallDebit()} />);
    expect(screen.getByText(/\$1377\.00/)).toBeInTheDocument();
  });

  it('shows the contract count so the multiplier is not a guess', () => {
    render(<SpreadMetadata trade={cvsCallDebit()} />);
    expect(screen.getByText(/3 contracts/)).toBeInTheDocument();
  });

  it('is unchanged for a single-lot spread', () => {
    render(<SpreadMetadata trade={disPutCredit()} />);
    expect(screen.getByText(/\$271\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1 contract$/)).toBeInTheDocument();
  });

  it('treats a missing qty as one rather than zeroing the risk', () => {
    render(<SpreadMetadata trade={cvsCallDebit({ qty: 0 } as Partial<Trade>)} />);
    expect(screen.getByText(/Max loss:/).textContent).toContain('$241.00');
    expect(screen.getByText(/Max loss:/).textContent).not.toContain('$0.00');
  });
});

describe('credit vs debit labelling', () => {
  it('reports a debit spread as a net debit, not a $0.00 credit', () => {
    render(<SpreadMetadata trade={cvsCallDebit()} />);
    expect(screen.getByText(/Net debit: \$2\.41 \(\$723\.00\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Net credit/)).not.toBeInTheDocument();
  });

  it('reports a credit spread as a net credit', () => {
    render(<SpreadMetadata trade={disPutCredit()} />);
    expect(screen.getByText(/Net credit: \$0\.29 \(\$29\.00\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Net debit/)).not.toBeInTheDocument();
  });

  it('falls back to the negated credit on a legacy debit record with no net_debit', () => {
    const legacy = cvsCallDebit();
    (legacy.spread as Record<string, unknown>).net_debit = undefined;
    (legacy.spread as Record<string, unknown>).net_credit = -2.41;
    render(<SpreadMetadata trade={legacy} />);
    expect(screen.getByText(/Net debit: \$2\.41/)).toBeInTheDocument();
  });
});

describe('non-spread trades', () => {
  it('renders nothing', () => {
    const { container } = render(
      <SpreadMetadata trade={{ asset_class: 'option', spread: undefined } as unknown as Trade} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
