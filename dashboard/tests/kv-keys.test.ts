import { describe, it, expect } from 'vitest';
import {
  isAllowedBotStateKey,
  isAllowedDashboardKey,
  botRulesKey,
  rulesKey,
  assignmentsPendingKey,
} from '../api/_lib/kv-keys';

describe('Phase 3 KV keys', () => {
  it('whitelists bot:rules:* for all three modes', () => {
    expect(isAllowedBotStateKey('bot:rules:conservative')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:aggressive')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:manual')).toBe(true);
    expect(isAllowedBotStateKey('bot:rules:wrong')).toBe(false);
  });

  it('whitelists SM bot-state/strategy/rules keys (bot↔dashboard contract)', () => {
    for (const acct of ['sm500', 'sm1000', 'sm2000'] as const) {
      expect(isAllowedBotStateKey(`bot:state:${acct}`)).toBe(true);
      expect(isAllowedBotStateKey(`bot:strategy:${acct}`)).toBe(true);
      expect(isAllowedBotStateKey(`bot:rules:${acct}`)).toBe(true);
    }
  });

  it('botRulesKey derives SM keys (type-checks SM modes)', () => {
    expect(botRulesKey('sm500')).toBe('bot:rules:sm500');
    expect(botRulesKey('sm1000')).toBe('bot:rules:sm1000');
    expect(botRulesKey('sm2000')).toBe('bot:rules:sm2000');
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
    expect(botRulesKey('conservative')).toBe('bot:rules:conservative');
    expect(botRulesKey('aggressive')).toBe('bot:rules:aggressive');
    expect(botRulesKey('manual')).toBe('bot:rules:manual');
    expect(rulesKey('manual')).toBe('rules:manual');
    expect(rulesKey('proposals')).toBe('rules:proposals');
    expect(assignmentsPendingKey()).toBe('trades:index:assignments-pending');
  });
});
