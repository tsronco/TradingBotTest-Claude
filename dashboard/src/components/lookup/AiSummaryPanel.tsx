import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';

interface SummaryResp {
  symbol: string;
  summary: string;
  generated_at: string;
  model: string;
  cached: boolean;
}

const STALE_MS = 15 * 60 * 1000; // matches the server-side 15-min KV cache

function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1m ago';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1h ago' : `${hrs}h ago`;
}

export default function AiSummaryPanel({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ai-summary', symbol],
    queryFn: () => api<SummaryResp>(`/api/alpaca/ai-summary?symbol=${symbol}`),
    enabled: !!symbol,
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: () => api<SummaryResp>(`/api/alpaca/ai-summary?symbol=${symbol}&refresh=1`),
    onSuccess: (fresh) => qc.setQueryData(['ai-summary', symbol], fresh),
  });

  const busy = isLoading || refresh.isPending;

  if (busy) {
    return (
      <div className="flex items-center gap-2 text-dim text-[12px]">
        <Sparkles size={13} className="animate-pulse text-amber" />
        <span>{refresh.isPending ? 'regenerating summary…' : 'reading the tape — searching news, options & earnings…'}</span>
      </div>
    );
  }

  if (isError || !data?.summary) {
    return (
      <div className="flex items-center justify-between gap-2 text-dim text-[12px]">
        <span>AI summary unavailable right now.</span>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="text-cyan hover:text-hi flex items-center gap-1 text-[11px] disabled:opacity-50"
        >
          <RefreshCw size={11} /> retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-fg text-[13px] md:text-[14px] leading-relaxed">{data.summary}</p>
      <div className="mt-3 flex items-center justify-between gap-2 text-dim text-[10px] tracking-[0.1em]">
        <span className="flex items-center gap-1.5">
          <Sparkles size={10} className="text-amber" />
          Updated {relTime(data.generated_at)} · AI-powered, not advice
        </span>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="text-mid hover:text-cyan flex items-center gap-1 disabled:opacity-50 transition-colors"
          title="Generate a fresh summary"
        >
          <RefreshCw size={10} /> refresh
        </button>
      </div>
    </div>
  );
}
