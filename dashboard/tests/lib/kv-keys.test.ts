import { describe, it, expect } from 'vitest';
import { isAllowedBotStateKey, BOT_STATE_KEYS } from '../../api/_lib/kv-keys';

describe('kv-keys', () => {
  it('accepts every key in the whitelist', () => {
    for (const k of BOT_STATE_KEYS) {
      expect(isAllowedBotStateKey(k)).toBe(true);
    }
  });

  it('rejects keys not in the whitelist', () => {
    expect(isAllowedBotStateKey('bot:state:made-up')).toBe(false);
    expect(isAllowedBotStateKey('session:abc')).toBe(false);
    expect(isAllowedBotStateKey('')).toBe(false);
  });

  it('exposes the expected seven keys', () => {
    expect(BOT_STATE_KEYS).toEqual([
      'bot:state:conservative',
      'bot:state:aggressive',
      'bot:state:manual',
      'bot:strategy:conservative',
      'bot:strategy:aggressive',
      'bot:strategy:manual',
      'bot:congress',
    ]);
  });
});
