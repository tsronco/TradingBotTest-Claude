/**
 * Vertical spread classification.
 *
 * The gap this closes: the Alpaca importer only understood put_credit, so the
 * agent account's CVS call debit spread was paired correctly and then thrown
 * away with "only put_credit spreads supported in v1" — leaving an open
 * position with no trade record anywhere on the dashboard.
 */
import { describe, it, expect } from 'vitest';
import { classifyVertical } from '../../api/_lib/trade-types';

describe('classifyVertical — structure decides the type', () => {
  it('put, short above long → put_credit (bull put)', () => {
    const s = classifyVertical({
      optionType: 'put', shortStrike: 103, longStrike: 100,
      shortPremium: 0.48, longPremium: 0.19,
    });
    expect(s.spread_type).toBe('put_credit');
    expect(s.is_credit).toBe(true);
    expect(s.side).toBe('STO');
  });

  it('put, short below long → put_debit (bear put)', () => {
    const s = classifyVertical({
      optionType: 'put', shortStrike: 95, longStrike: 100,
      shortPremium: 1.0, longPremium: 3.0,
    });
    expect(s.spread_type).toBe('put_debit');
    expect(s.is_credit).toBe(false);
    expect(s.side).toBe('BTO');
  });

  it('call, short below long → call_credit (bear call)', () => {
    const s = classifyVertical({
      optionType: 'call', shortStrike: 100, longStrike: 105,
      shortPremium: 3.0, longPremium: 1.0,
    });
    expect(s.spread_type).toBe('call_credit');
    expect(s.is_credit).toBe(true);
    expect(s.side).toBe('STO');
  });

  it('call, short above long → call_debit (bull call)', () => {
    const s = classifyVertical({
      optionType: 'call', shortStrike: 103, longStrike: 96,
      shortPremium: 0.72, longPremium: 2.625,
    });
    expect(s.spread_type).toBe('call_debit');
    expect(s.is_credit).toBe(false);
    expect(s.side).toBe('BTO');
  });
});

describe('classifyVertical — credit math', () => {
  const s = classifyVertical({
    optionType: 'put', shortStrike: 103, longStrike: 100,
    shortPremium: 0.48, longPremium: 0.19,
  });

  it('keeps the net as credit and risks the rest of the width', () => {
    expect(s.width).toBe(3);
    expect(s.net).toBeCloseTo(0.29, 10);
    expect(s.net_credit).toBeCloseTo(0.29, 10);
    expect(s.net_debit).toBe(0);
    expect(s.max_profit).toBeCloseTo(0.29, 10);
    expect(s.max_loss).toBeCloseTo(2.71, 10);
  });

  it('max_loss + max_profit equals the width', () => {
    expect(s.max_loss + s.max_profit).toBeCloseTo(s.width, 10);
  });
});

describe('classifyVertical — debit math (the real CVS trade)', () => {
  // CVS Sep-25 96/103 call vertical: bought the 96, sold the 103.
  const s = classifyVertical({
    optionType: 'call', shortStrike: 103, longStrike: 96,
    shortPremium: 0.72, longPremium: 2.625,
  });

  it('treats the payment as the entire risk', () => {
    expect(s.width).toBe(7);
    expect(s.net).toBeCloseTo(-1.905, 10);   // negative — money out
    expect(s.net_debit).toBeCloseTo(1.905, 10);
    expect(s.net_credit).toBe(0);
    expect(s.max_loss).toBeCloseTo(1.905, 10);
    expect(s.max_profit).toBeCloseTo(5.095, 10);
  });

  it('max_loss + max_profit equals the width', () => {
    expect(s.max_loss + s.max_profit).toBeCloseTo(s.width, 10);
  });

  it('never reports a debit spread as risking more than it cost', () => {
    // The put_credit-shaped formula (width − net) would have said 8.905 here —
    // nearly 5x the real risk.
    expect(s.max_loss).toBeLessThan(s.width);
    expect(s.max_loss).toBeCloseTo(s.net_debit, 10);
  });
});

describe('classifyVertical — degenerate fills', () => {
  it('classifies by structure even when a bad fill inverts the net', () => {
    // A "credit" spread filled for a debit is a bad fill, not a different
    // structure — it must still be named put_credit so management logic that
    // keys off the type behaves.
    const s = classifyVertical({
      optionType: 'put', shortStrike: 103, longStrike: 100,
      shortPremium: 0.10, longPremium: 0.40,
    });
    expect(s.spread_type).toBe('put_credit');
    expect(s.net).toBeCloseTo(-0.3, 10);
    expect(s.net_credit).toBeCloseTo(-0.3, 10);   // reported honestly, not clamped
    expect(s.max_loss).toBeCloseTo(3.3, 10);      // worse than the width — correct
  });

  it('handles a zero-premium long leg', () => {
    const s = classifyVertical({
      optionType: 'put', shortStrike: 103, longStrike: 100,
      shortPremium: 0.50, longPremium: 0,
    });
    expect(s.net_credit).toBeCloseTo(0.5, 10);
    expect(s.max_loss).toBeCloseTo(2.5, 10);
  });
});
