import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAccount } from '../../hooks/useAccount';
import type { AccountMode } from '../../hooks/useAccount';
import { selectModeFromAccountMode, modeToAccount, type AnyAccountId } from '../../lib/account-utils';
import { GreekHeader } from '../GreekLabel';
import { daysToExpiration } from '../../lib/option-symbol';

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

function fmtUSDateWithDTE(iso: string): string {
  const dte = daysToExpiration(iso);
  const dteLabel = dte < 0 ? 'expired' : `${dte} DTE`;
  return `${fmtUSDate(iso)} (${dteLabel})`;
}

type SideFilter = 'puts' | 'calls' | 'both';

export interface ChainStrikeClick {
  contract: OptionContract;
  /** Which price the user clicked: bid → sell-side, ask → buy-side, row → row click w/o specific side */
  side: 'bid' | 'ask' | 'row';
  /** The price under the user's finger when they clicked. NaN when missing. */
  price: number;
}

/** Visual selection marker — boxes the matching bid (red) or ask (cyan) cell
 *  and tints the row. Multiple highlights allowed (spread builder uses two). */
export interface ChainHighlight {
  strike: number;
  side: 'bid' | 'ask';
  /** 'short' = red ring, 'long' = cyan ring. Defaults to matching `side`. */
  role?: 'short' | 'long';
}

interface Props {
  symbol: string;
  /**
   * If provided, the row + bid/ask buttons call this instead of navigating to /order/new.
   * Used by the SpreadOrderForm to populate legs directly without leaving the page.
   */
  onPriceClick?: (info: ChainStrikeClick) => void;
  /** Force a side filter (e.g. spread builder shows puts-only). When set, the side toggle is hidden. */
  sideLock?: SideFilter;
  /** Force a specific expiration (e.g. spread builder syncs to its own dropdown). When set, hides the chain's expiration dropdown. */
  expirationLock?: string;
  /** Optional small label rendered next to the expiration row (e.g. "pick SHORT leg"). */
  contextLabel?: ReactNode;
  /** Selected legs to outline in the chain (e.g. spread builder's short+long picks). */
  highlights?: ChainHighlight[];
}

export default function OptionsChain({ symbol, onPriceClick, sideLock, expirationLock, contextLabel, highlights }: Props) {
  // Greeks default OFF (both desktop and mobile) — keeps the mobile chain narrow.
  const [showAllGreeks, setShowAllGreeks] = useState(false);
  const [selectedExpState, setSelectedExp] = useState<string | null>(null);
  const selectedExp = expirationLock ?? selectedExpState;
  const [showAllStrikes, setShowAllStrikes] = useState(false);
  const [sideState, setSide] = useState<SideFilter>(sideLock ?? 'puts');
  const side: SideFilter = sideLock ?? sideState;
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
  // dedupes, so this is free. refetchInterval keeps the spot divider live as
  // the underlying ticks; React Query auto-pauses when the component unmounts.
  //
  // NOTE — shared-query interval dominance: the ['quote', symbol] key is shared
  // with QuotePanel and WheelabilityPanel. React Query uses the shortest active
  // interval across all observers, so while OptionsChain is mounted on
  // /lookup/:symbol this 5 s interval dominates the shared query and those
  // panels also refetch/re-render at 5 s (overriding QuotePanel's own 15 s).
  // This is intentional — timelier spot-price for the divider is worth the
  // extra polling while the chain is visible.
  const quoteQ = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
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
  // Skip when expirationLock is set (parent controls it).
  useEffect(() => {
    if (expirationLock) return;
    if (expirations.length > 0 && (!selectedExpState || !expirations.includes(selectedExpState))) {
      setSelectedExp(expirations[0]);
    }
  }, [expirations, selectedExpState, expirationLock]);

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
          {expirationLock ? null : (
            <>
              <span className="text-dim tracking-[0.15em]">EXP</span>
              <select
                value={exp}
                onChange={(e) => setSelectedExp(e.target.value)}
                className="bg-panel-2 text-fg border border-border rounded-sm px-2 py-0.5 text-[11px] focus:outline-none focus:border-hi"
              >
                {expirations.map((e) => (
                  <option key={e} value={e}>{fmtUSDateWithDTE(e)}</option>
                ))}
              </select>
            </>
          )}
          {isSnapshotsLoading && (
            <span className="text-dim text-[10px] tracking-[0.15em] animate-pulse ml-1">
              loading quotes…
            </span>
          )}

          {sideLock ? null : (
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
          )}
          {contextLabel && (
            <div className="text-cyan text-[10px] tracking-[0.15em] uppercase ml-1">{contextLabel}</div>
          )}

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
      <div className="max-h-[60vh] max-w-full overflow-x-auto overflow-y-auto chain-scroll">
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
          {(() => {
            // Base columns: strike, type, bid, ask, iv, delta, theta, oi = 8
            // With showAllGreeks adds gamma + vega = 10
            const colSpan = showAllGreeks ? 10 : 8;

            // Build the unique sorted strike values to determine divider position.
            const uniqueStrikes = Array.from(new Set(rows.map((c) => Number(c.strike_price)))).sort(
              (a, b) => a - b
            );

            // Find the index in rows after which the divider should be inserted.
            // Divider sits after the last row whose strike ≤ spot, before the
            // first row whose strike > spot. If spot is below all strikes,
            // insertAfterStrike is -Infinity (divider goes to top). If spot is
            // above all strikes, insertAfterStrike is the last strike (bottom).
            let insertAfterStrike: number = -Infinity;
            if (stockPrice != null) {
              for (const s of uniqueStrikes) {
                if (s <= stockPrice) insertAfterStrike = s;
              }
            }

            const elements: ReactNode[] = [];
            let dividerInserted = false;

            // If spot is below all visible strikes, insert divider first.
            if (stockPrice != null && insertAfterStrike === -Infinity && !dividerInserted) {
              elements.push(
                <tr key="chain-spot-divider" className="chain-spot">
                  <td colSpan={colSpan}>Share price: {fmtUsd(stockPrice)}</td>
                </tr>
              );
              dividerInserted = true;
            }

            // Build the click handler once per row. When onPriceClick is provided
            // (embedded mode — e.g. SpreadOrderForm), bid/ask cells call it with
            // the side hint. Otherwise the row navigates to /order/new with the
            // clicked side + price prefilled (Robinhood-style behaviour).
            //
            // Bid → STO (you SELL at the bid). Ask → BTO (you BUY at the ask).
            // Row click (anywhere not on a price button) defaults to STO @ mid,
            // matching the wheel-first default in the order form.
            function dispatchPriceClick(c: OptionContract, side: 'bid' | 'ask' | 'row', price: number) {
              if (onPriceClick) {
                onPriceClick({ contract: c, side, price });
                return;
              }
              const params = new URLSearchParams({
                contract: c.symbol,
                action: 'open',
                account: accountForMode(accountMode),
              });
              if (Number.isFinite(price) && price > 0) {
                params.set('price', price.toFixed(2));
              }
              if (side === 'bid') params.set('side', 'STO');
              else if (side === 'ask') params.set('side', 'BTO');
              navigate(`/order/new?${params.toString()}`);
            }

            for (const c of rows) {
              const cs = snapshots[c.symbol] ?? {};
              const g = cs.greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
              const klass = c.type === 'call' ? 'text-cyan' : 'text-red';
              const bid = cs.latestQuote?.bp;
              const ask = cs.latestQuote?.ap;
              const strikeNum = Number(c.strike_price);
              const bidHL = highlights?.find((h) => h.side === 'bid' && h.strike === strikeNum);
              const askHL = highlights?.find((h) => h.side === 'ask' && h.strike === strikeNum);
              const rowHL = bidHL ?? askHL;
              const rowTint =
                rowHL?.role === 'long' || (rowHL && rowHL.side === 'ask' && rowHL.role !== 'short')
                  ? 'bg-cyan/5'
                  : rowHL
                  ? 'bg-red/5'
                  : '';
              const bidRing = bidHL
                ? (bidHL.role === 'long' ? 'ring-1 ring-inset ring-cyan bg-cyan/15' : 'ring-1 ring-inset ring-red bg-red/15')
                : '';
              const askRing = askHL
                ? (askHL.role === 'short' ? 'ring-1 ring-inset ring-red bg-red/15' : 'ring-1 ring-inset ring-cyan bg-cyan/15')
                : '';
              elements.push(
                <tr
                  key={c.symbol}
                  className={`border-b border-border/50 hover:bg-panel-2/40 transition-colors cursor-pointer ${rowTint}`}
                  onClick={() => dispatchPriceClick(c, 'row', (bid ?? 0) > 0 && (ask ?? 0) > 0 ? ((bid! + ask!) / 2) : (bid ?? ask ?? 0))}
                >
                  <td className="px-2 py-1 text-fg">{fmtUsd(Number(c.strike_price))}</td>
                  <td className={`px-2 py-1 ${klass} font-semibold`}>{c.type === 'call' ? 'C' : 'P'}</td>
                  <td className="px-2 py-1 text-right p-0">
                    {bid != null ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); dispatchPriceClick(c, 'bid', bid); }}
                        title={`Sell at bid ${bid.toFixed(2)}`}
                        aria-label={`bid ${bid.toFixed(2)} — sell to open`}
                        className={`w-full px-2 py-0.5 text-right text-red hover:bg-red/15 active:bg-red/25 transition-colors rounded-sm tnum ${bidRing}`}
                      >
                        {bid.toFixed(2)}
                      </button>
                    ) : <span className="text-dim px-2">—</span>}
                  </td>
                  <td className="px-2 py-1 text-right p-0">
                    {ask != null ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); dispatchPriceClick(c, 'ask', ask); }}
                        title={`Buy at ask ${ask.toFixed(2)}`}
                        aria-label={`ask ${ask.toFixed(2)} — buy to open`}
                        className={`w-full px-2 py-0.5 text-right text-cyan hover:bg-cyan/15 active:bg-cyan/25 transition-colors rounded-sm tnum ${askRing}`}
                      >
                        {ask.toFixed(2)}
                      </button>
                    ) : <span className="text-dim px-2">—</span>}
                  </td>
                  <td className="px-2 py-1 text-right text-mid">{cs.impliedVolatility ? fmtPct(cs.impliedVolatility * 100) : <span className="text-dim">—</span>}</td>
                  <td className={`px-2 py-1 text-right ${deltaColorClass(g.delta)}`}>{g.delta?.toFixed(3) ?? <span className="text-dim">—</span>}</td>
                  {showAllGreeks && <td className="px-2 py-1 text-right text-mid">{g.gamma?.toFixed(4) ?? <span className="text-dim">—</span>}</td>}
                  <td className="px-2 py-1 text-right text-mid">{g.theta?.toFixed(3) ?? <span className="text-dim">—</span>}</td>
                  {showAllGreeks && <td className="px-2 py-1 text-right text-mid">{g.vega?.toFixed(3) ?? <span className="text-dim">—</span>}</td>}
                  <td className="px-2 py-1 text-right text-mid">{cs.openInterest ?? <span className="text-dim">—</span>}</td>
                </tr>
              );

              // After inserting the row for insertAfterStrike, emit the divider.
              if (
                stockPrice != null &&
                !dividerInserted &&
                Number(c.strike_price) === insertAfterStrike
              ) {
                elements.push(
                  <tr key="chain-spot-divider" className="chain-spot">
                    <td colSpan={colSpan}>Share price: {fmtUsd(stockPrice)}</td>
                  </tr>
                );
                dividerInserted = true;
              }
            }

            return elements;
          })()}
        </tbody>
      </table>
      </div>
    </div>
  );
}
