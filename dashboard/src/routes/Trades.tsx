// dashboard/src/routes/Trades.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTrades, type TradesFilters } from '../hooks/useTrades';
import { fmtUsd, fmtPct } from '../lib/format';
import type { Trade } from '../lib/trade-types';

const ACCOUNTS = ['conservative_paper', 'aggressive_paper', 'manual_paper'] as const;
const ASSET_CLASSES = ['stock', 'option'] as const;
const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'] as const;
const STATUSES = ['open', 'closed'] as const;

export default function Trades() {
  const [filters, setFilters] = useState<TradesFilters>({ limit: 50, offset: 0 });
  const { data, isLoading } = useTrades(filters);

  const summary = data?.summary;

  return (
    <div className="p-3 md:p-6 max-w-6xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/trades</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">list --account={filters.account ?? 'all'} --status={filters.status ?? 'all'}</span>
      </div>
      <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi mt-2">Trades</h1>

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

      <div className="mt-4 flex flex-wrap gap-2 flex-wrap">
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

      <div className="mt-4 border border-border bg-panel/60 overflow-x-auto rtable">
        <table className="w-full text-[10px] tnum">
          <thead className="text-dim">
            <tr className="border-b border-border">
              <th className="text-left px-3 py-2">date</th>
              <th className="text-left px-3 py-2">symbol</th>
              <th className="text-left px-3 py-2">side</th>
              <th className="text-right px-3 py-2">qty</th>
              <th className="text-right px-3 py-2">entry</th>
              <th className="text-right px-3 py-2">exit</th>
              <th className="text-right px-3 py-2">P&amp;L</th>
              <th className="text-center px-3 py-2">grade</th>
              <th className="text-center px-3 py-2">ai</th>
              <th className="text-left px-3 py-2">tags</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={10} className="text-mid text-[12px] p-3">loading…</td></tr>
            )}
            {data?.trades.map((t, i) => <TradeRow key={t.id} trade={t} gradeSummary={data.grades[i]} />)}
            {!isLoading && data && data.trades.length === 0 && (
              <tr><td colSpan={10} className="text-dim text-[12px] p-3">tim@dash:~/portfolio/trades$ ls — total 0 — none</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="pbtn" disabled={(filters.offset ?? 0) === 0}
                onClick={() => setFilters({ ...filters, offset: Math.max(0, (filters.offset ?? 0) - (filters.limit ?? 50)) })}>
          [&lt; prev]
        </button>
        <button type="button" className="pbtn" disabled={!data || ((filters.offset ?? 0) + (filters.limit ?? 50)) >= (data?.total ?? 0)}
                onClick={() => setFilters({ ...filters, offset: (filters.offset ?? 0) + (filters.limit ?? 50) })}>
          [next &gt;]
        </button>
      </div>

      {/* footer ribbon per brand */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>
      <div className="mt-4 text-[12px]">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
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
    <div className="flex items-center gap-1">
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
