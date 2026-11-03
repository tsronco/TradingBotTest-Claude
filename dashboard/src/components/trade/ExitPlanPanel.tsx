// dashboard/src/components/trade/ExitPlanPanel.tsx
//
// Your exit plan (optional stop/target from the order form) next to the bot's
// stop and the actual exit, on stock trades. Groundwork for comparing your
// exits against the bot's 10% stop once enough trades carry a plan.

import type { Trade } from '../../lib/trade-types';
import { botStopFor, BOT_STOP_PCT } from '../../lib/exit-plan';
import { fmtUsd } from '../../lib/format';

export function ExitPlanPanel({ trade }: { trade: Trade }) {
  // Stocks only, and only opening trades — a closing sale has no plan of its own.
  if (trade.asset_class !== 'stock' || trade.side === 'sell') return null;

  const entry = trade.filled_avg_price ?? trade.limit_price ?? null;
  const botStop = trade.side === 'buy' && entry != null ? botStopFor(entry) : null;
  const hasPlan = trade.planned_stop != null || trade.planned_target != null;
  const price = (v: number | null | undefined) =>
    v == null ? <span className="text-dim">—</span> : <span className="text-fg">{fmtUsd(v)}</span>;

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">EXIT PLAN</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 text-[12px] tnum">
        {!hasPlan && (
          <div className="text-dim text-[11px] mb-2" data-testid="no-exit-plan">
            — no exit plan recorded for this trade —
          </div>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span><span className="text-dim uppercase tracking-[0.12em] mr-1.5">your stop</span>{price(trade.planned_stop)}</span>
          <span><span className="text-dim uppercase tracking-[0.12em] mr-1.5">your target</span>{price(trade.planned_target)}</span>
          {botStop != null && (
            <span title={`The bot sells at ${Math.round(BOT_STOP_PCT * 100)}% below average cost. Approximate: it moves if shares are added.`}>
              <span className="text-dim uppercase tracking-[0.12em] mr-1.5">bot stop ≈</span>{price(botStop)}
            </span>
          )}
          {trade.closed_at && (
            <span><span className="text-dim uppercase tracking-[0.12em] mr-1.5">actual exit</span>{price(trade.closed_avg_price)}</span>
          )}
        </div>
      </div>
    </article>
  );
}
