import { fmtUsd } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';

export function Timeline({ trade }: { trade: Trade }) {
  const events: Array<{ ts: string; tone: 'fg' | 'hi' | 'mid'; line: React.ReactNode }> = [];
  events.push({ ts: trade.submitted_at, tone: 'fg', line: <>submitted · {trade.order_type}{trade.limit_price ? ` ${fmtUsd(trade.limit_price)}` : ''} {trade.tif}</> });
  if (trade.filled_at) events.push({ ts: trade.filled_at, tone: 'hi', line: <>filled @ {fmtUsd(trade.filled_avg_price ?? 0)} · {trade.qty}</> });
  if (trade.closed_at) events.push({
    ts: trade.closed_at,
    tone: 'hi',
    line: <>closed @ {fmtUsd(trade.closed_avg_price ?? 0)} · {trade.realized_pnl != null ? `${trade.realized_pnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(trade.realized_pnl))}` : ''}</>,
  });

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
