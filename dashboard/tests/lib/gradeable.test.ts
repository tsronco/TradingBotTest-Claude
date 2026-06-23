import { describe, it, expect } from 'vitest';
import { isGradeable, GRADEABLE_ACCOUNTS } from '../../api/_lib/trade-types';

describe('isGradeable', () => {
  it('is true only for manual_paper and live', () => {
    expect(isGradeable('manual_paper')).toBe(true);
    expect(isGradeable('live')).toBe(true);
  });
  it('is false for the bot accounts', () => {
    for (const a of ['conservative_paper', 'aggressive_paper', 'sm500_paper', 'sm1000_paper', 'sm2000_paper'] as const) {
      expect(isGradeable(a)).toBe(false);
    }
  });
  it('GRADEABLE_ACCOUNTS holds exactly the two gradeable accounts', () => {
    expect(GRADEABLE_ACCOUNTS.size).toBe(2);
    expect(GRADEABLE_ACCOUNTS.has('manual_paper')).toBe(true);
    expect(GRADEABLE_ACCOUNTS.has('live')).toBe(true);
  });
});
