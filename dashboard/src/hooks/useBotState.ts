import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface BotStateResponse {
  key: string;
  payload: any;
  lastUpdate: string | null;
}

export function useBotWheelState(mode: 'manual' | 'live') {
  const key = `bot:state:${mode}`;
  return useQuery({
    queryKey: ['bot-state', key],
    queryFn: () => api<BotStateResponse>(`/api/kv/bot-state?key=${encodeURIComponent(key)}`),
    staleTime: 60_000,
  });
}
