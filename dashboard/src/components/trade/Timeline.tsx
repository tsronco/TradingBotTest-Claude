import { fmtUsd } from '../../lib/format';
import type { Trade, ModifyEvent } from '../../lib/trade-types';

function modifyLine(m: ModifyEvent, prevLimit: number | null | undefined): React.ReactNode {
  // Only show fields that actually changed vs the previous order. If the
  // user only patched limit_price, qty doesn't render — keeps the timeline
  // tight even when Alpaca echoes back unchanged params on the new order.
  const parts: string[] = [];
  if (m.limit_price != null && m.limit_price !== prevLimit) {
    parts.push(`limit ${fmtUsd(m.limit_price)}`);
  }
  if (m.qty != null && m.qty !== undefined) {
    // qty change isn't easily diff-able without prev qty in the event; show it
    // when the modify event explicitly captured it
    parts.push(`qty ${m.qty}`);
  }
  if (m.stop_price != null) {
    parts.push(`stop ${fmtUsd(m.stop_price)}`);
  }
  const label = parts.length ? parts.join(' · ') : 'order updated';
  const tag = m.source === 'backfill' ? ' (backfill)' : '';
  return <>modified · {label}<span className="text-dim">{tag}</span></>;
}

export function Timeline({ trade }: { trade: Trade }) {
  const events: Array<{ ts: string; tone: 'fg' | 'hi' | 'mid'; line: React.ReactNode }> = [];
  events.push({ ts: trade.submitted_at, tone: 'fg', line: <>submitted · {trade.order_type}{trade.limit_price ? ` ${fmtUsd(trade.limit_price)}` : ''} {trade.tif}</> });

  // Modify history — diff each entry against the previous limit_price so the
  // timeline reads like a sequence of edits rather than restating every field.
  let prevLimit: number | null | undefined = trade.limit_price;
  for (const m of trade.modify_history ?? []) {
    events.push({ ts: m.ts, tone: 'mid', line: modifyLine(m, prevLimit) });
    if (m.limit_price !== undefined) prevLimit = m.limit_price;
  }

  if (trade.filled_at) events.push({ ts: trade.filled_at, tone: 'hi', line: <>filled @ {fmtUsd(trade.filled_avg_price ?? 0)} · {trade.qty}</> });
  if (trade.closed_at) events.push({
    ts: trade.closed_at,
    tone: 'hi',
    line: <>closed @ {fmtUsd(trade.closed_avg_price ?? 0)} · {trade.realized_pnl != null ? `${trade.realized_pnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(trade.realized_pnl))}` : ''}</>,
  });

  // Sort by ts so backfilled modifies interleave correctly with filled/closed.
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TIMELINE</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4 text-[10px]">
        {events.map((e, i) => (
          <div key={i} className="flex gap-3 py-1 border-b border-dashed border-border last:border-b-0">
            <span className="text-dim w-32">{e.ts.slice(0, 16).replace('T', ' ')}</span>
            <span className="text-hi">▸</span>
            <span className={`text-${e.tone}`}>{e.line}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
