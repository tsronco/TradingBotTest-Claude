import { useParams, useNavigate, Link } from 'react-router-dom';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api } from '../lib/api';
import { useAccount } from '../hooks/useAccount';
import { selectModeFromAccountMode, modeToAccount, type AnyAccountId } from '../lib/account-utils';
import type { AccountMode } from '../hooks/useAccount';
import AiSummaryPanel from '../components/lookup/AiSummaryPanel';
import QuotePanel from '../components/lookup/QuotePanel';
import PositionContextPanel from '../components/lookup/PositionContextPanel';
import TradingViewChart from '../components/lookup/TradingViewChart';
import OptionsChain from '../components/lookup/OptionsChain';
import EarningsPanel from '../components/lookup/EarningsPanel';
import WheelabilityPanel from '../components/lookup/WheelabilityPanel';
import NewsPanel from '../components/lookup/NewsPanel';
import FundamentalsPanel from '../components/lookup/FundamentalsPanel';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useDisplayName } from '../hooks/useDisplayName';

function accountForMode(mode: AccountMode): AnyAccountId {
  return modeToAccount(selectModeFromAccountMode(mode));
}

export default function Lookup() {
  const { symbol = '' } = useParams();
  const nav = useNavigate();
  const [search, setSearch] = useState(symbol);
  const sym = symbol.toUpperCase();

  const [accountMode] = useAccount();
  const { handle } = useDisplayName();

  const addToWatchlist = useMutation({
    mutationFn: () => api('/api/kv/watchlist', { method: 'POST', body: JSON.stringify({ symbol: sym }) }),
  });

  // Probe the option chain so we can show the strategy-builder link only when
  // the symbol actually has options. Cash-only / non-optionable names hide it.
  const chainProbe = useQuery({
    queryKey: ['chain-probe', sym],
    queryFn: () => api<{ contracts: unknown[] }>(`/api/alpaca/chain?symbol=${sym}`),
    enabled: !!sym,
    staleTime: 60_000,
  });
  const hasOptions = !!chainProbe.data && Array.isArray(chainProbe.data.contracts) && chainProbe.data.contracts.length > 0;

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const next = search.trim().toUpperCase();
    if (next) nav(`/lookup/${next}`);
  }

  return (
    <div className="p-3 md:p-6 max-w-[1480px]">
      {/* prompt header */}
      <div className="flex items-baseline gap-2 mb-4 text-[12px] flex-wrap">
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
        <span className="text-fg">lookup</span>
        <span className="text-amber">--symbol=<span className="text-fg">{sym || '?'}</span></span>
        <span className="caret" />
      </div>

      {/* title row */}
      <div className="flex flex-wrap items-end justify-between gap-y-3 gap-x-6 mb-5">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-hi text-[28px] md:text-[44px] font-bold leading-none tracking-tight">Lookup</h1>
            {sym && <span className="text-amber text-[28px] font-bold leading-none tnum">· {sym}</span>}
          </div>
          <div className="mt-2 text-mid text-[12px]">
            <span className="text-dim">[</span>
            <span className="text-fg">research</span>
            <span className="text-dim">]</span>
            <span className="text-dim mx-2">·</span>
            <span className="text-dim">chart · options · earnings · fundamentals · news · wheelability</span>
          </div>
        </div>
      </div>

      {/* search form (terminal-style) */}
      <form onSubmit={onSearch} className="mb-5">
        <div className="flex items-center gap-2 bg-panel border border-border rounded-sm px-3 py-2">
          <span className="text-hi text-[14px]">▸</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value.toUpperCase())}
            placeholder="search symbol (e.g. TSLA, SPY, NVDA) and press enter…"
            className="flex-1 bg-transparent text-fg text-[14px] tracking-wider focus:outline-none placeholder:text-dim placeholder:tracking-normal placeholder:lowercase"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="text-dim text-[10px] tracking-[0.25em] hidden md:inline">↵ enter</span>
        </div>
      </form>

      {/* divider */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-5 select-none">
        <span className="whitespace-nowrap">━━━ research</span>
        <span className="text-mid">{sym || '—'}</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ research --symbol=<span className="text-fg">{sym || '?'}</span></span>
      </div>

      {/* AI summary — full-width, top of page */}
      {sym && (
        <div className="mb-6 mt-3">
          <Cell title="AI_SUMMARY" subtitle={sym}>
            <ErrorBoundary label="AI summary">
              <AiSummaryPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
        </div>
      )}

      {/* main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* LEFT 2/3 */}
        <div className="lg:col-span-2 flex flex-col gap-6 mt-3">
          <Cell title="TRADINGVIEW" subtitle={sym}>
            <ErrorBoundary label="Chart">
              <TradingViewChart symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="OPTIONS_CHAIN">
            <ErrorBoundary label="Options chain">
              <OptionsChain symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="EARNINGS">
            <ErrorBoundary label="Earnings">
              <EarningsPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
        </div>

        {/* RIGHT 1/3 */}
        <div className="flex flex-col gap-6 mt-3">
          <Cell title="QUOTE">
            <ErrorBoundary label="Quote/Position">
              <QuotePanel symbol={sym} />
              <div className="my-3 flex items-center gap-2 text-dim text-[10px] tnum select-none">
                <span>├</span>
                <span className="flex-1 border-t border-dashed border-border" />
                <span className="px-1 tracking-[0.25em]">YOUR POSITION</span>
                <span className="flex-1 border-t border-dashed border-border" />
                <span>┤</span>
              </div>
              <PositionContextPanel symbol={sym} />
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => addToWatchlist.mutate()}
                  disabled={addToWatchlist.isPending || addToWatchlist.isSuccess}
                  className="flex-1 bg-panel-2 border border-border rounded-sm py-1.5 text-xs text-fg hover:bg-panel-2/70 hover:text-hi flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
                >
                  <Star size={12} />
                  {addToWatchlist.isSuccess ? 'added to watchlist' : '+ watchlist'}
                </button>
                {sym && (
                  <button
                    type="button"
                    onClick={() => nav(`/order/new?symbol=${sym}&type=stock&account=${accountForMode(accountMode)}`)}
                    className="flex-1 bg-panel-2 border border-border rounded-sm py-1.5 text-xs text-cyan hover:bg-cyan/10 hover:border-cyan/50 flex items-center justify-center gap-1.5 transition-colors"
                  >
                    [trade]
                  </button>
                )}
              </div>
              {sym && hasOptions && (
                <Link
                  to={`/strategy/${sym}`}
                  className="mt-2 block bg-panel-2 border border-border rounded-sm py-1.5 text-xs text-cyan hover:bg-cyan/10 hover:border-cyan/50 text-center transition-colors"
                >
                  Build Options Strategy
                </Link>
              )}
            </ErrorBoundary>
          </Cell>
          <Cell title="WHEELABILITY">
            <ErrorBoundary label="Wheelability">
              <WheelabilityPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="NEWS">
            <ErrorBoundary label="News">
              <NewsPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="FUNDAMENTALS">
            <ErrorBoundary label="Fundamentals">
              <FundamentalsPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
        </div>
      </div>

      {/* footer */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— hover symbols anywhere to /lookup</span>
      </div>
    </div>
  );
}

function Cell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <article className="relative border border-border bg-panel/60 rounded-sm min-w-0" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">{title}</span>
        {subtitle && <><span className="text-dim">·</span><span className="text-amber">{subtitle}</span></>}
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 pt-5">{children}</div>
    </article>
  );
}
