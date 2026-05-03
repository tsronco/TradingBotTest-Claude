import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface FundResp {
  error?: string;
  detail?: string;
  warnings?: string[];
  fundamentals: { next_earnings_date?: number };
  earnings: Array<{
    date: string;
    eps_estimate: number | null;
    reported_eps: number | null;
    surprise_pct: number | null;
  }>;
}

export default function EarningsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['fundamentals', symbol],
    queryFn: () => api<FundResp>(`/api/fundamentals-proxy?symbol=${symbol}`),
  });
  if (isLoading) return <div className="text-muted text-xs">Loading earnings…</div>;
  if (!data) return <div className="text-muted text-xs">No earnings data.</div>;

  // Hard error from the upstream provider — show the message instead of rendering blank.
  if (data.error) {
    return (
      <div className="text-muted text-xs leading-relaxed">
        Earnings temporarily unavailable{data.detail ? ` — ${data.detail}` : '.'}
      </div>
    );
  }

  const past = (data.earnings ?? [])
    .filter((e) => e.reported_eps != null)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date))
    .slice(-4);
  const next = (data.earnings ?? []).find((e) => e.reported_eps == null);
  const beats = past.filter((e) => (e.surprise_pct ?? 0) > 0).length;
  const partial = (data.warnings?.length ?? 0) > 0;

  // Normalize bar heights to the max EPS across all 4 quarters so visual
  // differences are actually visible — both across quarters (a strong quarter
  // gets visibly taller bars) and within a quarter (a clear miss makes the
  // actual bar visibly shorter than the estimate). The previous formula
  // (50 + eps*5, clamped 20-90) crushed differences to <1pp on typical EPS.
  const allValues = past
    .flatMap((e) => [e.eps_estimate ?? 0, e.reported_eps ?? 0])
    .filter((v) => v > 0);
  const maxEps = allValues.length > 0 ? Math.max(...allValues) : 1;

  if (past.length === 0 && !next) {
    return (
      <div className="text-muted text-xs">
        No earnings history available for {symbol}
        {partial ? ' (data may be partial)' : ''}.
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between border-b border-border pb-3 mb-3">
        <div>
          <div className="text-text-strong text-base font-semibold">
            {next ? new Date(next.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
          </div>
          <div className="text-muted text-[10px]">
            {next?.eps_estimate != null ? `Est. EPS $${next.eps_estimate.toFixed(2)}` : 'no estimate'}
          </div>
        </div>
        <div className="flex gap-4 text-right">
          <div>
            <div className="text-text font-semibold">{beats} / {past.length}</div>
            <div className="text-muted text-[10px] uppercase tracking-wider">Beat rate</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {past.map((e) => {
          const beat = (e.surprise_pct ?? 0) >= 0;
          // Scale to 95% of container max; floor at 4% so tiny / zero values
          // still render as a visible nub instead of disappearing entirely.
          const estH = Math.max(((e.eps_estimate ?? 0) / maxEps) * 95, 4);
          const actH = Math.max(((e.reported_eps ?? 0) / maxEps) * 95, 4);
          return (
            <div key={e.date} className="flex flex-col items-center">
              <div className="flex items-end gap-1.5 h-[90px]">
                <div className="w-5 bg-panel-2 rounded-sm" style={{ height: `${estH}%` }} />
                <div className={`w-5 rounded-sm ${beat ? 'bg-green' : 'bg-red'}`} style={{ height: `${actH}%` }} />
              </div>
              <div className="text-muted text-[10px] mt-1">{new Date(e.date).toLocaleDateString('en-US', { month: 'short' })}</div>
              <div className={`text-[10px] font-semibold ${beat ? 'text-green' : 'text-red'}`}>
                {(e.surprise_pct ?? 0) >= 0 ? '+' : ''}{(e.surprise_pct ?? 0).toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>
      {partial && (
        <div className="text-muted text-[10px] mt-2 italic">data may be partial</div>
      )}
    </div>
  );
}
