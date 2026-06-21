import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Health/latency probe for the header NET + API indicators. Pings the
 * lightweight, auth-protected Alpaca clock endpoint every 30s and times the
 * round trip (dashboard API → Alpaca → back). The query's `data` is the
 * measured latency in ms; `isError` means the probe failed — i.e. a page would
 * be empty right now (Alpaca down, auth expired, or the function erroring),
 * which is exactly what we want to surface as a red API ERR.
 *
 * `retry: false` so a failure shows immediately instead of after backoff.
 */
export function useApiHealth() {
  return useQuery({
    queryKey: ['api-health'],
    queryFn: async () => {
      const t0 = performance.now();
      await api('/api/alpaca/clock');
      return Math.round(performance.now() - t0);
    },
    refetchInterval: 30_000,
    staleTime: 30_000,
    retry: false,
  });
}
