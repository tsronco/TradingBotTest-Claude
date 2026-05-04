import { fmtUsd, fmtPct } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';

export function TradeHeader({ trade }: { trade: Trade }) {
  const closed = !!trade.closed_at;
  const pnl = trade.realized_pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-hi' : pnl < 0 ? 'text-red' : 'text-fg';
  const pct = trade.realized_pnl != null && trade.exposure_at_submit
    ? (trade.realized_pnl / trade.exposure_at_submit) * 100
    : null;

  return (
    <div className="flex justify-between items-end pb-3 border-b border-dashed border-border">
      <div>
        <h1 className="text-[18px] font-bold text-hi">Trade {trade.id}</h1>
        <div className="text-mid text-[10px]">
          // {trade.side.toUpperCase()} {trade.qty} {trade.symbol} · {trade.account} · {closed ? `closed ${trade.closed_at?.slice(0, 10)}` : 'open'}
        </div>
      </div>
      {closed && (
        <div className="text-right">
          <div className="text-mid text-[10px]">realized</div>
          <div className={`text-[20px] font-semibold tnum ${pnlColor}`}>
            {pnl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pnl))}
            {pct !== null && <> · {fmtPct(pct, { sign: true })}</>}
          </div>
        </div>
      )}
    </div>
  );
}
