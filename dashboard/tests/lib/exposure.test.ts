import { describe, expect, it } from 'vitest';
import { computeExposure } from '../../api/_lib/exposure';

describe('computeExposure', () => {
  it('stock buy: qty × limit price', () => {
    expect(computeExposure({
      asset_class: 'stock', side: 'buy', qty: 10, order_type: 'limit',
      limit_price: 321.40, ask: 321.45, bid: 321.35,
    })).toBeCloseTo(3214.00, 2);
  });

  it('stock buy market: qty × ask', () => {
    expect(computeExposure({
      asset_class: 'stock', side: 'buy', qty: 10, order_type: 'market',
      limit_price: null, ask: 321.45, bid: 321.35,
    })).toBeCloseTo(3214.50, 2);
  });

  it('stock sell uses bid for market', () => {
    expect(computeExposure({
      asset_class: 'stock', side: 'sell', qty: 10, order_type: 'market',
      limit_price: null, ask: 321.45, bid: 321.35,
    })).toBeCloseTo(3213.50, 2);
  });

  it('option STO put = strike × qty × 100 (cash secured)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'put',
      qty: 1, order_type: 'limit', limit_price: 4.25,
      strike: 280, ask: 4.30, bid: 4.20,
    })).toBeCloseTo(28000, 2);
  });

  // D9 fix: STO call exposure is assignment notional (strike × qty × 100),
  // NOT premium received. Matches the OptionOrderForm.tsx client preview which
  // already uses strike × 100 × qty for all STO opens.
  it('D9: option STO call = strike × qty × 100 (assignment notional, not premium)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'call',
      qty: 1, order_type: 'limit', limit_price: 2.10,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(35000, 2); // 350 × 1 × 100, NOT 2.10 × 1 × 100 = 210
  });

  it('D9: STO call exposure scales with qty', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'call',
      qty: 3, order_type: 'limit', limit_price: 2.10,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(105000, 2); // 350 × 3 × 100
  });

  // D9: a live short call above the live TOTP threshold ($1,500) must set
  // requires_totp=true. With the old premium-based formula (2.10 × 1 × 100 = $210)
  // it would have been under the threshold. With the corrected notional
  // (350 × 1 × 100 = $35,000) it is far above.
  it('D9: STO call strike-notional above live $1,500 threshold exceeds threshold', () => {
    const LIVE_TOTP_THRESHOLD = 1500;
    const exposure = computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'call',
      qty: 1, order_type: 'limit', limit_price: 2.10,
      strike: 350, ask: 2.15, bid: 2.05,
    });
    // New formula: exposure = 35,000 → well above threshold → TOTP required
    expect(exposure >= LIVE_TOTP_THRESHOLD).toBe(true);
    // Old (broken) formula would have been 210 → below threshold → TOTP skipped
    const oldPremiumBasedExposure = 1 * 2.10 * 100; // 210
    expect(oldPremiumBasedExposure >= LIVE_TOTP_THRESHOLD).toBe(false);
  });

  // Regression guards: STO put, BTO, BTC, STC branches must be unchanged.
  it('option BTO = qty × ask × 100 (regression)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'BTO', contract_type: 'call',
      qty: 2, order_type: 'market', limit_price: null,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(430, 2);
  });

  it('option BTC = qty × limit × 100 (regression)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'BTC', contract_type: 'put',
      qty: 1, order_type: 'limit', limit_price: 2.00,
      strike: 280, ask: 2.05, bid: 1.95,
    })).toBeCloseTo(200, 2);
  });

  it('option STC = qty × bid × 100 (regression)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STC', contract_type: 'call',
      qty: 1, order_type: 'market', limit_price: null,
      strike: 350, ask: 5.10, bid: 5.00,
    })).toBeCloseTo(500, 2);
  });
});
