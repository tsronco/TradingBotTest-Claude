// dashboard/src/routes/StrategyBuilder.tsx
//
// Robinhood-style Options Strategy Builder. Renders a grid of cards
// grouped by section; clicking a wired card navigates to the
// appropriate order entry surface (vertical-spread form for verticals,
// the chain-picker subroute for single legs).
//
// "Coming soon" cards (straddles/strangles/calendars) render but are
// not clickable yet.
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  STRATEGY_CATALOG,
  STRATEGY_SECTIONS,
  SECTION_BLURBS,
  navigateForIntent,
  type StrategySection,
} from '../lib/strategy-catalog';
import StrategyCard from '../components/strategy/StrategyCard';
import { useDisplayName } from '../hooks/useDisplayName';

export default function StrategyBuilder() {
  const { symbol = '' } = useParams();
  const sym = symbol.toUpperCase();
  const nav = useNavigate();
  const { handle } = useDisplayName();

  // Use the same quote query as the rest of the dashboard so it's cached.
  const { data: quoteData } = useQuery({
    queryKey: ['quote', sym],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${sym}`),
    enabled: !!sym,
    staleTime: 10_000,
  });
  const snap = quoteData?.snapshot?.[sym];
  const spotPrice: number = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? 0;

  const grouped: Record<StrategySection, typeof STRATEGY_CATALOG> = {
    'Single Leg': [],
    'Vertical Spreads': [],
    'Straddles and Strangles': [],
    'Calendar Spreads': [],
  };
  for (const s of STRATEGY_CATALOG) grouped[s.section].push(s);

  return (
    <div className="p-3 md:p-6 max-w-[1200px]">
      {/* breadcrumb */}
      <div className="text-mid text-[12px] mb-2">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/strategy</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">build --symbol=<span className="text-amber">{sym || '?'}</span></span>
      </div>

      {/* header */}
      <div className="flex items-baseline justify-between flex-wrap gap-y-2 mb-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-hi text-[24px] md:text-[32px] font-bold leading-none tracking-tight">
            Options Strategy Builder
          </h1>
          {sym && <span className="text-amber text-[18px] md:text-[22px] font-bold leading-none tnum">· {sym}</span>}
        </div>
        {sym && (
          <Link
            to={`/lookup/${sym}`}
            className="text-mid hover:text-hi text-[12px] underline-offset-2 hover:underline"
          >
            ← back to lookup
          </Link>
        )}
      </div>

      {/* spot price line */}
      <div className="text-mid text-[12px] mb-6">
        {sym ? (
          spotPrice > 0 ? (
            <>
              <span className="text-dim">{sym} is at </span>
              <span className="text-hi tnum">${spotPrice.toFixed(2)}</span>
            </>
          ) : (
            <span className="text-dim">loading quote…</span>
          )
        ) : (
          <span className="text-dim">pick a symbol from /lookup/SYM</span>
        )}
      </div>

      {/* sections */}
      <div className="space-y-8">
        {STRATEGY_SECTIONS.map((section) => {
          const items = grouped[section];
          if (items.length === 0) return null;
          return (
            <section key={section}>
              <h2 className="text-hi text-[18px] md:text-[20px] font-bold mb-1">{section}</h2>
              <p className="text-dim text-[11px] mb-3 max-w-2xl">{SECTION_BLURBS[section]}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((s) => (
                  <StrategyCard
                    key={s.id}
                    strategy={s}
                    spot={spotPrice}
                    onClick={() => {
                      const url = navigateForIntent(s.intent, sym);
                      if (url) nav(url);
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* footer */}
      <div className="footer-ribbon mt-8 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ strategy</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— greyed cards: coming soon</span>
      </div>
    </div>
  );
}
