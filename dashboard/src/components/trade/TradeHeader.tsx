import { fmtUsd, fmtPct } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';
import { tradeBreakevens } from '../../lib/trade-breakeven';

export function TradeHeader({ trade }: { trade: Trade }) {
  const closed = !!trade.closed_at;
  const canceled = trade.closed_by === 'canceled';
  const pnl = trade.realized_pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-hi' : pnl < 0 ? 'text-red' : 'text-fg';
  const pct = trade.realized_pnl != null && trade.exposure_at_submit
    ? (trade.realized_pnl / trade.exposure_at_submit) * 100
    : null;

  const statusText = !closed ? 'open'
    : canceled ? `canceled ${trade.closed_at?.slice(0, 10)}`
    : `closed ${trade.closed_at?.slice(0, 10)}`;

  const bes = tradeBreakevens(trade);
  const beText = bes.length ? bes.map((b) => fmtUsd(b)).join(' / ') : '—';

  return (
    <div className="flex justify-between items-end pb-3 border-b border-dashed border-border">
      <div>
        <h1 className="text-[18px] font-bold text-hi">Trade {trade.id}</h1>
        <div className="text-mid text-[10px]">
          // {trade.side.toUpperCase()} {trade.qty} {trade.symbol} · {trade.account} · {statusText}
        </div>
        <div className="text-mid text-[10px]">
          break-even <span className="text-fg">{beText}</span>
        </div>
      </div>
      {closed && (
        <div className="text-right">
          {canceled ? (
            <>
              <div className="text-mid text-[10px]">status</div>
              <div className="text-red text-[16px]">canceled — no fill</div>
            </>
          ) : (
            <>
              <div className="text-mid text-[10px]">realized</div>
              <div className={`text-[20px] font-semibold tnum ${pnlColor}`}>
                {pnl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pnl))}
                {pct !== null && <> · {fmtPct(pct, { sign: true })}</>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
