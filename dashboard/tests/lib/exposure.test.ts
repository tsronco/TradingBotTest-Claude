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

  it('option STO call = qty × bid × 100 (premium received)', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STO', contract_type: 'call',
      qty: 1, order_type: 'limit', limit_price: 2.10,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(210, 2); // qty × limit × 100
  });

  it('option BTO = qty × ask × 100', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'BTO', contract_type: 'call',
      qty: 2, order_type: 'market', limit_price: null,
      strike: 350, ask: 2.15, bid: 2.05,
    })).toBeCloseTo(430, 2);
  });

  it('option BTC = qty × ask × 100', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'BTC', contract_type: 'put',
      qty: 1, order_type: 'limit', limit_price: 2.00,
      strike: 280, ask: 2.05, bid: 1.95,
    })).toBeCloseTo(200, 2);
  });

  it('option STC = qty × bid × 100', () => {
    expect(computeExposure({
      asset_class: 'option', side: 'STC', contract_type: 'call',
      qty: 1, order_type: 'market', limit_price: null,
      strike: 350, ask: 5.10, bid: 5.00,
    })).toBeCloseTo(500, 2);
  });
});
