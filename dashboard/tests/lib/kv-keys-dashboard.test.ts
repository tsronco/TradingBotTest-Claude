import { describe, expect, it } from 'vitest';
import {
  isAllowedDashboardKey,
  isAllowedBotStateKey,
  KV_KEYS,
} from '../../api/_lib/kv-keys';

describe('dashboard kv-key whitelist', () => {
  it('accepts trade and grade keys', () => {
    expect(isAllowedDashboardKey('trade:T-2026-05-04-001')).toBe(true);
    expect(isAllowedDashboardKey('grade:T-2026-05-04-001')).toBe(true);
    expect(isAllowedDashboardKey('trades:index:open')).toBe(true);
    expect(isAllowedDashboardKey('trades:index:2026-05')).toBe(true);
    expect(isAllowedDashboardKey('trades:counter:2026-05-04')).toBe(true);
    expect(isAllowedDashboardKey('tags:list')).toBe(true);
    expect(isAllowedDashboardKey('config:totp_thresholds')).toBe(true);
    expect(isAllowedDashboardKey('auth:backup_codes_hashed')).toBe(true);
  });

  it('rejects bot-state keys from the dashboard whitelist', () => {
    expect(isAllowedDashboardKey('bot:state:conservative')).toBe(false);
    expect(isAllowedDashboardKey('bot:state:aggressive')).toBe(false);
  });

  it('rejects junk keys', () => {
    expect(isAllowedDashboardKey('foo')).toBe(false);
    expect(isAllowedDashboardKey('trade:')).toBe(false);
    expect(isAllowedDashboardKey('grade:')).toBe(false);
  });

  it('allows the surviving bot-state keys (manual + live)', () => {
    expect(isAllowedBotStateKey('bot:state:manual')).toBe(true);
    expect(isAllowedBotStateKey('bot:state:live')).toBe(true);
    expect(isAllowedBotStateKey('bot:strategy:manual')).toBe(true);
    expect(isAllowedBotStateKey('bot:strategy:live')).toBe(true);
    // retired accounts are no longer whitelisted
    expect(isAllowedBotStateKey('bot:state:conservative')).toBe(false);
    expect(isAllowedBotStateKey('bot:congress')).toBe(false);
  });

  it('exposes phase 2 keys on KV_KEYS', () => {
    expect(KV_KEYS.tagsList).toBe('tags:list');
    expect(KV_KEYS.totpThresholds).toBe('config:totp_thresholds');
    expect(KV_KEYS.backupCodesHashed).toBe('auth:backup_codes_hashed');
    expect(KV_KEYS.tradesIndexOpen).toBe('trades:index:open');
  });
});
