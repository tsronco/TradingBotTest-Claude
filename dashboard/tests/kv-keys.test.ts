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
