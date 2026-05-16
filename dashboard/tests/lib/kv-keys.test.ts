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

  it('exposes the expected keys (4 core + 3 SM accounts)', () => {
    expect(BOT_STATE_KEYS).toEqual([
      'bot:state:conservative',
      'bot:state:aggressive',
      'bot:state:manual',
      'bot:state:live',
      'bot:state:sm500',
      'bot:state:sm1000',
      'bot:state:sm2000',
      'bot:strategy:conservative',
      'bot:strategy:aggressive',
      'bot:strategy:manual',
      'bot:strategy:live',
      'bot:strategy:sm500',
      'bot:strategy:sm1000',
      'bot:strategy:sm2000',
      'bot:congress',
      'bot:rules:conservative',
      'bot:rules:aggressive',
      'bot:rules:manual',
      'bot:rules:live',
      'bot:rules:sm500',
      'bot:rules:sm1000',
      'bot:rules:sm2000',
    ]);
  });
});
