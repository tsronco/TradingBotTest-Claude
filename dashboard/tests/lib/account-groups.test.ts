/**
 * accountsForSelection() pure helper.
 *
 * Three accounts: manual (paper) + live (real money) + agent — the autonomous
 * Claude-driven paper account, registered 2026-08-18.
 * Verifies that the selector resolves:
 *   'both'          → manual, live, agent  (the "all" chip)
 *   any single mode → [that mode]
 */
import { describe, it, expect } from 'vitest';
import { accountsForSelection, ALL_MODES } from '../../src/lib/account-utils';

describe('accountsForSelection', () => {
  it("'both' → every mode (manual, live, agent)", () => {
    const result = accountsForSelection('both');
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining(['manual', 'live', 'agent']));
    expect(new Set(result)).toEqual(new Set(ALL_MODES));
  });

  it("single mode 'manual' → ['manual']", () => {
    expect(accountsForSelection('manual')).toEqual(['manual']);
  });

  it("single mode 'live' → ['live']", () => {
    expect(accountsForSelection('live')).toEqual(['live']);
  });

  it("single mode 'agent' → ['agent']", () => {
    expect(accountsForSelection('agent')).toEqual(['agent']);
  });

  it('ALL_MODES contains exactly the 3 live modes', () => {
    expect(ALL_MODES).toHaveLength(3);
    expect(ALL_MODES).toContain('manual');
    expect(ALL_MODES).toContain('live');
    expect(ALL_MODES).toContain('agent');
  });

  it('returned arrays are independent copies (mutation does not affect subsequent calls)', () => {
    const r1 = accountsForSelection('both');
    r1.push('manual');
    const r2 = accountsForSelection('both');
    expect(r2).toHaveLength(3);
  });
});
