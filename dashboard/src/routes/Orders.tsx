import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtUsd, fmtNum } from '../lib/format';
import { useAccount } from '../hooks/useAccount';
import { parseOptionSymbol, daysToExpiration } from '../lib/option-symbol';

interface Order {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: string | null;
}

function fmtIsoDateMDY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${m}/${d}/${y}` : iso;
}

function fmtSubmitted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'filled') return 'text-hi';
  if (s === 'canceled' || s === 'cancelled' || s === 'expired' || s === 'rejected') return 'text-red';
  if (s === 'pending_new' || s === 'new' || s === 'accepted' || s === 'pending_cancel' || s === 'partially_filled') return 'text-amber';
  return 'text-fg';
}

function sideColor(side: string): string {
  const s = side.toLowerCase();
  if (s === 'buy') return 'text-hi';
  if (s === 'sell' || s === 'sell_short') return 'text-red';
  return 'text-fg';
}

function OrdersTable({ mode, status, label, acctKey, statusLabel }: {
  mode: 'conservative' | 'aggressive';
  status: 'open' | 'closed';
  label: string;
  acctKey: 'CONS' | 'AGG';
  statusLabel: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', mode, status],
    queryFn: () => api<{ orders: Order[] }>(`/api/alpaca/orders?mode=${mode}&status=${status}`),
  });

  const isCons = acctKey === 'CONS';
  const colorAccent = isCons ? 'text-hi' : 'text-amber';

  if (isLoading) {
    return (
      <article data-acct-key={acctKey} className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-dim text-[12px]">
        loading {label}…
      </article>
    );
  }
  if (error) {
    return (
      <article data-acct-key={acctKey} className="relative border border-red bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-red text-[12px]">
        failed to load {label}
      </article>
    );
  }
  const orders = data?.orders ?? [];

  return (
    <article
      data-acct-key={acctKey}
      className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-6 mb-2"
      style={{ overflow: 'visible' }}
    >
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className={colorAccent}>{label.toUpperCase()}</span>
        <span className="text-dim">·</span>
        <span className="text-mid">{statusLabel.toUpperCase()}</span>
        <span className="text-dim">──┐</span>
      </div>

      <header className="px-5 pt-5 pb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 min-w-0">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] text-dim">
          <span className={`w-2 h-2 pulse rounded-sm ${isCons ? 'bg-hi' : 'bg-amber'}`} />
          <span>ACCT::{isCons ? 'CONS' : 'AGG '}</span>
          <span className="text-dim">·</span>
          <span className="text-mid">orders</span>
          <span className="text-dim">·</span>
          <span className="text-mid">{statusLabel}</span>
        </div>
        <span className="text-mid text-[11px] ml-auto tnum">
          <span className="text-dim">count</span> {orders.length}
        </span>
      </header>

      {orders.length === 0 ? (
        <div className="px-5 pb-6 text-dim text-[12px]">
          <span className="text-mid">tim@dash</span><span className="text-dim">$</span> ls orders/{statusLabel}/<br />
          <span className="text-dim">total 0 — none</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] tnum">
            <thead className="text-dim uppercase tracking-[0.15em] text-[10px]">
              <tr className="border-t border-b border-border">
                <th className="text-left px-4 py-2 font-normal">submitted</th>
                <th className="text-left px-4 py-2 font-normal">symbol</th>
                <th className="text-left px-4 py-2 font-normal">side</th>
                <th className="text-left px-4 py-2 font-normal">type</th>
                <th className="text-right px-4 py-2 font-normal">qty</th>
                <th className="text-right px-4 py-2 font-normal">filled</th>
                <th className="text-right px-4 py-2 font-normal">price</th>
                <th className="text-left px-4 py-2 font-normal">status</th>
                <th className="text-right px-4 py-2 font-normal">DTE</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const parsed = parseOptionSymbol(o.symbol);
                const dte = parsed ? daysToExpiration(parsed.expiration) : null;
                const lookupSymbol = parsed?.underlying ?? o.symbol;
                const isOption = !!parsed;
                return (
                  <tr key={o.id} className="border-b border-border/50 hover:bg-panel-2/40 transition-colors">
                    <td className="px-4 py-1.5 text-mid text-[11px]">{fmtSubmitted(o.submitted_at)}</td>
                    <td className="px-4 py-1.5 text-fg">
                      <Link to={`/lookup/${lookupSymbol}`} className="hover:text-hi">
                        {isOption ? <span className="text-dim mr-1">▸</span> : <span className="text-dim mr-1">·</span>}
                        {o.symbol}
                        {parsed && (
                          <span className="text-dim ml-2 text-[10px]">
                            <span className={parsed.type === 'put' ? 'text-red' : 'text-cyan'}>
                              {parsed.type.toUpperCase()}
                            </span>{' '}
                            ${parsed.strike} {fmtIsoDateMDY(parsed.expiration)}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className={`px-4 py-1.5 ${sideColor(o.side)}`}>{o.side}</td>
                    <td className="px-4 py-1.5 text-mid">{o.type}</td>
                    <td className="px-4 py-1.5 text-right text-fg">{fmtNum(Number(o.qty))}</td>
                    <td className="px-4 py-1.5 text-right text-fg">{fmtNum(Number(o.filled_qty))}</td>
                    <td className="px-4 py-1.5 text-right text-fg">
                      {o.filled_avg_price
                        ? fmtUsd(Number(o.filled_avg_price))
                        : o.limit_price
                        ? <><span className="text-dim">lim </span>{fmtUsd(Number(o.limit_price))}</>
                        : o.stop_price
                        ? <><span className="text-dim">stp </span>{fmtUsd(Number(o.stop_price))}</>
                        : <span className="text-dim">—</span>}
                    </td>
                    <td className={`px-4 py-1.5 ${statusColor(o.status)}`}>{o.status}</td>
                    <td className={`px-4 py-1.5 text-right ${dte != null && dte <= 7 ? 'text-amber' : 'text-fg'}`}>
                      {dte == null ? <span className="text-dim">—</span> : `${dte}d`}
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

export default function Orders() {
  const [mode] = useAccount();
  const showCons = mode === 'both' || mode === 'conservative';
  const showAgg = mode === 'both' || mode === 'aggressive';
  const cardCount = mode === 'both' ? 2 : 1;

  return (
    <div className="p-6 max-w-[1480px]">
      {/* prompt header */}
      <div className="flex items-baseline gap-2 mb-4 text-[12px] flex-wrap">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
        <span className="text-fg">orders</span>
        <span className="text-amber">--list</span>
        <span className="text-dim">--mode=<span className="text-fg">{mode}</span></span>
        <span className="caret" />
      </div>

      {/* title row */}
      <div className="flex flex-wrap items-end justify-between gap-y-3 gap-x-6 mb-5">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-hi text-[44px] font-bold leading-none tracking-tight">Orders</h1>
            <span className="text-dim text-[12px]">// open queue &amp; today&apos;s fills</span>
          </div>
          <div className="mt-2 text-mid text-[12px]">
            <span className="text-dim">[</span>
            <span className="text-fg">live</span>
            <span className="text-dim">]</span>
            <span className="text-dim mx-2">·</span>
            <span className="text-hi">filled</span>
            <span className="text-dim mx-1">/</span>
            <span className="text-amber">open</span>
            <span className="text-dim mx-1">/</span>
            <span className="text-red">canceled</span>
            <span className="text-dim"> color-coded</span>
          </div>
        </div>
      </div>

      {/* OPEN section */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-3 select-none">
        <span className="whitespace-nowrap">━━━ open</span>
        <span className="text-mid">[{cardCount}]</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ orders --status=open</span>
      </div>
      <div className="grid gap-2 mb-6">
        {showCons && <OrdersTable mode="conservative" status="open" label="Conservative" acctKey="CONS" statusLabel="open" />}
        {showAgg && <OrdersTable mode="aggressive" status="open" label="Aggressive" acctKey="AGG" statusLabel="open" />}
      </div>

      {/* FILLED section */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-3 select-none">
        <span className="whitespace-nowrap">━━━ filled (recent)</span>
        <span className="text-mid">[{cardCount}]</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ orders --status=closed</span>
      </div>
      <div className="grid gap-2">
        {showCons && <OrdersTable mode="conservative" status="closed" label="Conservative" acctKey="CONS" statusLabel="filled" />}
        {showAgg && <OrdersTable mode="aggressive" status="closed" label="Aggressive" acctKey="AGG" statusLabel="filled" />}
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
