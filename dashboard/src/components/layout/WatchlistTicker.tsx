import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';
import Sparkline from '../Sparkline';

const PX_PER_SECOND = 45;
const APPROX_ITEM_PX = 200;

export default function WatchlistTicker() {
  const list = useQuery({
    queryKey: ['watchlist'],
    queryFn: () => api<{ watchlist: string[] }>('/api/kv/watchlist'),
  });

  const symbols = list.data?.watchlist ?? [];
  if (symbols.length === 0) return null;

  const duration = Math.max(20, (symbols.length * APPROX_ITEM_PX) / PX_PER_SECOND);

  return (
    <div
      className="above-crt sticky top-7 z-20 border-b border-border bg-panel/60 backdrop-blur-[1px] overflow-hidden ticker-bar"
      aria-label="Watchlist ticker"
    >
      <div
        className="ticker-track flex items-center gap-6 py-1 whitespace-nowrap"
        style={{ animationDuration: `${duration}s` }}
      >
        {symbols.map((s) => <TickerItem key={`a-${s}`} symbol={s} />)}
        {symbols.map((s) => <TickerItem key={`b-${s}`} symbol={s} />)}
      </div>
    </div>
  );
}

function TickerItem({ symbol }: { symbol: string }) {
  const range = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, []);

  const quote = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${symbol}`),
  });

  const bars = useQuery({
    queryKey: ['bars', symbol, '30d-1Day'],
    queryFn: () => api<{ bars: Array<{ t: string; c: number }> }>(
      `/api/alpaca/bars?symbol=${symbol}&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}&timeframe=1Day`,
    ),
  });

  const snap = quote.data?.snapshot && (
    typeof quote.data.snapshot === 'object' && symbol in quote.data.snapshot
      ? (quote.data.snapshot as any)[symbol]
      : quote.data.snapshot
  );
  const last: number | undefined = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  const prev: number | undefined = snap?.prevDailyBar?.c;
  const pct = (last != null && prev != null && prev > 0) ? ((last - prev) / prev) * 100 : null;
  const closes = (bars.data?.bars ?? []).map((b) => b.c);
  const color = pct == null ? 'text-dim' : pct >= 0 ? 'text-hi' : 'text-red';
  const arrow = pct == null ? '·' : pct >= 0 ? '▲' : '▼';

  return (
    <Link
      to={`/lookup/${symbol}`}
      className="inline-flex items-center gap-2 text-[11px] px-2 rounded-sm hover:bg-panel-2/50"
    >
      <span className="text-cyan font-mono">{symbol}</span>
      <span className="tnum text-fg">{last != null ? fmtUsd(last) : '—'}</span>
      <span className={`tnum ${color}`}>
        {arrow} {pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
      </span>
      {closes.length > 1 && <Sparkline values={closes} width={56} height={16} />}
    </Link>
  );
}
