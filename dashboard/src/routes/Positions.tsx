import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../lib/format';
import { useAccount } from '../hooks/useAccount';
import { useBotWheelState } from '../hooks/useBotState';
import { parseOptionSymbol, daysToExpiration } from '../lib/option-symbol';
import { accountsForSelection, ALL_MODES } from '../lib/account-utils';
import { useDisplayName } from '../hooks/useDisplayName';

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

type PosMode = 'manual' | 'live';
type PosAcctKey = 'MAN' | 'LIVE';

const POS_ACCENT: Record<PosAcctKey, { text: string; bg: string; tag: string }> = {
  MAN:   { text: 'text-cyan',  bg: 'bg-cyan',  tag: 'MAN ' },
  LIVE:  { text: 'text-red',   bg: 'bg-red',   tag: 'LIVE' },
};

const MODE_TO_CARD: Record<PosMode, { acctKey: PosAcctKey; label: string }> = {
  manual: { acctKey: 'MAN',  label: 'Manual' },
  live:   { acctKey: 'LIVE', label: 'Live $' },
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

  // Cash-secured put collateral encumbering options BP — count and sum
  // strike × 100 × qty for every short put. (Short calls also reduce BP via
  // underlying-share collateral but don't lock cash, so we don't sum them
  // here; covered-call exposure is visible on each row's mkt value already.)
  const shortPuts = positions.filter((p) => {
    if (p.asset_class !== 'us_option' || Number(p.qty) >= 0) return false;
    const parsed = parseOptionSymbol(p.symbol);
    return parsed?.type === 'put';
  });
  const cspCollateral = shortPuts.reduce((sum, p) => {
    const parsed = parseOptionSymbol(p.symbol);
    if (!parsed) return sum;
    return sum + parsed.strike * 100 * Math.abs(Number(p.qty));
  }, 0);

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
          <span className={totalPL >= 0 ? 'text-hi' : 'text-red'}>
            {totalPL >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(totalPL), { sign: false }).replace('-$', '$')}
          </span>
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
          {shortPuts.length > 0 && (
            <span>
              <span className="text-dim tracking-[0.15em] uppercase mr-1.5">csp collateral</span>
              <span className="text-fg">{shortPuts.length}</span>
              <span className="text-dim"> short put{shortPuts.length === 1 ? '' : 's'} encumbering </span>
              <span className="text-fg">{fmtUsd(cspCollateral)}</span>
            </span>
          )}
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
              {positions.map((p) => {
                const pl = Number(p.unrealized_pl);
                const plpc = Number(p.unrealized_plpc) * 100;
                const klass = pl >= 0 ? 'text-hi' : 'text-red';
                const isOption = p.asset_class === 'us_option';
                const parsed = isOption ? parseOptionSymbol(p.symbol) : null;
                const dte = parsed ? daysToExpiration(parsed.expiration) : null;

                const wheelEntry = parsed ? wheel[parsed.underlying] : null;
                const isThisWheelContract =
                  wheelEntry &&
                  (wheelEntry.open_contract === p.symbol || wheelEntry.contract === p.symbol);

                let closeProgress: number | null = null;
                if (isThisWheelContract && wheelEntry && Number(p.qty) < 0) {
                  const entry = Number(wheelEntry.entry_premium ?? p.avg_entry_price);
                  const current = Number(p.current_price);
                  if (entry > 0) {
                    const profitPct = ((entry - current) / entry) * 100;
                    closeProgress = (profitPct / closeThreshold) * 100;
                  }
                }

                const lookupSymbol = parsed?.underlying ?? p.symbol;
                const lookupHref = `/lookup/${lookupSymbol}`;

                return (
                  <tr key={p.symbol} className="border-b border-border/50 hover:bg-panel-2/40 transition-colors">
                    <td data-primary className="px-4 py-1.5 text-fg">
                      <Link to={lookupHref} className="hover:text-hi">
                        {isOption ? <span className="text-dim mr-1">▸</span> : <span className="text-dim mr-1">·</span>}
                        {p.symbol}
                        {isOption && parsed && (
                          <span className="text-dim ml-2 text-[10px]">
                            <span className={parsed.type === 'put' ? 'text-red' : 'text-cyan'}>
                              {parsed.type.toUpperCase()}
                            </span>{' '}
                            ${parsed.strike} {fmtIsoDateMDY(parsed.expiration)}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td data-label="qty" className="px-4 py-1.5 text-right text-fg">{fmtNum(Number(p.qty))}</td>
                    <td data-label="avg cost" className="px-4 py-1.5 text-right text-fg">
                      {fmtUsd(Number(p.avg_entry_price))}
                      {isOption && (
                        <span className="text-dim text-[10px] ml-1">
                          ({fmtUsd(Number(p.avg_entry_price) * 100)})
                        </span>
                      )}
                    </td>
                    <td data-label="current" className="px-4 py-1.5 text-right text-fg">{fmtUsd(Number(p.current_price))}</td>
                    <td data-label="mkt value" className="px-4 py-1.5 text-right text-fg">{fmtUsd(Number(p.market_value))}</td>
                    <td data-label="unrealized P/L" className={`px-4 py-1.5 text-right ${klass}`}>
                      {pl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pl), { sign: false }).replace('-$', '$')}{' '}
                      <span className="text-dim">({fmtPct(plpc, { sign: true }).replace('-', '−')})</span>
                    </td>
                    <td data-label="DTE" className={`px-4 py-1.5 text-right ${dte != null && dte <= 7 ? 'text-amber' : 'text-fg'}`}>
                      {dte == null ? <span className="text-dim">—</span> : `${dte}d`}
                    </td>
                    <td data-label="wheel close" className="px-4 py-1.5 text-right">
                      {closeProgress == null ? (
                        <span className="text-dim">—</span>
                      ) : (
                        <ProgressBar pct={closeProgress} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
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
