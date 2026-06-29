/**
 * accountsForSelection() pure helper.
 *
 * Two accounts since the 2026-06-29 sunset: manual (paper) + live (real money).
 * Verifies that the selector resolves:
 *   'both'          → manual, live
 *   any single mode → [that mode]
 */
import { describe, it, expect } from 'vitest';
import { accountsForSelection, ALL_MODES } from '../../src/lib/account-utils';

describe('accountsForSelection', () => {
  it("'both' → both modes (manual, live)", () => {
    const result = accountsForSelection('both');
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(['manual', 'live']));
    expect(new Set(result)).toEqual(new Set(ALL_MODES));
  });

  it("single mode 'manual' → ['manual']", () => {
    expect(accountsForSelection('manual')).toEqual(['manual']);
  });

  it("single mode 'live' → ['live']", () => {
    expect(accountsForSelection('live')).toEqual(['live']);
  });

  it('ALL_MODES contains exactly the 2 surviving modes', () => {
    expect(ALL_MODES).toHaveLength(2);
    expect(ALL_MODES).toContain('manual');
    expect(ALL_MODES).toContain('live');
  });

  it('returned arrays are independent copies (mutation does not affect subsequent calls)', () => {
    const r1 = accountsForSelection('both');
    r1.push('manual');
    const r2 = accountsForSelection('both');
    expect(r2).toHaveLength(2);
  });
});
