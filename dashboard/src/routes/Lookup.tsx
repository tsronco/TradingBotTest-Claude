import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api } from '../lib/api';
import QuotePanel from '../components/lookup/QuotePanel';
import PositionContextPanel from '../components/lookup/PositionContextPanel';
import TradingViewChart from '../components/lookup/TradingViewChart';
import OptionsChain from '../components/lookup/OptionsChain';
import EarningsPanel from '../components/lookup/EarningsPanel';
import WheelabilityPanel from '../components/lookup/WheelabilityPanel';
import NewsPanel from '../components/lookup/NewsPanel';
import FundamentalsPanel from '../components/lookup/FundamentalsPanel';
import { ErrorBoundary } from '../components/ErrorBoundary';

export default function Lookup() {
  const { symbol = '' } = useParams();
  const nav = useNavigate();
  const [search, setSearch] = useState(symbol);
  const sym = symbol.toUpperCase();

  const addToWatchlist = useMutation({
    mutationFn: () => api('/api/kv/watchlist', { method: 'POST', body: JSON.stringify({ symbol: sym }) }),
  });

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const next = search.trim().toUpperCase();
    if (next) nav(`/lookup/${next}`);
  }

  return (
    <div className="p-4 max-w-7xl mx-auto">
      <form onSubmit={onSearch} className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol (e.g. TSLA, SPY, NVDA)…"
          className="w-full bg-panel border border-border rounded-md px-4 py-3 text-text-strong text-base focus:outline-none focus:border-accent"
        />
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* LEFT 2/3 */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <Cell title={`TradingView · ${sym}`}>
            <ErrorBoundary label="Chart">
              <TradingViewChart symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="Options Chain">
            <ErrorBoundary label="Options chain">
              <OptionsChain symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="Earnings">
            <ErrorBoundary label="Earnings">
              <EarningsPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
        </div>

        {/* RIGHT 1/3 */}
        <div className="flex flex-col gap-3">
          <Cell title="Quote">
            <ErrorBoundary label="Quote/Position">
              <QuotePanel symbol={sym} />
              <hr className="border-border my-3" />
              <div className="text-muted text-[10px] uppercase tracking-wider mb-2">Your position</div>
              <PositionContextPanel symbol={sym} />
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => addToWatchlist.mutate()}
                  disabled={addToWatchlist.isPending || addToWatchlist.isSuccess}
                  className="flex-1 bg-panel-2 border border-border rounded-md py-1.5 text-xs text-text hover:bg-panel-2/70 flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <Star size={12} />
                  {addToWatchlist.isSuccess ? 'Added' : 'Watchlist'}
                </button>
              </div>
            </ErrorBoundary>
          </Cell>
          <Cell title="Wheelability score">
            <ErrorBoundary label="Wheelability">
              <WheelabilityPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="News (recent)">
            <ErrorBoundary label="News">
              <NewsPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
          <Cell title="Fundamentals">
            <ErrorBoundary label="Fundamentals">
              <FundamentalsPanel symbol={sym} />
            </ErrorBoundary>
          </Cell>
        </div>
      </div>
    </div>
  );
}

function Cell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-3">
      <div className="text-muted text-[10px] uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}
