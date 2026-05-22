import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd } from '../lib/format';
import Sparkline from '../components/Sparkline';
import { useDisplayName } from '../hooks/useDisplayName';

export default function Watchlist() {
  const qc = useQueryClient();
  const [newSymbol, setNewSymbol] = useState('');
  const { handle } = useDisplayName();

  const list = useQuery({
    queryKey: ['watchlist'],
    queryFn: () => api<{ watchlist: string[] }>('/api/kv/watchlist'),
  });

  const add = useMutation({
    mutationFn: (symbol: string) =>
      api('/api/kv/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      setNewSymbol('');
    },
  });

  const remove = useMutation({
    mutationFn: (symbol: string) =>
      api('/api/kv/watchlist', { method: 'DELETE', body: JSON.stringify({ symbol }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  function handleAdd() {
    const s = newSymbol.trim().toUpperCase();
    if (!s) return;
    add.mutate(s);
  }

  function handleRemove(s: string) {
    if (!confirm(`Remove ${s} from watchlist?`)) return;
    remove.mutate(s);
  }

  return (
    <div className="p-3 md:p-6 max-w-4xl">
      <div className="text-mid text-[12px] mb-4">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/watchlist</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">cat symbols</span>
      </div>
      <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi mt-2">Watchlist</h1>

      <div className="flex gap-2 mt-4">
        <input
          placeholder="symbol (e.g. NVDA)"
          value={newSymbol}
          onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="bg-panel-2 border border-border focus:border-cyan rounded-sm px-3 py-1.5 text-fg text-[12px] tnum w-32 outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={!newSymbol.trim() || add.isPending}
          className="pbtn active border border-hi/60 text-hi disabled:opacity-50"
        >
          [+ add]
        </button>
      </div>

      {list.isLoading && <div className="mt-4 text-dim text-[11px]">loading…</div>}
      {list.data && list.data.watchlist.length === 0 && (
        <div className="mt-4 text-dim text-[11px]">empty — add a symbol above</div>
      )}
      {list.data && list.data.watchlist.length > 0 && (
        <div className="mt-4 border border-border bg-panel/60 overflow-x-auto rtable">
          <table className="w-full text-[11px]">
            <thead className="text-dim text-[10px] uppercase tracking-[0.15em]">
              <tr className="border-b border-border">
                <th className="text-left px-3 py-2">symbol</th>
                <th className="text-right px-3 py-2">price</th>
                <th className="text-right px-3 py-2">day %</th>
                <th className="px-3 py-2">30d</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.data.watchlist.map((symbol) => (
                <WatchlistRow key={symbol} symbol={symbol} onRemove={() => handleRemove(symbol)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WatchlistRow({ symbol, onRemove }: { symbol: string; onRemove: () => void }) {
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
  const dayChangePct = (last != null && prev != null && prev > 0) ? ((last - prev) / prev) * 100 : null;

  const closes = (bars.data?.bars ?? []).map((b) => b.c);

  return (
    <tr className="border-b border-border/50 hover:bg-panel-2/30">
      <td data-primary className="px-3 py-2 font-mono">
        <Link to={`/lookup/${symbol}`} className="text-cyan hover:underline">{symbol}</Link>
      </td>
      <td data-label="price" className="px-3 py-2 text-right tnum text-fg">
        {last != null ? fmtUsd(last) : <span className="text-dim">—</span>}
      </td>
      <td data-label="day %" className={`px-3 py-2 text-right tnum ${dayChangePct == null ? 'text-dim' : dayChangePct >= 0 ? 'text-hi' : 'text-red'}`}>
        {dayChangePct == null ? '—' : `${dayChangePct >= 0 ? '+' : ''}${dayChangePct.toFixed(2)}%`}
      </td>
      <td data-label="30d" className="px-3 py-2">
        {closes.length > 0 ? <Sparkline values={closes} width={120} height={24} /> : <span className="text-dim text-[10px]">—</span>}
      </td>
      <td data-label="action" className="px-3 py-2 text-right">
        <button onClick={onRemove} className="text-red text-[10px] hover:underline">[×]</button>
      </td>
    </tr>
  );
}
