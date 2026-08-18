/**
 * Registration invariants for the autonomous agent paper account.
 *
 * These are the properties that must hold everywhere the account is surfaced —
 * it is a first-class account for READING (home cards, positions, orders,
 * trades, calendar, performance) but must never be a target for a hand-placed
 * order, and it must never be routed to another account's Alpaca credentials.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_MODES,
  ALL_ACCOUNTS,
  ALL_PAPER_ACCOUNTS,
  TRADEABLE_PAPER_ACCOUNTS,
  ACCOUNT_LABEL,
  WHEEL_MODES,
  accountToMode,
  modeToAccount,
  isAgentAccount,
  isAgentMode,
  isWheelMode,
  isPaperAccount,
  isLiveAccount,
  isTradeableAccount,
  selectModeFromAccountMode,
} from '../../src/lib/account-utils';
import { isMode, isPaperMode } from '../../api/_lib/alpaca';
import { GRADEABLE_ACCOUNTS, isGradeable } from '../../api/_lib/trade-types';

describe('agent account registration', () => {
  it('is a first-class mode and account id', () => {
    expect(ALL_MODES).toContain('agent');
    expect(ALL_ACCOUNTS).toContain('agent_paper');
    expect(ALL_PAPER_ACCOUNTS).toContain('agent_paper');
  });

  it('round-trips between mode and account id', () => {
    expect(modeToAccount('agent')).toBe('agent_paper');
    expect(accountToMode('agent_paper')).toBe('agent');
    for (const m of ALL_MODES) {
      expect(accountToMode(modeToAccount(m))).toBe(m);
    }
  });

  it('never collapses to manual — the bug that would trade the wrong account', () => {
    // accountToMode's fallthrough returns 'manual'. If agent_paper ever stops
    // being handled explicitly, every agent read silently hits manual's Alpaca
    // credentials instead. Pin it.
    expect(accountToMode('agent_paper')).not.toBe('manual');
    expect(modeToAccount('agent')).not.toBe('manual_paper');
  });

  it('is paper, not live', () => {
    expect(isPaperAccount('agent_paper')).toBe(true);
    expect(isLiveAccount('agent_paper')).toBe(false);
    expect(isPaperMode('agent')).toBe(true);
    expect(isPaperMode('live')).toBe(false);
  });

  it('is recognized by the backend mode guard', () => {
    expect(isMode('agent')).toBe(true);
    expect(isMode('sm500')).toBe(false);
    expect(isMode(undefined)).toBe(false);
  });

  it('is NOT a wheel mode — it has no bot:rules / bot:state payload', () => {
    expect(isWheelMode('agent')).toBe(false);
    expect(WHEEL_MODES).not.toContain('agent');
    expect(WHEEL_MODES).toEqual(['manual', 'live']);
    expect(isAgentMode('agent')).toBe(true);
    expect(isAgentMode('manual')).toBe(false);
  });

  it('is NOT hand-tradeable from the dashboard', () => {
    // The account measures Claude's unassisted decisions; a hand-placed order
    // would pollute the record and leave a position with no thesis attached.
    expect(TRADEABLE_PAPER_ACCOUNTS).not.toContain('agent_paper');
    expect(TRADEABLE_PAPER_ACCOUNTS).toEqual(['manual_paper']);
    expect(isTradeableAccount('agent_paper')).toBe(false);
    expect(isTradeableAccount('manual_paper')).toBe(true);
  });

  it('is NOT dashboard-AI-gradeable — the agent grades its own decisions', () => {
    expect(isGradeable('agent_paper')).toBe(false);
    expect(GRADEABLE_ACCOUNTS.has('agent_paper' as never)).toBe(false);
    expect(isGradeable('manual_paper')).toBe(true);
  });

  it('has a human-facing label', () => {
    expect(ACCOUNT_LABEL.agent_paper).toMatch(/agent/i);
    for (const a of ALL_ACCOUNTS) {
      expect(ACCOUNT_LABEL[a]).toBeTruthy();
    }
  });

  it('resolves as a single-account selection for market-data callers', () => {
    expect(selectModeFromAccountMode('agent')).toBe('agent');
    expect(selectModeFromAccountMode('both')).toBe('manual');
  });

  it('identifies the account id', () => {
    expect(isAgentAccount('agent_paper')).toBe(true);
    expect(isAgentAccount('manual_paper')).toBe(false);
    expect(isAgentAccount('live')).toBe(false);
  });
});
