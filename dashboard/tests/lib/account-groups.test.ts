/**
 * Task 6.2 — accountsForSelection() pure helper
 *
 * Verifies that the group-view selector correctly resolves:
 *   'all' / 'both'  → all 7 modes
 *   'small'         → sm500, sm1000, sm2000
 *   'core'          → conservative, aggressive
 *   'hands-on'      → manual, live
 *   any single mode → [that mode]
 */
import { describe, it, expect } from 'vitest';
import { accountsForSelection, ALL_MODES } from '../../src/lib/account-utils';

describe('accountsForSelection', () => {
  it("'both' → all 7 modes", () => {
    const result = accountsForSelection('both');
    expect(result).toHaveLength(7);
    expect(result).toEqual(expect.arrayContaining([
      'conservative', 'aggressive', 'manual', 'live',
      'sm500', 'sm1000', 'sm2000',
    ]));
    // Confirm it matches ALL_MODES exactly (same set, order may differ)
    expect(new Set(result)).toEqual(new Set(ALL_MODES));
  });

  it("'small' → ['sm500', 'sm1000', 'sm2000']", () => {
    const result = accountsForSelection('small');
    expect(result).toHaveLength(3);
    expect(result).toEqual(['sm500', 'sm1000', 'sm2000']);
  });

  it("'core' → ['conservative', 'aggressive']", () => {
    const result = accountsForSelection('core');
    expect(result).toHaveLength(2);
    expect(result).toEqual(['conservative', 'aggressive']);
  });

  it("'hands-on' → ['manual', 'live']", () => {
    const result = accountsForSelection('hands-on');
    expect(result).toHaveLength(2);
    expect(result).toEqual(['manual', 'live']);
  });

  it("single mode 'conservative' → ['conservative']", () => {
    expect(accountsForSelection('conservative')).toEqual(['conservative']);
  });

  it("single mode 'aggressive' → ['aggressive']", () => {
    expect(accountsForSelection('aggressive')).toEqual(['aggressive']);
  });

  it("single mode 'manual' → ['manual']", () => {
    expect(accountsForSelection('manual')).toEqual(['manual']);
  });

  it("single mode 'live' → ['live']", () => {
    expect(accountsForSelection('live')).toEqual(['live']);
  });

  it("single mode 'sm500' → ['sm500']", () => {
    expect(accountsForSelection('sm500')).toEqual(['sm500']);
  });

  it("single mode 'sm1000' → ['sm1000']", () => {
    expect(accountsForSelection('sm1000')).toEqual(['sm1000']);
  });

  it("single mode 'sm2000' → ['sm2000']", () => {
    expect(accountsForSelection('sm2000')).toEqual(['sm2000']);
  });

  it('ALL_MODES contains exactly 7 modes including the 3 SM modes', () => {
    expect(ALL_MODES).toHaveLength(7);
    expect(ALL_MODES).toContain('sm500');
    expect(ALL_MODES).toContain('sm1000');
    expect(ALL_MODES).toContain('sm2000');
    expect(ALL_MODES).toContain('conservative');
    expect(ALL_MODES).toContain('aggressive');
    expect(ALL_MODES).toContain('manual');
    expect(ALL_MODES).toContain('live');
  });

  it("returned arrays are independent copies (mutation does not affect subsequent calls)", () => {
    const r1 = accountsForSelection('small');
    r1.push('conservative');
    const r2 = accountsForSelection('small');
    expect(r2).toHaveLength(3);
  });
});
