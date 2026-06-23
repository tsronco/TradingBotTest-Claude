// dashboard/src/routes/Trades.tsx
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTrades, type TradesFilters } from '../hooks/useTrades';
import { api } from '../lib/api';
import { fmtUsd, fmtPct } from '../lib/format';
import type { Trade } from '../lib/trade-types';
import { sortTradePairs, defaultDir, type SortKey, type SortState, type TradeRowPair } from '../lib/trade-sort';
import { ALL_ACCOUNTS } from '../lib/account-utils';
import RefreshButton from '../components/trades/RefreshButton';
import { useDisplayName } from '../hooks/useDisplayName';

const ACCOUNTS = ALL_ACCOUNTS;
const ASSET_CLASSES = ['stock', 'option'] as const;
const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'] as const;
const STATUSES = ['open', 'closed'] as const;

// Trades table columns, in render order. `key` drives client-side sorting
// (see lib/trade-sort.ts); `align` matches the cell alignment in TradeRow.
const COLUMNS: { key: SortKey; label: string; align: 'left' | 'right' | 'center' }[] = [
  { key: 'date', label: 'date', align: 'left' },
  { key: 'symbol', label: 'symbol', align: 'left' },
  { key: 'side', label: 'side', align: 'left' },
  { key: 'qty', label: 'qty', align: 'right' },
  { key: 'entry', label: 'entry', align: 'right' },
  { key: 'exit', label: 'exit', align: 'right' },
  { key: 'pnl', label: 'P&L', align: 'right' },
  { key: 'grade', label: 'grade', align: 'center' },
  { key: 'ai', label: 'ai', align: 'center' },
  { key: 'tags', label: 'tags', align: 'left' },
];

export default function Trades() {
  const [filters, setFilters] = useState<TradesFilters>({ limit: 50, offset: 0, account: 'manual_paper' });
  const [sort, setSort] = useState<SortState | null>(null);
  const { data, isLoading } = useTrades(filters);
  const { handle } = useDisplayName();

  // Zip trades with their grade summaries, then sort the pairs together so the
  // AI-grade column can't desync from its row. Sorting is client-side over the
  // currently-loaded page (set SHOW to "all" to sort the whole ledger).
  const sortedPairs = useMemo<TradeRowPair[]>(() => {
    if (!data) return [];
    const pairs: TradeRowPair[] = data.trades.map((t, i) => ({ trade: t, grade: data.grades[i] }));
    return sortTradePairs(pairs, sort);
  }, [data, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev && prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: defaultDir(key) },
    );
  }
  const tagsQ = useQuery({
    queryKey: ['settings-tags'],
    queryFn: () => api<{ tags: string[] }>('/api/settings/tags'),
    staleTime: 5 * 60_000,
  });

  const summary = data?.summary;

  return (
    <div className="p-3 md:p-6 max-w-6xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/trades</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">list --account={filters.account ?? 'all'} --status={filters.status ?? 'all'} --tag={filters.tag ?? 'any'}</span>
      </div>
      <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
        <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi">Trades</h1>
        <RefreshButton account={filters.account} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <SummaryCard label="count" value={summary ? String(summary.count) : '—'} />
        <SummaryCard label="win rate" value={summary && summary.count
          ? fmtPct(summary.win_rate * 100, { sign: false })
          : '—'} />
        <SummaryCard
          label="calibration"
          value={summary
            ? `over ${summary.calibration.over} · under ${summary.calibration.under} · matched ${summary.calibration.matched}`
            : '—'}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <FilterPbtn
          label="account"
          value={filters.account}
          options={ACCOUNTS}
          onChange={(v) => setFilters({ ...filters, account: v, offset: 0 })}
        />
        <FilterPbtn label="class" value={filters.asset_class} options={ASSET_CLASSES} onChange={(v) => setFilters({ ...filters, asset_class: v, offset: 0 })} />
        <FilterPbtn label="grade" value={filters.grade} options={GRADES as unknown as readonly string[]} onChange={(v) => setFilters({ ...filters, grade: v, offset: 0 })} />
        <FilterPbtn label="status" value={filters.status} options={STATUSES} onChange={(v) => setFilters({ ...filters, status: v as 'open' | 'closed' | undefined, offset: 0 })} />
      </div>

      {tagsQ.data?.tags && tagsQ.data.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-dim text-[10px] tracking-[0.25em]">TAG:</span>
          <button
            type="button"
            className={`pbtn ${filters.tag === undefined ? 'active' : ''}`}
            onClick={() => setFilters({ ...filters, tag: undefined, offset: 0 })}
          >
            [any]
          </button>
          {tagsQ.data.tags.map((t) => (
            <button
              key={t}
              type="button"
              className={`pbtn ${filters.tag === t ? 'active' : ''}`}
              onClick={() => setFilters({ ...filters, tag: filters.tag === t ? undefined : t, offset: 0 })}
            >
              [{t}]
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 border border-border bg-panel/60 overflow-x-auto rtable">
        <table className="w-full text-[10px] tnum">
          <thead className="text-dim">
            <tr className="border-b border-border">
              {COLUMNS.map((col) => {
                const active = sort?.key === col.key;
                const alignClass = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
                return (
                  <th
                    key={col.key}
                    className={`${alignClass} px-3 py-2`}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={`inline-flex items-center gap-1 hover:text-hi ${active ? 'text-hi' : ''}`}
                      title={`sort by ${col.label}`}
                    >
                      <span>{col.label}</span>
                      <span className={`text-[8px] leading-none ${active ? '' : 'opacity-40'}`}>
                        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={10} className="text-mid text-[12px] p-3">loading…</td></tr>
            )}
            {sortedPairs.map(({ trade, grade }) => <TradeRow key={trade.id} trade={trade} gradeSummary={grade} />)}
            {!isLoading && data && data.trades.length === 0 && (
              <tr><td colSpan={10} className="text-dim text-[12px] p-3">{handle}@dash:~/portfolio/trades$ ls — total 0 — none</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(() => {
        const total = data?.total ?? 0;
        const limit = filters.limit ?? 50;
        const offset = filters.offset ?? 0;
        // limit >= total acts as "all" — one page, both nav buttons disabled.
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const currentPage = Math.floor(offset / limit) + 1;
        const onFirst = currentPage === 1;
        const onLast = currentPage >= totalPages;
        return (
          <div className="mt-3 flex justify-between items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-dim text-[10px] tracking-[0.25em]">SHOW:</span>
              {([25, 50, 100, 'all'] as const).map((opt) => {
                const optLimit = opt === 'all' ? 9999 : opt;
                const isActive = limit === optLimit;
                return (
                  <button
                    key={opt}
                    type="button"
                    className={`pbtn ${isActive ? 'active' : ''}`}
                    onClick={() => setFilters({ ...filters, limit: optLimit, offset: 0 })}
                  >
                    [{opt}]
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-dim text-[10px] tracking-[0.25em]">
                PAGE {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                className="pbtn"
                disabled={onFirst}
                onClick={() => setFilters({ ...filters, offset: Math.max(0, offset - limit) })}
              >
                {onFirst ? '[< prev]' : `[< prev(${currentPage - 1})]`}
              </button>
              <button
                type="button"
                className="pbtn"
                disabled={onLast || !data}
                title={onLast ? 'no more pages' : undefined}
                onClick={() => setFilters({ ...filters, offset: offset + limit })}
              >
                {onLast ? '[next >]' : `[next(${currentPage + 1}) >]`}
              </button>
            </div>
          </div>
        );
      })()}

      {/* footer ribbon per brand */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>
      <div className="mt-4 text-[12px]">
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/trades</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em]">
        <span className="text-dim">┌──</span> <span className="text-hi">{label.toUpperCase()}</span> <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 text-[16px] text-fg tnum">{value}</div>
    </article>
  );
}

function FilterPbtn<T extends string>({ label, value, options, onChange }: {
  label: string; value: string | undefined; options: readonly T[]; onChange: (v: T | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-dim text-[10px] tracking-[0.25em]">{label.toUpperCase()}:</span>
      <button type="button" className={`pbtn ${value === undefined ? 'active' : ''}`} onClick={() => onChange(undefined)}>[any]</button>
      {options.map((o) => (
        <button key={o} type="button" className={`pbtn ${value === o ? 'active' : ''}`} onClick={() => onChange(o)}>[{o}]</button>
      ))}
    </div>
  );
}

function TradeRow({ trade, gradeSummary }: { trade: Trade; gradeSummary: { ai_letter: string | null; calibration: string | null } }) {
  const date = trade.submitted_at?.slice(0, 10) ?? '';
  const pnl = trade.realized_pnl;
  const pnlEl = pnl != null
    ? <span className={pnl > 0 ? 'text-hi' : pnl < 0 ? 'text-red' : 'text-fg'}>{pnl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pnl))}</span>
    : <span className="text-dim">—</span>;
  const aiColor =
    gradeSummary?.calibration === 'matched' ? 'text-hi'
    : gradeSummary?.calibration === 'over_1' || gradeSummary?.calibration === 'under_1' ? 'text-amber'
    : gradeSummary?.calibration === 'over_2' || gradeSummary?.calibration === 'under_2' ? 'text-red'
    : 'text-dim';
  return (
    <tr className="border-b border-border hover:bg-panel-2">
      <td data-label="date" className="px-3 py-1.5 text-mid">
        <Link to={`/trade/${trade.id}`} className="hover:text-hi">{date}</Link>
      </td>
      <td data-primary className="px-3 py-1.5 text-cyan">
        {trade.asset_class === 'spread' && trade.spread ? (
          <Link to={`/trade/${trade.id}`}>
            {trade.symbol} {trade.spread.spread_type.replace(/_/g, ' ')}{' '}
            ${trade.spread.short_leg.strike.toFixed(2)} / ${trade.spread.long_leg.strike.toFixed(2)}
          </Link>
        ) : (
          <Link to={`/trade/${trade.id}`}>{trade.symbol}</Link>
        )}
      </td>
      <td data-label="side" className="px-3 py-1.5">{trade.side}</td>
      <td data-label="qty" className="px-3 py-1.5 text-right">{trade.qty}</td>
      <td data-label="entry" className="px-3 py-1.5 text-right">{trade.filled_avg_price != null ? fmtUsd(trade.filled_avg_price) : <span className="text-dim">—</span>}</td>
      <td data-label="exit" className="px-3 py-1.5 text-right">{trade.closed_avg_price != null ? fmtUsd(trade.closed_avg_price) : <span className="text-dim">—</span>}</td>
      <td data-label="P&amp;L" className="px-3 py-1.5 text-right">{pnlEl}</td>
      <td data-label="grade" className="px-3 py-1.5 text-center text-hi">{trade.entry_grade}</td>
      <td data-label="ai" className={`px-3 py-1.5 text-center ${aiColor}`}>{gradeSummary?.ai_letter ?? '—'}</td>
      <td data-label="tags" className="px-3 py-1.5">
        {trade.tags.slice(0, 3).map((t) => <span key={t} className="text-cyan mr-2">{t}</span>)}
      </td>
    </tr>
  );
}
