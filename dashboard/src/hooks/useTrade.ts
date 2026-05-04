// dashboard/src/hooks/useTrade.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Trade, GradeRecord } from '../lib/trade-types';

export function useTrade(id: string | undefined) {
  return useQuery({
    queryKey: ['trade', id],
    queryFn: () => api<{ trade: Trade; grade: GradeRecord }>(`/api/trades/get?id=${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  });
}
