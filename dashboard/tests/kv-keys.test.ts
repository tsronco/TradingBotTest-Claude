import { describe, it, expect } from 'vitest';
import {
  isAllowedBotStateKey,
  isAllowedDashboardKey,
  botRulesKey,
  rulesKey,
  assignmentsPendingKey,
} from '../api/_lib/kv-keys';

describe('Phase 3 KV keys', () => {
  it('whitelists bot:rules:* for the surviving modes (manual + live)', () => {
    expect(isAllowedBotStateKey('bot:rules:manual')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:live')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:wrong')).toBe(false);
    // retired accounts are no longer whitelisted
    expect(isAllowedBotStateKey('bot:rules:conservative')).toBe(false);
    expect(isAllowedBotStateKey('bot:state:sm500')).toBe(false);
  });

  it('whitelists bot-state/strategy/rules keys for manual + live', () => {
    for (const acct of ['manual', 'live'] as const) {
      expect(isAllowedBotStateKey(`bot:state:${acct}`)).toBe(true);
      expect(isAllowedBotStateKey(`bot:strategy:${acct}`)).toBe(true);
      expect(isAllowedBotStateKey(`bot:rules:${acct}`)).toBe(true);
    }
  });

  it('botRulesKey derives manual + live keys', () => {
    expect(botRulesKey('manual')).toBe('bot:rules:manual');
    expect(botRulesKey('live')).toBe('bot:rules:live');
  });

  it('whitelists rules:* dashboard keys', () => {
    expect(isAllowedDashboardKey('rules:manual')).toBe(true);
    expect(isAllowedDashboardKey('rules:patterns')).toBe(true);
    expect(isAllowedDashboardKey('rules:cheatsheets')).toBe(true);
    expect(isAllowedDashboardKey('rules:goals')).toBe(true);
    expect(isAllowedDashboardKey('rules:tendencies')).toBe(true);
    expect(isAllowedDashboardKey('rules:proposals')).toBe(true);
    expect(isAllowedDashboardKey('rules:bogus')).toBe(false);
  });

  it('whitelists trades:index:assignments-pending', () => {
    expect(isAllowedDashboardKey('trades:index:assignments-pending')).toBe(true);
  });

  it('exports botRulesKey + rulesKey + assignmentsPendingKey helpers', () => {
    expect(botRulesKey('manual')).toBe('bot:rules:manual');
    expect(botRulesKey('live')).toBe('bot:rules:live');
    expect(rulesKey('manual')).toBe('rules:manual');
    expect(rulesKey('proposals')).toBe('rules:proposals');
    expect(assignmentsPendingKey()).toBe('trades:index:assignments-pending');
  });
});
