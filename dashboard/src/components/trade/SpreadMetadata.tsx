import type { Trade } from '../../lib/trade-types';

export function SpreadMetadata({ trade }: { trade: Trade }) {
  if (trade.asset_class !== 'spread' || !trade.spread) return null;
  const s = trade.spread;
  const fmt = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);
  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">SPREAD</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 space-y-1 text-[12px] text-fg">
        <div>Type: <span className="text-cyan">{s.spread_type.replace(/_/g, ' ')}</span></div>
        <div>
          Short ${s.short_leg.strike.toFixed(2)} put — entry {fmt(s.short_leg.entry_premium)}, fill {fmt(s.short_leg.fill_price)}
        </div>
        <div>
          Long ${s.long_leg.strike.toFixed(2)} put — entry {fmt(s.long_leg.entry_premium)}, fill {fmt(s.long_leg.fill_price)}
        </div>
        <div>Net credit: ${s.net_credit.toFixed(2)} (${(s.net_credit * 100).toFixed(2)})</div>
        <div>Max loss: ${s.max_loss.toFixed(2)} (${(s.max_loss * 100).toFixed(2)})</div>
        <div>Expiration: <span className="text-mid">{s.expiration}</span></div>
      </div>
    </article>
  );
}
