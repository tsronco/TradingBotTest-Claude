import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { AlpacaClock } from '../lib/market-status';

interface ClockResponse {
  mode: string;
  clock: AlpacaClock;
}

/**
 * Fetches Alpaca's authoritative NYSE clock for the header market-status pill.
 * Account-agnostic (clock is the same for every account), so it omits `mode`
 * and lets the API default to conservative paper creds. Refreshes every 60s so
 * the open→closed (and closed→open) transition flips without a page reload;
 * the local calendar in `computeMarketStatus` covers the gap if this fails.
 */
export function useMarketClock() {
  return useQuery({
    queryKey: ['market-clock'],
    queryFn: () => api<ClockResponse>('/api/alpaca/clock'),
    staleTime: 60_000,
    refetchInterval: 60_000,
    select: (r) => r.clock,
  });
}
