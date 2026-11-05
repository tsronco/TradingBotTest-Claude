import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../lib/format';
import { priceVsCost, priceVsCostClass } from '../lib/price-vs-cost';
import { useAccount } from '../hooks/useAccount';
import { useBotWheelState } from '../hooks/useBotState';
import { parseOptionSymbol, daysToExpiration } from '../lib/option-symbol';
import { accountsForSelection, ALL_MODES, type Mode } from '../lib/account-utils';
import { groupPositions, summarizeCollateral, type RawPosition, type SpreadMetrics } from '../lib/position-spreads';
import { computeMarketStatus, type MarketStatus } from '../lib/market-status';
import { useMarketClock } from '../hooks/useMarketClock';
import { optionUnderlyings, parseUnderlyingQuotes, type UnderlyingQuote } from '../lib/underlying-quotes';
import { useDisplayName } from '../hooks/useDisplayName';

type WheelMap = Record<string, Record<string, unknown>>;

interface Position {
  symbol: string;
  asset_class: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

const EARLY_CLOSE_THRESHOLD: Record<string, number> = {
  manual: 50,
  live: 50,
};

interface AcctResp {
  account: { buying_power: string; options_buying_power?: string; cash: string };
}

type PosMode = Mode;
type PosAcctKey = 'MAN' | 'LIVE' | 'AGENT';

const POS_ACCENT: Record<PosAcctKey, { text: string; bg: string; tag: string }> = {
  MAN:   { text: 'text-cyan',    bg: 'bg-cyan',    tag: 'MAN ' },
  LIVE:  { text: 'text-red',     bg: 'bg-red',     tag: 'LIVE' },
  AGENT: { text: 'text-magenta', bg: 'bg-magenta', tag: 'AGNT' },
};

const MODE_TO_CARD: Record<PosMode, { acctKey: PosAcctKey; label: string }> = {
  manual: { acctKey: 'MAN',   label: 'Manual' },
  live:   { acctKey: 'LIVE',  label: 'Live $' },
  agent:  { acctKey: 'AGENT', label: 'Agent'  },
};

function PositionsTable({ mode, label, acctKey }: { mode: PosMode; label: string; acctKey: PosAcctKey }) {
  const { handle } = useDisplayName();
  const positionsQ = useQuery({
    queryKey: ['positions', mode],
    queryFn: () => api<{ positions: Position[] }>(`/api/alpaca/positions?mode=${mode}`),
  });
  // Same query key as AccountCard / WheelabilityPanel — React Query dedupes.
  const acctQ = useQuery({
    queryKey: ['account', mode],
    queryFn: () => api<AcctResp>(`/api/alpaca/account?mode=${mode}`),
    staleTime: 30_000,
  });
  const wheelQ = useBotWheelState(mode);
  const { data: alpacaClock } = useMarketClock();
  const market = computeMarketStatus(new Date(), alpacaClock);
  // Underlying prices for option rows — one batched call per card, refreshed
  // every 60s. Saves a /lookup visit (and its AI summary) just to see spot.
  const underlyings = optionUnderlyings(positionsQ.data?.positions ?? []);
  const underlyingQ = useQuery({
    queryKey: ['underlying-quotes', mode, underlyings.join(',')],
    queryFn: () => api<{ snapshot: unknown }>(`/api/alpaca/quote?mode=${mode}&symbols=${underlyings.join(',')}`),
    enabled: underlyings.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (r) => parseUnderlyingQuotes(r.snapshot),
  });
  const spot = underlyingQ.data ?? {};

  const accent = POS_ACCENT[acctKey];
  const colorAccent = accent.text;

  if (positionsQ.isLoading) {
    return (
      <article data-acct-key={acctKey} className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-dim text-[12px]">
        loading {label}…
      </article>
    );
  }
  if (positionsQ.error) {
    return (
      <article data-acct-key={acctKey} className="relative border border-red bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-red text-[12px]">
        failed to load {label}
      </article>
    );
  }
  const positions = positionsQ.data?.positions ?? [];
  const wheel = (wheelQ.data?.payload as Record<string, Record<string, unknown>>) ?? {};
  const closeThreshold = EARLY_CLOSE_THRESHOLD[mode];

  // Aggregate stats for the header
  const totalPL = positions.reduce((sum, p) => sum + Number(p.unrealized_pl), 0);
  const optionCount = positions.filter((p) => p.asset_class === 'us_option').length;
  const stockCount = positions.length - optionCount;

  // Collateral split. A short put paired into a spread is secured by its long
  // leg (width × 100), NOT strike × 100 like a cash-secured put — counting it
  // as a CSP showed a $1-wide BAC spread "encumbering $4,900". Short calls
  // still aren't summed (covered by shares, don't lock cash).
  const groups = groupPositions(positions);
  const coll = summarizeCollateral(groups);
  // Options only trade 9:30–4:00 ET; outside that, marks are last-session.
  const staleTag = optionCount > 0 && !market.isOpen ? staleMarkLabel(market) : null;
  // If any spread's leg marks add up to an impossible P/L, the account total
  // built from those same marks is just as wrong — don't print it.
  const totalStale = groups.some((g) => g.kind === 'spread' && g.metrics.staleQuote);

  const acct = acctQ.data?.account;
  const optionsBp = acct ? Number(acct.options_buying_power ?? acct.buying_power) : null;
  const cash = acct ? Number(acct.cash) : null;

  return (
    <article
      data-acct-key={acctKey}
      className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-6 mb-2"
      style={{ overflow: 'visible' }}
    >
      {/* ASCII corner ornament */}
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className={colorAccent}>{label.toUpperCase()}</span>
        <span className="text-dim">──┐</span>
      </div>

      {/* card head */}
      <header className="px-5 pt-5 pb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 min-w-0">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] text-dim">
          <span className={`w-2 h-2 pulse rounded-sm ${accent.bg}`} />
          <span>ACCT::{accent.tag}</span>
          <span className="text-dim">·</span>
          <span className="text-mid">positions</span>
        </div>
        <span className="text-mid text-[11px] ml-auto tnum">
          <span className="text-dim">stocks</span> {stockCount}
          <span className="text-dim mx-1.5">·</span>
          <span className="text-dim">options</span> {optionCount}
          <span className="text-dim mx-1.5">·</span>
          <span className="text-dim">total P/L</span>{' '}
          {totalStale ? (
            <span
              className="text-amber"
              data-testid="total-pl-stale"
              title={`Leg marks add up to ${totalPL < 0 ? '−' : ''}$${Math.abs(totalPL).toFixed(2)}, but at least one spread's legs are outside what it can be worth — quote is stale`}
            >
              stale quote
            </span>
          ) : (
            <span className={totalPL >= 0 ? 'text-hi' : 'text-red'}>
              {totalPL >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(totalPL), { sign: false }).replace('-$', '$')}
            </span>
          )}
        </span>
      </header>

      {/* BP context strip — surfaces the cash/collateral picture so the user
          can decide at a glance whether to roll/close a position to free up
          options BP for new wheel entries. */}
      {optionsBp != null && cash != null && (
        <div className="px-5 pb-3 text-[11px] tnum text-mid flex flex-wrap gap-x-4 gap-y-1 border-b border-border/50">
          <span>
            <span className="text-dim tracking-[0.15em] uppercase mr-1.5">options bp</span>
            <span className={optionsBp < 1000 ? 'text-amber' : 'text-fg'}>{fmtUsd(optionsBp)}</span>
          </span>
          <span>
            <span className="text-dim tracking-[0.15em] uppercase mr-1.5">cash</span>
            <span className="text-fg">{fmtUsd(cash)}</span>
          </span>
          {coll.cspCount > 0 && (
            <span>
              <span className="text-dim tracking-[0.15em] uppercase mr-1.5">csp collateral</span>
              <span className="text-fg">{coll.cspCount}</span>
              <span className="text-dim"> short put{coll.cspCount === 1 ? '' : 's'} encumbering </span>
              <span className="text-fg">{fmtUsd(coll.cspCollateral)}</span>
            </span>
          )}
          {coll.spreadCount > 0 && (
            <span>
              <span className="text-dim tracking-[0.15em] uppercase mr-1.5">spread collateral</span>
              <span className="text-fg">{coll.spreadCount}</span>
              <span className="text-dim"> spread{coll.spreadCount === 1 ? '' : 's'} encumbering </span>
              <span className="text-fg">{fmtUsd(coll.spreadCollateral)}</span>
            </span>
          )}
        </div>
      )}

      {staleTag && (
        <div className="px-5 py-2 text-[11px] text-amber border-b border-border/50" data-testid="stale-marks-banner">
          ⚠ {staleTag} — option marks are from the last session and may be stale until the 9:30 AM ET
          open; leg P/L can look far worse (or better) than it is.
        </div>
      )}

      {positions.length === 0 ? (
        <div className="px-5 py-6 text-dim text-[12px]">
          <span className="text-mid">{handle}@dash</span><span className="text-dim">$</span> ls positions/<br />
          <span className="text-dim">total 0 — no open positions</span>
        </div>
      ) : (
        <div className="overflow-x-auto rtable">
          <table className="w-full text-[12px] tnum">
            <thead className="text-dim uppercase tracking-[0.15em] text-[10px]">
              <tr className="border-t border-b border-border">
                <th className="text-left px-4 py-2 font-normal">symbol</th>
                <th className="text-right px-4 py-2 font-normal">qty</th>
                <th className="text-right px-4 py-2 font-normal">avg cost</th>
                <th className="text-right px-4 py-2 font-normal">current</th>
                <th className="text-right px-4 py-2 font-normal">mkt value</th>
                <th className="text-right px-4 py-2 font-normal">unrealized P/L</th>
                <th className="text-right px-4 py-2 font-normal">DTE</th>
                <th className="text-right px-4 py-2 font-normal">wheel close</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) =>
                g.kind === 'single' ? (
                  <LegRow
                    key={g.pos.symbol} p={g.pos} wheel={wheel} closeThreshold={closeThreshold} staleTag={staleTag}
                    underlyingQuote={spot[parseOptionSymbol(g.pos.symbol)?.underlying ?? '']}
                  />
                ) : (
                  <Fragment key={`spread-${g.long.symbol}`}>
                    <SpreadSummaryRow metrics={g.metrics} accent={colorAccent} underlyingQuote={spot[g.metrics.underlying]} />
                    <LegRow p={g.long} wheel={wheel} closeThreshold={closeThreshold} grouped staleTag={staleTag} />
                    <LegRow p={g.short} wheel={wheel} closeThreshold={closeThreshold} grouped groupedLast staleTag={staleTag} />
                  </Fragment>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

// "BAC $49.57 ▼0.88%" — the underlying's live price on an option/spread row.
function UnderlyingPrice({ symbol, q }: { symbol: string; q?: UnderlyingQuote }) {
  if (!q) return null;
  const up = q.changePct != null && q.changePct >= 0;
  return (
    <span className="tnum whitespace-nowrap" data-testid="underlying-price" title={`${symbol} last trade`}>
      <span className="text-dim">{symbol}</span>{' '}
      <span className="text-fg">{fmtUsd(q.last)}</span>
      {q.changePct != null && (
        <span className={`ml-1 ${up ? 'text-hi' : 'text-red'}`}>
          {up ? '▲' : '▼'}{Math.abs(q.changePct).toFixed(2)}%
        </span>
      )}
    </span>
  );
}

// Short tag for why option marks aren't live: 'pre-market', 'after-hours',
// or 'market closed' (weekend / holiday).
function staleMarkLabel(m: MarketStatus): string {
  if (m.reason.startsWith('Pre-market')) return 'pre-market';
  if (m.reason.startsWith('After hours')) return 'after-hours';
  return 'market closed';
}

function fmtIsoDateMDY(iso: string): string {
  // "2026-05-22" → "05/22/2026"
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${m}/${d}/${y}` : iso;
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(150, pct));
  const colorClass = clamped >= 100 ? 'text-hi' : clamped >= 75 ? 'text-amber' : 'text-fg';
  // 10-cell ASCII progress bar; cap visual at 100% (overshoot still labels numerically)
  const cells = 10;
  const filled = Math.round((Math.min(100, clamped) / 100) * cells);
  return (
    <span className={`${colorClass} tnum`}>
      <span className="text-dim">[</span>
      {'█'.repeat(filled)}
      <span className="text-dim">{'░'.repeat(cells - filled)}</span>
      <span className="text-dim">]</span>
      <span className="ml-1.5">{Math.round(clamped)}%</span>
    </span>
  );
}

// One position row — a stock, a lone option, or a leg of a spread. `grouped`
// draws the left bracket that ties a spread's legs to their summary row above.
function LegRow({
  p, wheel, closeThreshold, grouped, groupedLast, staleTag, underlyingQuote,
}: {
  p: RawPosition;
  staleTag?: string | null;
  underlyingQuote?: UnderlyingQuote;
  wheel: WheelMap;
  closeThreshold?: number;
  grouped?: boolean;
  groupedLast?: boolean;
}) {
  const pl = Number(p.unrealized_pl);
  const plpc = Number(p.unrealized_plpc) * 100;
  const klass = pl >= 0 ? 'text-hi' : 'text-red';
  const isOption = p.asset_class === 'us_option';
  const parsed = isOption ? parseOptionSymbol(p.symbol) : null;
  const dte = parsed ? daysToExpiration(parsed.expiration) : null;

  const wheelEntry = parsed ? wheel[parsed.underlying] : null;
  const isThisWheelContract =
    wheelEntry && (wheelEntry.open_contract === p.symbol || wheelEntry.contract === p.symbol);

  let closeProgress: number | null = null;
  if (isThisWheelContract && wheelEntry && closeThreshold && Number(p.qty) < 0) {
    const entry = Number(wheelEntry.entry_premium ?? p.avg_entry_price);
    const current = Number(p.current_price);
    if (entry > 0) {
      const profitPct = ((entry - current) / entry) * 100;
      closeProgress = (profitPct / closeThreshold) * 100;
    }
  }

  const vsCost = priceVsCost(Number(p.current_price), Number(p.avg_entry_price), Number(p.qty));
  const lookupSymbol = parsed?.underlying ?? p.symbol;
  const lookupHref = `/lookup/${lookupSymbol}`;

  // Direction is otherwise encoded only in the sign of qty — make it explicit.
  // Positive qty = long (bought), negative = short (sold/written). Badge on
  // every option; on stock only when short (a long-share badge is noise).
  const qtyNum = Number(p.qty);
  const showDirBadge = isOption || qtyNum < 0;
  const isLong = qtyNum > 0;

  // Left bracket for spread legs.
  const bracket = grouped
    ? `md:border-l-2 md:border-border ${groupedLast ? 'md:border-b md:border-b-border' : ''}`
    : '';

  return (
    <tr className={`border-b border-border/50 hover:bg-panel-2/40 transition-colors ${grouped ? 'bg-panel/30' : ''}`}>
      <td data-primary className={`py-1.5 text-fg ${grouped ? 'pl-6 md:pl-8 pr-4' : 'px-4'} ${bracket}`}>
        <Link to={lookupHref} className="hover:text-hi">
          {grouped
            ? <span className="text-dim mr-1">└</span>
            : isOption ? <span className="text-dim mr-1">▸</span> : <span className="text-dim mr-1">·</span>}
          {showDirBadge && (
            <span
              className={`inline-block align-middle mr-1.5 px-1.5 py-0.5 rounded-sm text-[9px] font-bold tracking-[0.12em] leading-none ${
                isLong ? 'bg-hi/15 text-hi' : 'bg-red/15 text-red'
              }`}
              title={isLong ? 'LONG — you bought this contract' : 'SHORT — you sold/wrote this contract'}
            >
              {isLong ? 'LONG' : 'SHORT'}
            </span>
          )}
          {p.symbol}
          {isOption && parsed && (
            <span className="text-dim ml-2 text-[10px]">
              <span className={parsed.type === 'put' ? 'text-red' : 'text-cyan'}>{parsed.type.toUpperCase()}</span>{' '}
              ${parsed.strike} {fmtIsoDateMDY(parsed.expiration)}
            </span>
          )}
        </Link>
        {isOption && parsed && underlyingQuote && (
          <span className="ml-2 text-[10px]">
            <span className="text-dim mr-1">·</span>
            <UnderlyingPrice symbol={parsed.underlying} q={underlyingQuote} />
          </span>
        )}
      </td>
      <td data-label="qty" className={`px-4 py-1.5 text-right ${qtyNum < 0 ? 'text-red' : 'text-fg'}`}>
        {qtyNum > 0 ? '+' : ''}{fmtNum(qtyNum)}
      </td>
      {/* Avg cost is the reference, so it sits in the quieter mid tone; the
          current price carries the verdict — green/red by whether the move
          helps THIS position (a short option wants price below the premium
          collected), with the per-share delta underneath. Same sign as the
          P/L column, so the row reads the same from either side. */}
      <td data-label="avg cost" className="px-4 py-1.5 text-right text-mid">
        {fmtUsd(Number(p.avg_entry_price))}
        {isOption && <span className="text-dim text-[10px] ml-1">({fmtUsd(Number(p.avg_entry_price) * 100)})</span>}
      </td>
      <td data-label="current" className={`px-4 py-1.5 text-right ${priceVsCostClass(vsCost)}`}>
        {fmtUsd(Number(p.current_price))}
        {isOption && staleTag && (
          <span
            className="ml-1 text-[9px] text-amber uppercase tracking-[0.1em]"
            title="Options only trade 9:30–4:00 ET — this mark is from the last session"
          >
            {staleTag}
          </span>
        )}
        {/* Per-share dollars only. The percent was dropped on purpose: for a
            stock it IS the P/L column's percent (same ratio, different
            rounding), so showing both put two near-identical percents on one
            row. The "/sh" unit is what separates this from the total P/L. */}
        {vsCost.direction !== 'flat' && (
          <div className="text-[10px] text-dim leading-tight" title="current price minus your avg cost, per share">
            {vsCost.delta > 0 ? '+' : '−'}{fmtUsd(Math.abs(vsCost.delta), { sign: false })}/sh
          </div>
        )}
      </td>
      <td data-label="mkt value" className="px-4 py-1.5 text-right text-fg">{fmtUsd(Number(p.market_value))}</td>
      <td data-label="unrealized P/L" className={`px-4 py-1.5 text-right ${klass}`}>
        {pl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pl), { sign: false }).replace('-$', '$')}{' '}
        <span className="text-dim">({fmtPct(plpc, { sign: true }).replace('-', '−')})</span>
      </td>
      <td data-label="DTE" className={`px-4 py-1.5 text-right ${dte != null && dte <= 7 ? 'text-amber' : 'text-fg'}`}>
        {dte == null ? <span className="text-dim">—</span> : `${dte}d`}
      </td>
      <td data-label="wheel close" className="px-4 py-1.5 text-right">
        {closeProgress == null ? <span className="text-dim">—</span> : <ProgressBar pct={closeProgress} />}
      </td>
    </tr>
  );
}

// The header row above a spread's two legs: names the strategy and shows the
// defined-risk numbers (net cost, max loss, max profit, breakeven) the way an
// options builder does — computed once via the shared payoff engine.
function SpreadSummaryRow({
  metrics: m, accent, underlyingQuote,
}: { metrics: SpreadMetrics; accent: string; underlyingQuote?: UnderlyingQuote }) {
  const dte = daysToExpiration(m.expiration);
  const money = (v: number | null) =>
    v == null ? '∞' : `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
  const lo = Math.min(m.longStrike, m.shortStrike);
  const hi = Math.max(m.longStrike, m.shortStrike);

  return (
    <tr className="bg-panel-2/50">
      <td colSpan={8} className={`px-4 py-2 md:border-l-2 md:border-border`}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px]">
          <span className="inline-block px-1.5 py-0.5 rounded-sm text-[9px] font-bold tracking-[0.12em] leading-none bg-panel-2 text-mid border border-border">
            SPREAD
          </span>
          <span className={`font-bold tracking-wide ${accent}`}>{m.name}</span>
          <span className="text-dim">
            {m.underlying} {lo}/{hi} {m.optionType.toUpperCase()}
            {m.contracts > 1 && <> ×{m.contracts}</>}
            <span className="mx-1.5">·</span>
            {fmtIsoDateMDY(m.expiration)}
            <span className={dte <= 7 ? 'text-amber ml-1' : 'ml-1'}>({dte}d)</span>
          </span>
          <UnderlyingPrice symbol={m.underlying} q={underlyingQuote} />

          <span className="flex flex-wrap gap-x-4 gap-y-1 ml-auto tnum">
            <span>
              <span className="text-dim uppercase tracking-[0.12em] mr-1">{m.isDebit ? 'net debit' : 'net credit'}</span>
              <span className="text-fg">{money(Math.abs(m.netCost))}</span>
            </span>
            <span>
              <span className="text-dim uppercase tracking-[0.12em] mr-1">max loss</span>
              <span className="text-red">{money(m.maxLoss)}</span>
            </span>
            <span>
              <span className="text-dim uppercase tracking-[0.12em] mr-1">max profit</span>
              <span className="text-hi">{money(m.maxProfit)}</span>
            </span>
            <span>
              <span className="text-dim uppercase tracking-[0.12em] mr-1">breakeven</span>
              <span className="text-fg">{m.breakeven == null ? '—' : `$${m.breakeven.toFixed(2)}`}</span>
            </span>
            <span>
              <span className="text-dim uppercase tracking-[0.12em] mr-1">collateral</span>
              <span className="text-fg">{money(m.collateral)}</span>
            </span>
            <span
              title={m.markClamped
                ? `Leg marks put this spread at $${m.rawMarkValue.toFixed(2)}/sh, outside $0–$${m.width} — clamped`
                : 'Current spread value per share, from the leg marks'}
            >
              <span className="text-dim uppercase tracking-[0.12em] mr-1">value</span>
              <span className={m.markClamped ? 'text-amber' : 'text-fg'} data-testid="spread-value">
                ${m.markValue.toFixed(2)}{m.markClamped && '*'}
              </span>
            </span>
            <span>
              <span className="text-dim uppercase tracking-[0.12em] mr-1">P&amp;L</span>
              {m.staleQuote ? (
                <span
                  className="text-amber"
                  data-testid="spread-stale-quote"
                  title={`Leg marks imply ${m.groupPL < 0 ? '−' : ''}$${Math.abs(Math.round(m.groupPL))}, outside what this spread can do — quote is stale`}
                >
                  stale quote
                </span>
              ) : (
                <span className={m.groupPL >= 0 ? 'text-hi' : 'text-red'}>
                  {m.groupPL >= 0 ? '▲' : '▼'} {money(Math.abs(m.groupPL))}
                </span>
              )}
            </span>
          </span>
        </div>
      </td>
    </tr>
  );
}

export default function Positions() {
  const [mode] = useAccount();
  const selectedModes = accountsForSelection(mode);
  const cardCount = selectedModes.length;
  const { handle } = useDisplayName();

  return (
    <div className="p-3 md:p-6 max-w-[1480px]">
      {/* prompt header */}
      <div className="flex items-baseline gap-2 mb-4 text-[12px] flex-wrap">
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
        <span className="text-fg">positions</span>
        <span className="text-amber">--list</span>
        <span className="text-dim">--mode=<span className="text-fg">{selectedModes.length === ALL_MODES.length ? 'all' : mode}</span></span>
        <span className="caret" />
      </div>

      {/* title row */}
      <div className="flex flex-wrap items-end justify-between gap-y-3 gap-x-6 mb-5">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-hi text-[28px] md:text-[44px] font-bold leading-none tracking-tight">Positions</h1>
            <span className="text-dim text-[12px]">// open contracts &amp; shares</span>
          </div>
          <div className="mt-2 text-mid text-[12px]">
            <span className="text-dim">[</span>
            <span className="text-fg">live</span>
            <span className="text-dim">]</span>
            <span className="text-dim mx-2">·</span>
            <span className="inline-block px-1.5 py-0.5 rounded-sm text-[9px] font-bold tracking-[0.12em] leading-none bg-hi/15 text-hi">LONG</span>
            <span className="text-dim"> = you bought it · </span>
            <span className="inline-block px-1.5 py-0.5 rounded-sm text-[9px] font-bold tracking-[0.12em] leading-none bg-red/15 text-red">SHORT</span>
            <span className="text-dim"> = you sold/wrote it</span>
            <span className="text-dim mx-2">·</span>
            <span className="text-dim">DTE in </span>
            <span className="text-amber">amber</span>
            <span className="text-dim"> if ≤ 7d · click any symbol to look it up</span>
          </div>
        </div>
      </div>

      {/* divider */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-5 select-none">
        <span className="whitespace-nowrap">━━━ accounts</span>
        <span className="text-mid">[{cardCount}]</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ portfolio --positions</span>
      </div>

      {/* tables */}
      <div className="grid gap-2">
        {selectedModes.map((m) => {
          const { acctKey, label } = MODE_TO_CARD[m as PosMode];
          return <PositionsTable key={m} mode={m as PosMode} label={label} acctKey={acctKey} />;
        })}
      </div>

      {/* footer */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— click symbol to /lookup</span>
      </div>
    </div>
  );
}
