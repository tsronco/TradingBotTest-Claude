import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useState } from 'react';

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

export default function OptionsChain({ symbol }: { symbol: string }) {
  const [showAllGreeks, setShowAllGreeks] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['chain', symbol],
    queryFn: () => api<ChainResponse>(`/api/alpaca/chain?symbol=${symbol}`),
  });

  if (isLoading || !data) return <div className="text-muted text-sm">Loading options chain…</div>;
  if (data.contracts.length === 0) {
    return <div className="text-muted text-sm">No option contracts available for {symbol}.</div>;
  }

  // Group by expiration; pick the nearest one for default view.
  const byExp: Record<string, typeof data.contracts> = {};
  for (const c of data.contracts) {
    (byExp[c.expiration_date] ??= []).push(c);
  }
  const expirations = Object.keys(byExp).sort();
  const nearest = expirations[0];
  const rows = (byExp[nearest] ?? []).slice().sort((a, b) =>
    Number(a.strike_price) - Number(b.strike_price)
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-muted text-xs">
          Exp <b className="text-text">{nearest}</b> ({expirations.length} expirations available)
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
            const snap = data.snapshots[c.symbol] ?? {};
            const g = snap.greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
            const klass = c.type === 'call' ? 'text-red' : 'text-green';
            return (
              <tr key={c.symbol} className="border-t border-border">
                <td className="px-2 py-1 text-text">{fmtUsd(Number(c.strike_price))}</td>
                <td className={`px-2 py-1 ${klass}`}>{c.type === 'call' ? 'C' : 'P'}</td>
                <td className="px-2 py-1 text-right">{snap.latestQuote?.bp?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{snap.latestQuote?.ap?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{snap.impliedVolatility ? fmtPct(snap.impliedVolatility * 100) : '—'}</td>
                <td className="px-2 py-1 text-right">{g.delta?.toFixed(3) ?? '—'}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right">{g.gamma?.toFixed(4) ?? '—'}</td>}
                <td className="px-2 py-1 text-right">{g.theta?.toFixed(3) ?? '—'}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right">{g.vega?.toFixed(3) ?? '—'}</td>}
                <td className="px-2 py-1 text-right">{snap.openInterest ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
