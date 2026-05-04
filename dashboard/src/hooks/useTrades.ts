// dashboard/src/hooks/useTrades.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Trade } from '../lib/trade-types';

export interface TradesFilters {
  account?: string;
  asset_class?: string;
  tag?: string;
  grade?: string;
  status?: 'open' | 'closed';
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface TradeGradeSummary {
  trade_id: string;
  ai_letter: string | null;
  calibration: 'matched' | 'over_1' | 'over_2' | 'under_1' | 'under_2' | null;
}

export interface TradesResponse {
  trades: Trade[];
  grades: TradeGradeSummary[];
  total: number;
  summary: {
    count: number;
    win_rate: number;
    calibration: { matched: number; over: number; under: number };
  };
}

export function useTrades(filters: TradesFilters) {
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  return useQuery({
    queryKey: ['trades', filters],
    queryFn: () => api<TradesResponse>(`/api/trades/list?${qs}`),
  });
}
