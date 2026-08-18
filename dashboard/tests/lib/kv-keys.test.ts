import { describe, it, expect } from 'vitest';
import { isAllowedBotStateKey, BOT_STATE_KEYS, AGENT_STATE_KEY } from '../../api/_lib/kv-keys';

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

  it('exposes the expected keys (manual + live wheel state, plus agent state)', () => {
    expect(BOT_STATE_KEYS).toEqual([
      'bot:state:manual',
      'bot:state:live',
      'bot:strategy:manual',
      'bot:strategy:live',
      'bot:rules:manual',
      'bot:rules:live',
      'bot:agent:state',
    ]);
  });

  // Regression: agent-trader.yml has pushed to this key since the agent
  // account shipped, but it was missing from the whitelist, so /api/bot-state
  // rejected every push with 400 invalid_or_unknown_key and the dashboard
  // never saw any agent state.
  it('accepts the agent account state key', () => {
    expect(isAllowedBotStateKey('bot:agent:state')).toBe(true);
    expect(AGENT_STATE_KEY).toBe('bot:agent:state');
  });
});
