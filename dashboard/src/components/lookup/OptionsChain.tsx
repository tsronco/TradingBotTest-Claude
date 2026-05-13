import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useEffect, useMemo, useState } from 'react';
import { useAccount } from '../../hooks/useAccount';
import type { AccountMode } from '../../hooks/useAccount';
import { selectModeFromAccountMode, modeToAccount, type AnyAccountId } from '../../lib/account-utils';
import { GreekHeader } from '../GreekLabel';

function accountForMode(mode: AccountMode): AnyAccountId {
  return modeToAccount(selectModeFromAccountMode(mode));
}

interface OptionContract {
  symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
}
interface OptionSnapshot {
  latestQuote?: { ap: number; bp: number };
  greeks?: { delta: number; gamma: number; theta: number; vega: number };
  impliedVolatility?: number;
  openInterest?: number;
  dailyBar?: { v: number };
}
interface ChainResponse {
  contracts: OptionContract[];
  snapshots: Record<string, OptionSnapshot>;
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
  const navigate = useNavigate();
  const [accountMode] = useAccount();

  // Two-query pattern: cheap "expirations only" fetch on mount populates the
  // dropdown; per-expiration "with snapshots" fetch fires on dropdown change.
  // Avoids the old 300-symbol cap that left far-dated expirations dataless.
  const expirationsQ = useQuery({
    queryKey: ['chain-expirations', symbol],
    queryFn: () => api<ChainResponse>(`/api/alpaca/chain?symbol=${symbol}`),
  });

  const snapshotsQ = useQuery({
    queryKey: ['chain-snapshots', symbol, selectedExp],
    queryFn: () =>
      api<ChainResponse>(`/api/alpaca/chain?symbol=${symbol}&expiration=${selectedExp}`),
    enabled: !!selectedExp,
  });

  // Reset selection when symbol changes (no cross-symbol leak).
  useEffect(() => {
    setSelectedExp(null);
  }, [symbol]);

  // Pull current price from the same query the QuotePanel uses — React Query
  // dedupes, so this is free.
  const quoteQ = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`),
  });
  const snap = quoteQ.data?.snapshot?.[symbol];
  const stockPrice: number | undefined = snap?.latestTrade?.p ?? snap?.dailyBar?.c;

  // Expirations from the lightweight query.
  const expirations = useMemo(() => {
    const set = new Set<string>();
    for (const c of expirationsQ.data?.contracts ?? []) set.add(c.expiration_date);
    return Array.from(set).sort();
  }, [expirationsQ.data]);

  // Default selection = nearest expiration once data arrives.
  useEffect(() => {
    if (expirations.length > 0 && (!selectedExp || !expirations.includes(selectedExp))) {
      setSelectedExp(expirations[0]);
    }
  }, [expirations, selectedExp]);

  if (expirationsQ.isLoading || !expirationsQ.data) {
    return <div className="text-muted text-sm">Loading options chain…</div>;
  }
  if (expirationsQ.data.contracts.length === 0) {
    return <div className="text-muted text-sm">No option contracts available for {symbol}.</div>;
  }

  const exp = selectedExp ?? expirations[0];
  // Contracts and snapshots both come from the per-expiration query when ready;
  // fall back to the expirations-only contracts so the strike list renders even
  // before snapshots arrive (rows just show — for quotes during the brief load).
  const expContracts = snapshotsQ.data?.contracts
    ?? (expirationsQ.data.contracts.filter((c) => c.expiration_date === exp));
  const snapshots = snapshotsQ.data?.snapshots ?? {};
  const isSnapshotsLoading = snapshotsQ.isFetching;

  const sideFiltered = expContracts.filter(
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
          {isSnapshotsLoading && (
            <span className="text-dim text-[10px] tracking-[0.15em] animate-pulse ml-1">
              loading quotes…
            </span>
          )}

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
      {/* Sticky-header scrollable container so the strike/type/bid/ask row stays
          visible when "show all" expands to 100+ rows. max-h sized so the table
          doesn't push the page-level layout (Earnings, News, etc.) below the fold. */}
      <div className="max-h-[60vh] overflow-y-auto chain-scroll">
      <table className="w-full text-[12px] tnum">
        <thead className="text-dim uppercase tracking-[0.15em] text-[10px] sticky top-0 bg-panel z-10">
          <tr className="border-t border-b border-border">
            <th className="text-left px-2 py-1.5 font-normal">strike</th>
            <th className="text-left px-2 py-1.5 font-normal">type</th>
            <th className="text-right px-2 py-1.5 font-normal">bid</th>
            <th className="text-right px-2 py-1.5 font-normal">ask</th>
            <th className="text-right px-2 py-1.5 font-normal"><GreekHeader k="iv" /></th>
            <th className="text-right px-2 py-1.5 font-normal"><GreekHeader k="delta" /></th>
            {showAllGreeks && <th className="text-right px-2 py-1.5 font-normal"><GreekHeader k="gamma" /></th>}
            <th className="text-right px-2 py-1.5 font-normal"><GreekHeader k="theta" /></th>
            {showAllGreeks && <th className="text-right px-2 py-1.5 font-normal"><GreekHeader k="vega" /></th>}
            <th className="text-right px-2 py-1.5 font-normal"><GreekHeader k="oi" /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const cs = snapshots[c.symbol] ?? {};
            const g = cs.greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
            const klass = c.type === 'call' ? 'text-cyan' : 'text-red';
            return (
              <tr
                key={c.symbol}
                className="border-b border-border/50 hover:bg-panel-2/40 transition-colors cursor-pointer"
                onClick={() => navigate(`/order/new?contract=${c.symbol}&action=open&account=${accountForMode(accountMode)}`)}
              >
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
    </div>
  );
}
