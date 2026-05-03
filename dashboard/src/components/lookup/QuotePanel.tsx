import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';

export default function QuotePanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`),
    refetchInterval: 15_000,
  });
  if (isLoading || !data) return <div className="text-muted text-sm">Loading quote…</div>;

  const snap = data.snapshot?.[symbol] ?? data.snapshot;
  const last = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  const prev = snap?.prevDailyBar?.c;
  const change = last && prev ? last - prev : null;
  const changePct = change && prev ? (change / prev) * 100 : null;
  const klass = change && change > 0 ? 'text-green' : 'text-red';

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-text-strong text-2xl font-bold">{fmtUsd(last)}</span>
        {change !== null && (
          <span className={`text-sm ${klass}`}>
            {fmtUsd(change, { sign: true })} ({fmtPct(changePct, { sign: true })})
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-y-1 mt-3 text-xs">
        <dt className="text-muted">Bid / Ask</dt>
        <dd className="text-text text-right">
          {snap?.latestQuote ? `${snap.latestQuote.bp} / ${snap.latestQuote.ap}` : '—'}
        </dd>
        <dt className="text-muted">Day range</dt>
        <dd className="text-text text-right">
          {snap?.dailyBar ? `${snap.dailyBar.l} — ${snap.dailyBar.h}` : '—'}
        </dd>
        <dt className="text-muted">Volume</dt>
        <dd className="text-text text-right">{fmtNum(snap?.dailyBar?.v)}</dd>
      </dl>
    </div>
  );
}
