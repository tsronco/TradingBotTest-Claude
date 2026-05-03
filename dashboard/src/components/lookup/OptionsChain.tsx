import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useEffect, useMemo, useState } from 'react';

interface ChainResponse {
  contracts: Array<{
    symbol: string;
    underlying_symbol: string;
    expiration_date: string;
    strike_price: string;
    type: 'call' | 'put';
  }>;
  snapshots: Record<string, {
    latestQuote?: { ap: number; bp: number };
    greeks?: { delta: number; gamma: number; theta: number; vega: number };
    impliedVolatility?: number;
    openInterest?: number;
    dailyBar?: { v: number };
  }>;
}

const NEAREST_STRIKE_COUNT = 6;

export default function OptionsChain({ symbol }: { symbol: string }) {
  const [showAllGreeks, setShowAllGreeks] = useState(false);
  const [selectedExp, setSelectedExp] = useState<string | null>(null);
  const [showAllStrikes, setShowAllStrikes] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['chain', symbol],
    queryFn: () => api<ChainResponse>(`/api/alpaca/chain?symbol=${symbol}`),
  });

  // Pull current price from the same query the QuotePanel uses — React Query
  // dedupes, so this is free.
  const quoteQ = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`),
  });
  const snap = quoteQ.data?.snapshot?.[symbol];
  const stockPrice: number | undefined = snap?.latestTrade?.p ?? snap?.dailyBar?.c;

  // Group by expiration; default selection = nearest expiration once data arrives.
  const { byExp, expirations } = useMemo(() => {
    const grouped: Record<string, NonNullable<ChainResponse['contracts']>> = {};
    for (const c of data?.contracts ?? []) {
      (grouped[c.expiration_date] ??= []).push(c);
    }
    return { byExp: grouped, expirations: Object.keys(grouped).sort() };
  }, [data]);

  // Reset selection when symbol changes or first render.
  useEffect(() => {
    if (expirations.length > 0 && (!selectedExp || !expirations.includes(selectedExp))) {
      setSelectedExp(expirations[0]);
    }
  }, [expirations, selectedExp]);

  if (isLoading || !data) return <div className="text-muted text-sm">Loading options chain…</div>;
  if (data.contracts.length === 0) {
    return <div className="text-muted text-sm">No option contracts available for {symbol}.</div>;
  }

  const exp = selectedExp ?? expirations[0];
  const allRows = (byExp[exp] ?? []).slice().sort((a, b) =>
    Number(a.strike_price) - Number(b.strike_price)
  );

  // Compute the visible rows. Default = 6 strikes nearest to current market price
  // (selecting strikes by absolute distance to stockPrice, then re-sorting by
  // strike for display). If price isn't loaded yet, fall back to all rows.
  let rows = allRows;
  if (!showAllStrikes && stockPrice != null) {
    // Each strike has up to 2 rows (call + put). Group by strike, sort strikes
    // by distance to price, take the 6 nearest, then expand back to rows.
    const strikes = Array.from(new Set(allRows.map((c) => Number(c.strike_price))));
    const nearestStrikes = strikes
      .slice()
      .sort((a, b) => Math.abs(a - stockPrice) - Math.abs(b - stockPrice))
      .slice(0, NEAREST_STRIKE_COUNT);
    const keep = new Set(nearestStrikes);
    rows = allRows.filter((c) => keep.has(Number(c.strike_price)));
  }

  const totalStrikes = new Set(allRows.map((c) => c.strike_price)).size;
  const isFiltered = !showAllStrikes && stockPrice != null && totalStrikes > NEAREST_STRIKE_COUNT;

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted">Exp</label>
          <select
            value={exp}
            onChange={(e) => setSelectedExp(e.target.value)}
            className="bg-panel-2 text-text border border-border rounded px-1.5 py-0.5 text-xs"
          >
            {expirations.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          {isFiltered ? (
            <button
              onClick={() => setShowAllStrikes(true)}
              className="text-muted hover:text-text underline text-[10px]"
            >
              Show all ({totalStrikes} strikes)
            </button>
          ) : showAllStrikes && totalStrikes > NEAREST_STRIKE_COUNT ? (
            <button
              onClick={() => setShowAllStrikes(false)}
              className="text-muted hover:text-text underline text-[10px]"
            >
              Show {NEAREST_STRIKE_COUNT} nearest
            </button>
          ) : null}
        </div>
        <label className="text-muted text-xs flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showAllGreeks}
            onChange={(e) => setShowAllGreeks(e.target.checked)}
          />
          All Greeks
        </label>
      </div>
      <table className="w-full text-xs">
        <thead className="text-muted uppercase tracking-wider text-[9px]">
          <tr>
            <th className="text-left px-2 py-1">Strike</th>
            <th className="text-left px-2 py-1">Type</th>
            <th className="text-right px-2 py-1">Bid</th>
            <th className="text-right px-2 py-1">Ask</th>
            <th className="text-right px-2 py-1">IV</th>
            <th className="text-right px-2 py-1">Δ</th>
            {showAllGreeks && <th className="text-right px-2 py-1">Γ</th>}
            <th className="text-right px-2 py-1">Θ</th>
            {showAllGreeks && <th className="text-right px-2 py-1">ν</th>}
            <th className="text-right px-2 py-1">OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const cs = data.snapshots[c.symbol] ?? {};
            const g = cs.greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
            const klass = c.type === 'call' ? 'text-red' : 'text-green';
            return (
              <tr key={c.symbol} className="border-t border-border">
                <td className="px-2 py-1 text-text">{fmtUsd(Number(c.strike_price))}</td>
                <td className={`px-2 py-1 ${klass}`}>{c.type === 'call' ? 'C' : 'P'}</td>
                <td className="px-2 py-1 text-right">{cs.latestQuote?.bp?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{cs.latestQuote?.ap?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{cs.impliedVolatility ? fmtPct(cs.impliedVolatility * 100) : '—'}</td>
                <td className="px-2 py-1 text-right">{g.delta?.toFixed(3) ?? '—'}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right">{g.gamma?.toFixed(4) ?? '—'}</td>}
                <td className="px-2 py-1 text-right">{g.theta?.toFixed(3) ?? '—'}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right">{g.vega?.toFixed(3) ?? '—'}</td>}
                <td className="px-2 py-1 text-right">{cs.openInterest ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
