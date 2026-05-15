import { describe, it, expect } from 'vitest';
import { computeExposure } from '../api/_lib/exposure';

describe('computeExposure — spread', () => {
  it('computes spread exposure as max_loss × 100 × qty', () => {
    const exposure = computeExposure({
      asset_class: 'spread',
      side: 'STO',  // ignored for spreads
      qty: 1,
      order_type: 'limit',
      limit_price: -0.25,
      spread: {
        width: 1.0,
        net_credit: 0.25,
        max_loss: 0.75,
      },
    });
    expect(exposure).toBe(75);  // 0.75 * 100 * 1
  });

  it('scales spread exposure by qty', () => {
    const exposure = computeExposure({
      asset_class: 'spread',
      side: 'STO',
      qty: 3,
      order_type: 'limit',
      limit_price: -0.25,
      spread: { width: 1.0, net_credit: 0.25, max_loss: 0.75 },
    });
    expect(exposure).toBe(225);  // 0.75 * 100 * 3
  });
});
