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

/** Color delta by proximity to the wheel-strategy target of |Δ| ≈ 0.30.
 *  Cyan = sweet spot (0.28–0.32). Green = acceptable band (0.25–0.40).
 *  Bright red = out of range. Uses absolute value so puts (negative Δ) work
 *  the same as calls (positive Δ). */
function deltaColorClass(delta: number | undefined | null): string {
  if (delta == null || Number.isNaN(delta)) return 'text-mid';
  const abs = Math.abs(delta);
  if (abs >= 0.28 && abs <= 0.32) return 'text-cyan font-semibold';
  if (abs >= 0.25 && abs <= 0.40) return 'text-hi';
  return 'text-red font-bold';
}

function fmtUSDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

type SideFilter = 'puts' | 'calls' | 'both';

export default function OptionsChain({ symbol }: { symbol: string }) {
  const [showAllGreeks, setShowAllGreeks] = useState(false);
  const [selectedExp, setSelectedExp] = useState<string | null>(null);
  const [showAllStrikes, setShowAllStrikes] = useState(false);
  const [side, setSide] = useState<SideFilter>('puts');

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
  const sideFiltered = (byExp[exp] ?? []).filter(
    (c) => side === 'both' || (side === 'puts' ? c.type === 'put' : c.type === 'call')
  );
  const allRows = sideFiltered.slice().sort((a, b) =>
    Number(a.strike_price) - Number(b.strike_price)
  );

  // Compute the visible rows. Default = 6 strikes nearest to current market price
  // (selecting strikes by absolute distance to stockPrice, then re-sorting by
  // strike for display). If price isn't loaded yet, fall back to all rows.
  let rows = allRows;
  if (!showAllStrikes && stockPrice != null) {
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
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap text-[11px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-dim tracking-[0.15em]">EXP</span>
          <select
            value={exp}
            onChange={(e) => setSelectedExp(e.target.value)}
            className="bg-panel-2 text-fg border border-border rounded-sm px-2 py-0.5 text-[11px] focus:outline-none focus:border-hi"
          >
            {expirations.map((e) => (
              <option key={e} value={e}>{fmtUSDate(e)}</option>
            ))}
          </select>

          <div className="inline-flex gap-1 ml-1">
            {(['puts', 'calls', 'both'] as const).map((s) => {
              const isActive = side === s;
              const activeColor =
                s === 'puts' ? (isActive ? 'bg-red/15 text-red border-red/60' : '')
                : s === 'calls' ? (isActive ? 'bg-cyan/15 text-cyan border-cyan/60' : '')
                : (isActive ? 'bg-hi/15 text-hi border-hi/60' : '');
              return (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={`pbtn ${isActive ? 'active' : ''} ${activeColor}`}
                  type="button"
                >
                  [{s}{isActive ? '*' : ''}]
                </button>
              );
            })}
          </div>

          {isFiltered ? (
            <button
              onClick={() => setShowAllStrikes(true)}
              className="text-dim hover:text-hi text-[10px] ml-1"
              type="button"
            >
              show all ({totalStrikes})
            </button>
          ) : showAllStrikes && totalStrikes > NEAREST_STRIKE_COUNT ? (
            <button
              onClick={() => setShowAllStrikes(false)}
              className="text-dim hover:text-hi text-[10px] ml-1"
              type="button"
            >
              show {NEAREST_STRIKE_COUNT} nearest
            </button>
          ) : null}
        </div>
        <label className="text-dim text-[11px] flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showAllGreeks}
            onChange={(e) => setShowAllGreeks(e.target.checked)}
          />
          all greeks
        </label>
      </div>
      <table className="w-full text-[12px] tnum">
        <thead className="text-dim uppercase tracking-[0.15em] text-[10px]">
          <tr className="border-t border-b border-border">
            <th className="text-left px-2 py-1.5 font-normal">strike</th>
            <th className="text-left px-2 py-1.5 font-normal">type</th>
            <th className="text-right px-2 py-1.5 font-normal">bid</th>
            <th className="text-right px-2 py-1.5 font-normal">ask</th>
            <th className="text-right px-2 py-1.5 font-normal">IV</th>
            <th className="text-right px-2 py-1.5 font-normal">Δ</th>
            {showAllGreeks && <th className="text-right px-2 py-1.5 font-normal">Γ</th>}
            <th className="text-right px-2 py-1.5 font-normal">Θ</th>
            {showAllGreeks && <th className="text-right px-2 py-1.5 font-normal">ν</th>}
            <th className="text-right px-2 py-1.5 font-normal">OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const cs = data.snapshots[c.symbol] ?? {};
            const g = cs.greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
            const klass = c.type === 'call' ? 'text-cyan' : 'text-red';
            return (
              <tr key={c.symbol} className="border-b border-border/50 hover:bg-panel-2/40 transition-colors">
                <td className="px-2 py-1 text-fg">{fmtUsd(Number(c.strike_price))}</td>
                <td className={`px-2 py-1 ${klass} font-semibold`}>{c.type === 'call' ? 'C' : 'P'}</td>
                <td className="px-2 py-1 text-right text-fg">{cs.latestQuote?.bp?.toFixed(2) ?? <span className="text-dim">—</span>}</td>
                <td className="px-2 py-1 text-right text-fg">{cs.latestQuote?.ap?.toFixed(2) ?? <span className="text-dim">—</span>}</td>
                <td className="px-2 py-1 text-right text-mid">{cs.impliedVolatility ? fmtPct(cs.impliedVolatility * 100) : <span className="text-dim">—</span>}</td>
                <td className={`px-2 py-1 text-right ${deltaColorClass(g.delta)}`}>{g.delta?.toFixed(3) ?? <span className="text-dim">—</span>}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right text-mid">{g.gamma?.toFixed(4) ?? <span className="text-dim">—</span>}</td>}
                <td className="px-2 py-1 text-right text-mid">{g.theta?.toFixed(3) ?? <span className="text-dim">—</span>}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right text-mid">{g.vega?.toFixed(3) ?? <span className="text-dim">—</span>}</td>}
                <td className="px-2 py-1 text-right text-mid">{cs.openInterest ?? <span className="text-dim">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
