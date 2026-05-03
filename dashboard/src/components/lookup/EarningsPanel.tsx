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
  if (isLoading) return <div className="text-dim text-[11px]">loading earnings…</div>;
  if (!data) return <div className="text-dim text-[11px]">no earnings data.</div>;

  if (data.error) {
    return (
      <div className="text-dim text-[11px] leading-relaxed">
        earnings temporarily unavailable{data.detail ? ` — ${data.detail}` : '.'}
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

  const allValues = past
    .flatMap((e) => [e.eps_estimate ?? 0, e.reported_eps ?? 0])
    .filter((v) => v > 0);
  const maxEps = allValues.length > 0 ? Math.max(...allValues) : 1;

  if (past.length === 0 && !next) {
    return (
      <div className="text-dim text-[11px]">
        no earnings history available for {symbol}{partial ? ' (data may be partial)' : ''}.
      </div>
    );
  }

  const beatRateColor = past.length === 0 ? 'text-dim'
    : beats === past.length ? 'text-hi'
    : beats >= past.length / 2 ? 'text-amber'
    : 'text-red';

  return (
    <div>
      <div className="flex items-baseline justify-between border-b border-border pb-3 mb-3 gap-3 flex-wrap">
        <div>
          <div className="text-dim text-[10px] tracking-[0.25em] uppercase">next report</div>
          <div className="text-amber text-[18px] font-bold tnum leading-tight mt-0.5">
            {next ? new Date(next.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
          </div>
          <div className="text-dim text-[11px] tnum">
            {next?.eps_estimate != null ? <>est. EPS <span className="text-fg">${next.eps_estimate.toFixed(2)}</span></> : 'no estimate'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-dim text-[10px] tracking-[0.25em] uppercase">beat rate</div>
          <div className={`text-[18px] font-bold tnum leading-tight mt-0.5 ${beatRateColor}`}>
            {beats}<span className="text-dim"> / </span>{past.length}
          </div>
          <div className="text-dim text-[11px]">last {past.length}q</div>
        </div>
      </div>

      {past.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {past.map((e) => {
            const beat = (e.surprise_pct ?? 0) >= 0;
            const estH = Math.max(((e.eps_estimate ?? 0) / maxEps) * 95, 4);
            const actH = Math.max(((e.reported_eps ?? 0) / maxEps) * 95, 4);
            return (
              <div key={e.date} className="flex flex-col items-center">
                <div className="flex items-end gap-1.5 h-[80px]" title={`est ${e.eps_estimate?.toFixed(2)} · actual ${e.reported_eps?.toFixed(2)}`}>
                  <div className="w-4 bg-panel-2 border border-border rounded-sm" style={{ height: `${estH}%` }} />
                  <div className={`w-4 rounded-sm ${beat ? 'bg-hi' : 'bg-red'}`} style={{ height: `${actH}%` }} />
                </div>
                <div className="text-dim text-[10px] mt-1.5 tracking-[0.1em] uppercase">{new Date(e.date).toLocaleDateString('en-US', { month: 'short' })}</div>
                <div className={`text-[10px] font-semibold tnum ${beat ? 'text-hi' : 'text-red'}`}>
                  {(e.surprise_pct ?? 0) >= 0 ? '+' : ''}{(e.surprise_pct ?? 0).toFixed(0)}%
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 text-[10px] text-dim flex items-center gap-3 flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-panel-2 border border-border rounded-sm" /> est.</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-hi rounded-sm" /> beat</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-red rounded-sm" /> miss</span>
      </div>

      {partial && (
        <div className="text-dim text-[10px] mt-2 italic">data may be partial</div>
      )}
    </div>
  );
}
