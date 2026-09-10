import { describe, it, expect } from 'vitest';
import { isAllowedBotStateKey, BOT_STATE_KEYS, AGENT_STATE_KEY, LIVE_BRIEF_KEY } from '../../api/_lib/kv-keys';

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

  it('exposes the expected keys (manual + live wheel state, agent state, live brief)', () => {
    expect(BOT_STATE_KEYS).toEqual([
      'bot:state:manual',
      'bot:state:live',
      'bot:strategy:manual',
      'bot:strategy:live',
      'bot:rules:manual',
      'bot:rules:live',
      'bot:agent:state',
      'bot:live:brief',
    ]);
  });

  // live-brief.yml pushes live_brief_state.json here after the 9:40 ET run. Same
  // class of bug as the agent key above: a push to an un-whitelisted key fails
  // silently (fire-and-forget) and the Home card never shows a brief.
  it('accepts the live morning-brief key', () => {
    expect(isAllowedBotStateKey('bot:live:brief')).toBe(true);
    expect(LIVE_BRIEF_KEY).toBe('bot:live:brief');
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
