import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { isWheelMode, type Mode } from '../lib/account-utils';
import type { AgentState } from '../lib/agent-state';

interface BotStateResponse {
  key: string;
  payload: any;
  lastUpdate: string | null;
}

/**
 * Wheel state (`bot:state:<mode>`) for a wheel-running account.
 *
 * The agent account runs a different engine and has no wheel state, so the
 * query is disabled for it and callers see `data === undefined` — the same
 * shape they already handle while a wheel query is in flight. Callers must not
 * assume a payload; every consumer already defaults to `{}`.
 */
export function useBotWheelState(mode: Mode) {
  const enabled = isWheelMode(mode);
  const key = `bot:state:${mode}`;
  return useQuery({
    queryKey: ['bot-state', key],
    queryFn: () => api<BotStateResponse>(`/api/kv/bot-state?key=${encodeURIComponent(key)}`),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * The autonomous agent account's state document (`bot:agent:state`) — open
 * positions with their entry theses, closed-trade lesson records, and cycle
 * metadata. Pushed by agent-trader.yml after every hourly cycle.
 */
export function useAgentState() {
  return useQuery({
    queryKey: ['bot-state', 'bot:agent:state'],
    queryFn: () =>
      api<{ key: string; payload: AgentState | null; lastUpdate: string | null }>(
        '/api/kv/bot-state?key=bot%3Aagent%3Astate',
      ),
    staleTime: 60_000,
  });
}
