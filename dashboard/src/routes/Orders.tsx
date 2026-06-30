import { useMemo, useState } from 'react';
import { useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtUsd, fmtNum } from '../lib/format';
import { useAccount } from '../hooks/useAccount';
import { parseOptionSymbol, daysToExpiration } from '../lib/option-symbol';
import { describeSpreadOrder } from '../lib/spread-order';
import { OrderEditModal } from '../components/order/OrderEditModal';
import { OrdersFilterBar } from '../components/order/OrdersFilterBar';
import {
  type DateRangeKey,
  dateRangeToAfter,
  underlyingFromSymbol,
  collectUnderlyings,
} from '../lib/order-filters';
import { accountsForSelection, ALL_MODES } from '../lib/account-utils';
import { useDisplayName } from '../hooks/useDisplayName';

interface Order {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  // status may be overridden server-side from "filled" → "expired" / "assigned"
  // when an option activity (OPEXP/OPASN) closed the leg.
  status: string;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: string | null;
  // Realized P/L in dollars, signed. Set on closing legs (BTC orders, or
  // openers stamped via assignment/expiration). null when not a closer or
  // the opener is older than the 90-day pairing window.
  realized_pl?: number | null;
  // Multi-leg (spread) orders: Alpaca returns the parent with symbol/side
  // null and the real data here. Used to render a combined spread row.
  order_class?: string | null;
  legs?: Array<{ symbol: string | null; side: string | null }> | null;
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
  // expired/assigned are "filled with extra context" — kept the premium.
  if (s === 'expired' || s === 'assigned') return 'text-cyan';
  if (s === 'canceled' || s === 'cancelled' || s === 'rejected') return 'text-red';
  if (s === 'pending_new' || s === 'new' || s === 'accepted' || s === 'pending_cancel' || s === 'partially_filled') return 'text-amber';
  return 'text-fg';
}

function fmtPL(pl: number): string {
  const sign = pl >= 0 ? '+' : '−';
  const abs = Math.abs(pl);
  // Show cents on small values, whole dollars on larger ones.
  const formatted = abs < 100
    ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `${sign}$${formatted}`;
}

function sideColor(side: string): string {
  const s = side.toLowerCase();
  if (s === 'buy') return 'text-hi';
  if (s === 'sell' || s === 'sell_short') return 'text-red';
  return 'text-fg';
}

type OrderMode = 'manual' | 'live';
type OrderAcctKey = 'MAN' | 'LIVE';

const ORDER_ACCENT: Record<OrderAcctKey, { text: string; bg: string; tag: string }> = {
  MAN:   { text: 'text-cyan',  bg: 'bg-cyan',  tag: 'MAN ' },
  LIVE:  { text: 'text-red',   bg: 'bg-red',   tag: 'LIVE' },
};

const ORDER_MODE_TO_CARD: Record<OrderMode, { acctKey: OrderAcctKey; label: string }> = {
  manual: { acctKey: 'MAN',  label: 'Manual' },
  live:   { acctKey: 'LIVE', label: 'Live $' },
};

interface OrdersTableProps {
  mode: OrderMode;
  status: 'open' | 'closed';
  label: string;
  acctKey: OrderAcctKey;
  statusLabel: string;
  orders: Order[];
  isLoading: boolean;
  isError: boolean;
  symbolFilter: string;
}

function OrdersTable({
  mode,
  status,
  label,
  acctKey,
  statusLabel,
  orders,
  isLoading,
  isError,
  symbolFilter,
}: OrdersTableProps) {
  const qc = useQueryClient();
  const { handle } = useDisplayName();
  const [editing, setEditing] = useState<Order | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/api/alpaca/cancel-order?mode=${mode}`, {
        method: 'POST',
        body: JSON.stringify({ order_id: id }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['orders'] }),
  });

  const accent = ORDER_ACCENT[acctKey];
  const colorAccent = accent.text;

  if (isLoading) {
    return (
      <article data-acct-key={acctKey} className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-dim text-[12px]">
        loading {label}…
      </article>
    );
  }
  if (isError) {
    return (
      <article data-acct-key={acctKey} className="relative border border-red bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-red text-[12px]">
        failed to load {label}
      </article>
    );
  }

  // Symbol filter is applied client-side. Date filter is applied server-side
  // (via the `after` query param) so we don't blow past Alpaca's 500-order page cap.
  const filtered = symbolFilter
    ? orders.filter(
        (o) =>
          (describeSpreadOrder(o)?.underlying ??
            underlyingFromSymbol(o.symbol ?? '')) === symbolFilter,
      )
    : orders;
  const hiddenBySymbol = orders.length - filtered.length;

  // Sub-total of realized P/L across visible (filtered) closing legs.
  const subtotalPL = status === 'closed'
    ? filtered.reduce((sum, o) => sum + (o.realized_pl ?? 0), 0)
    : 0;
  const showSubtotal = status === 'closed' && filtered.some((o) => typeof o.realized_pl === 'number');

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
          <span className={`w-2 h-2 pulse rounded-sm ${accent.bg}`} />
          <span>ACCT::{accent.tag}</span>
          <span className="text-dim">·</span>
          <span className="text-mid">orders</span>
          <span className="text-dim">·</span>
          <span className="text-mid">{statusLabel}</span>
        </div>
        <span className="text-mid text-[11px] ml-auto tnum flex items-baseline gap-3">
          <span>
            <span className="text-dim">count</span> {filtered.length}
            {hiddenBySymbol > 0 && (
              <span className="text-dim"> · {hiddenBySymbol} hidden by filter</span>
            )}
          </span>
          {showSubtotal && (
            <span>
              <span className="text-dim">realized</span>{' '}
              <span className={subtotalPL >= 0 ? 'text-hi' : 'text-red'}>{fmtPL(subtotalPL)}</span>
            </span>
          )}
        </span>
      </header>

      {filtered.length === 0 ? (
        <div className="px-5 pb-6 text-dim text-[12px]">
          <span className="text-mid">{handle}@dash</span><span className="text-dim">$</span> ls orders/{statusLabel}/
          {symbolFilter && <span className="text-cyan"> --symbol={symbolFilter}</span>}<br />
          <span className="text-dim">total 0 — {symbolFilter ? `no ${symbolFilter} ${statusLabel} orders in window` : 'none'}</span>
        </div>
      ) : (
        <div className="overflow-x-auto rtable">
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
                {status === 'closed' && <th className="text-right px-4 py-2 font-normal">P/L</th>}
                {status === 'open' && <th className="text-right px-2 py-2 font-normal" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                const spread = describeSpreadOrder(o);
                const parsed = spread ? null : parseOptionSymbol(o.symbol ?? '');
                const expIso = spread?.expiration ?? parsed?.expiration ?? null;
                const dte = expIso ? daysToExpiration(expIso) : null;
                const lookupSymbol = spread?.underlying ?? parsed?.underlying ?? o.symbol;
                const isOption = !!parsed;
                return (
                  <tr key={o.id} className="border-b border-border/50 hover:bg-panel-2/40 transition-colors">
                    <td data-label="submitted" className="px-4 py-1.5 text-mid text-[11px]">{fmtSubmitted(o.submitted_at)}</td>
                    <td data-primary className="px-4 py-1.5 text-fg">
                      <Link to={`/lookup/${lookupSymbol}`} className="hover:text-hi">
                        {spread ? (
                          <>
                            <span className="text-dim mr-1">▸</span>
                            {spread.underlying}
                            <span className="text-dim ml-2 text-[10px]">
                              <span className={spread.type === 'put' ? 'text-red' : 'text-cyan'}>
                                {spread.label}
                              </span>{' '}
                              {fmtIsoDateMDY(spread.expiration)}
                            </span>
                          </>
                        ) : (
                          <>
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
                          </>
                        )}
                      </Link>
                    </td>
                    <td data-label="side" className={`px-4 py-1.5 ${spread ? 'text-mid' : sideColor(o.side)}`}>{spread ? 'spread' : o.side}</td>
                    <td data-label="type" className="px-4 py-1.5 text-mid">{o.type}</td>
                    <td data-label="qty" className="px-4 py-1.5 text-right text-fg">{fmtNum(Number(o.qty))}</td>
                    <td data-label="filled" className="px-4 py-1.5 text-right text-fg">{fmtNum(Number(o.filled_qty))}</td>
                    <td data-label="price" className="px-4 py-1.5 text-right text-fg">
                      {o.filled_avg_price
                        ? fmtUsd(Number(o.filled_avg_price))
                        : o.limit_price
                        ? <><span className="text-dim">lim </span>{fmtUsd(Number(o.limit_price))}</>
                        : o.stop_price
                        ? <><span className="text-dim">stp </span>{fmtUsd(Number(o.stop_price))}</>
                        : <span className="text-dim">—</span>}
                    </td>
                    <td data-label="status" className={`px-4 py-1.5 ${statusColor(o.status)}`}>{o.status}</td>
                    <td data-label="DTE" className={`px-4 py-1.5 text-right ${dte != null && dte <= 7 ? 'text-amber' : 'text-fg'}`}>
                      {dte == null ? <span className="text-dim">—</span> : `${dte}d`}
                    </td>
                    {status === 'closed' && (
                      <td
                        data-label="P/L"
                        className={`px-4 py-1.5 text-right ${
                          typeof o.realized_pl === 'number'
                            ? o.realized_pl >= 0 ? 'text-hi' : 'text-red'
                            : 'text-dim'
                        }`}
                        title={
                          typeof o.realized_pl !== 'number'
                            ? 'opener (or unpaired — original lot may be older than 90-day pairing window)'
                            : undefined
                        }
                      >
                        {typeof o.realized_pl === 'number' ? fmtPL(o.realized_pl) : '—'}
                      </td>
                    )}
                    {status === 'open' && (
                      <td data-label="action" className="px-2 py-1 text-right">
                        <span className="flex justify-end gap-1">
                          <button
                            type="button"
                            className="pbtn max-md:min-h-[40px] max-md:px-3"
                            onClick={() => setEditing(o)}
                          >
                            [modify]
                          </button>
                          <button
                            type="button"
                            className="pbtn max-md:min-h-[40px] max-md:px-3"
                            disabled={cancel.isPending}
                            onClick={() => {
                              if (window.confirm('cancel this order?')) cancel.mutate(o.id);
                            }}
                          >
                            [cancel]
                          </button>
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <OrderEditModal
          order={editing}
          mode={mode}
          onClose={() => setEditing(null)}
        />
      )}
    </article>
  );
}

interface VisibleCard {
  mode: OrderMode;
  acctKey: OrderAcctKey;
  label: string;
}

export default function Orders() {
  const [mode] = useAccount();
  const { handle } = useDisplayName();
  const [symbol, setSymbol] = useState<string>('');
  const [dateRange, setDateRange] = useState<DateRangeKey>('month-rolling');

  const visibleCards = useMemo<VisibleCard[]>(() => {
    return accountsForSelection(mode).map((m) => {
      const { acctKey, label } = ORDER_MODE_TO_CARD[m as OrderMode];
      return { mode: m as OrderMode, acctKey, label };
    });
  }, [mode]);

  // Date filter applies only to closed orders (open queue is always small + recent).
  const after = useMemo(() => dateRangeToAfter(dateRange), [dateRange]);

  // Issue all queries for visible cards × {open, closed} in one batch so we can
  // share data with both the table renderers and the symbol-dropdown aggregator.
  type QSpec = { card: VisibleCard; status: 'open' | 'closed' };
  const querySpecs: QSpec[] = useMemo(() => {
    const specs: QSpec[] = [];
    for (const card of visibleCards) {
      specs.push({ card, status: 'open' });
      specs.push({ card, status: 'closed' });
    }
    return specs;
  }, [visibleCards]);

  const queries = useQueries({
    queries: querySpecs.map(({ card, status }) => {
      // Only closed orders honor the `after` filter — open orders are typically <10 items.
      const afterParam = status === 'closed' && after ? `&after=${encodeURIComponent(after)}` : '';
      return {
        queryKey: ['orders', card.mode, status, status === 'closed' ? after : null] as const,
        queryFn: () =>
          api<{ orders: Order[] }>(`/api/alpaca/orders?mode=${card.mode}&status=${status}${afterParam}`),
      };
    }),
  });

  // Aggregate symbols across all visible queries for the dropdown.
  const symbolOptions = useMemo(
    () =>
      collectUnderlyings(
        ...queries.map(
          (q) =>
            q.data?.orders?.map(
              (o) => describeSpreadOrder(o)?.underlying ?? o.symbol ?? '',
            ) ?? [],
        ),
      ),
    [queries],
  );

  // Index queries back by (mode, status) for the renderer.
  const get = (cardMode: OrderMode, status: 'open' | 'closed') => {
    const idx = querySpecs.findIndex((s) => s.card.mode === cardMode && s.status === status);
    return queries[idx];
  };

  return (
    <div className="p-3 md:p-6 max-w-[1480px]">
      {/* prompt header */}
      <div className="flex items-baseline gap-2 mb-4 text-[12px] flex-wrap">
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
        <span className="text-fg">orders</span>
        <span className="text-amber">--list</span>
        <span className="text-dim">--mode=<span className="text-fg">{visibleCards.length === ALL_MODES.length ? 'all' : mode}</span></span>
        {symbol && <span className="text-dim">--symbol=<span className="text-fg">{symbol}</span></span>}
        <span className="text-dim">--range=<span className="text-fg">{dateRange}</span></span>
        <span className="caret" />
      </div>

      {/* title row */}
      <div className="flex flex-wrap items-end justify-between gap-y-3 gap-x-6 mb-5">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-hi text-[28px] md:text-[44px] font-bold leading-none tracking-tight">Orders</h1>
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

      <OrdersFilterBar
        symbols={symbolOptions}
        symbol={symbol}
        onSymbolChange={setSymbol}
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
      />

      {/* OPEN section */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-3 select-none">
        <span className="whitespace-nowrap">━━━ open</span>
        <span className="text-mid">[{visibleCards.length}]</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ orders --status=open</span>
      </div>
      <div className="grid gap-2 mb-6">
        {visibleCards.map((card) => {
          const q = get(card.mode, 'open');
          return (
            <OrdersTable
              key={`${card.mode}-open`}
              mode={card.mode}
              status="open"
              label={card.label}
              acctKey={card.acctKey}
              statusLabel="open"
              orders={q?.data?.orders ?? []}
              isLoading={q?.isLoading ?? true}
              isError={!!q?.error}
              symbolFilter={symbol}
            />
          );
        })}
      </div>

      {/* FILLED section */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-3 select-none">
        <span className="whitespace-nowrap">━━━ filled</span>
        <span className="text-mid">[{visibleCards.length}]</span>
        <span className="text-dim">·</span>
        <span className="text-cyan">{dateRange}</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ orders --status=closed --range={dateRange}</span>
      </div>
      <div className="grid gap-2">
        {visibleCards.map((card) => {
          const q = get(card.mode, 'closed');
          return (
            <OrdersTable
              key={`${card.mode}-closed`}
              mode={card.mode}
              status="closed"
              label={card.label}
              acctKey={card.acctKey}
              statusLabel="filled"
              orders={q?.data?.orders ?? []}
              isLoading={q?.isLoading ?? true}
              isError={!!q?.error}
              symbolFilter={symbol}
            />
          );
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
