import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';

interface QuoteSnap {
  latestTrade?: { p: number };
  latestQuote?: { ap: number; bp: number };
  dailyBar?: { c: number; h: number; l: number; v: number };
  prevDailyBar?: { c: number };
}
interface QuoteResp {
  snapshot?: Record<string, QuoteSnap> | QuoteSnap;
}

export default function QuotePanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<QuoteResp>(`/api/alpaca/quote?symbol=${symbol}`),
    refetchInterval: 15_000,
  });
  if (isLoading || !data) return <div className="text-dim text-[12px]">loading quote…</div>;

  const snap: QuoteSnap | undefined = (data.snapshot && typeof data.snapshot === 'object' && symbol in data.snapshot)
    ? (data.snapshot as Record<string, QuoteSnap>)[symbol]
    : (data.snapshot as QuoteSnap | undefined);
  const last = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  const prev = snap?.prevDailyBar?.c;
  const change = last && prev ? last - prev : null;
  const changePct = change && prev ? (change / prev) * 100 : null;
  const positive = change != null && change >= 0;

  return (
    <div>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-hi text-[28px] font-bold tnum leading-none">{fmtUsd(last)}</span>
        {change !== null && (
          <span className={`text-[12px] tnum ${positive ? 'text-hi' : 'text-red'}`}>
            {positive ? '▲' : '▼'} {fmtUsd(Math.abs(change), { sign: false }).replace('-$', '$')}
            <span className="text-dim"> ({fmtPct(changePct ?? 0, { sign: true }).replace('-', '−')})</span>
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-y-1 mt-3 text-[11px] tnum">
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">bid / ask</dt>
        <dd className="text-fg text-right">
          {snap?.latestQuote ? `${snap.latestQuote.bp} / ${snap.latestQuote.ap}` : <span className="text-dim">—</span>}
        </dd>
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">day range</dt>
        <dd className="text-fg text-right">
          {snap?.dailyBar ? `${snap.dailyBar.l} — ${snap.dailyBar.h}` : <span className="text-dim">—</span>}
        </dd>
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">volume</dt>
        <dd className="text-fg text-right">{fmtNum(snap?.dailyBar?.v)}</dd>
      </dl>
    </div>
  );
}
