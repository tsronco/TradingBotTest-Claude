import { optionTypeForSpread, isCreditSpread } from '../../lib/trade-types';
import type { Trade } from '../../lib/trade-types';

/**
 * Spread summary on the trade detail page.
 *
 * Two things this panel has to get right, because both were wrong when it only
 * ever saw single-lot put credit spreads:
 *
 *  • The option type comes from the SPREAD TYPE, not a hardcoded 'put'. A call
 *    vertical labelled "put" is not a cosmetic slip — a $103 put on a $94 stock
 *    would be deep in the money and worth ~$9, so the label and the premium
 *    contradict each other and neither can be trusted.
 *
 *  • Dollar figures are per-share × 100 × QTY. `SpreadDetails.max_loss` is
 *    per-share; multiplying by 100 alone gives one contract's risk and silently
 *    drops position size. (The risk *guardrails* — exposure.ts and
 *    rule-check.ts — always did include qty; this was display-only. But a risk
 *    number on screen that understates by the lot count is its own hazard.)
 */
export function SpreadMetadata({ trade }: { trade: Trade }) {
  if (trade.asset_class !== 'spread' || !trade.spread) return null;
  const s = trade.spread;
  const qty = trade.qty || 1;
  const optionType = optionTypeForSpread(s.spread_type);
  const credit = isCreditSpread(s.spread_type);

  const perShare = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
  // Per-share → position dollars. The multiplier is 100 shares per contract,
  // times the number of contracts.
  const position = (v: number | null | undefined) =>
    v == null ? '—' : `$${(v * 100 * qty).toFixed(2)}`;

  // Credit spreads carry net_credit; debit spreads carry net_debit and leave
  // net_credit at 0, so labelling this "Net credit" unconditionally reported
  // $0.00 on every debit spread.
  const netLabel = credit ? 'Net credit' : 'Net debit';
  const netValue = credit ? s.net_credit : (s.net_debit ?? -s.net_credit);

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">SPREAD</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 space-y-1 text-[12px] text-fg">
        <div>
          Type: <span className="text-cyan">{s.spread_type.replace(/_/g, ' ')}</span>
          <span className="text-dim"> · {qty} contract{qty === 1 ? '' : 's'}</span>
        </div>
        <div>
          Short ${s.short_leg.strike.toFixed(2)} {optionType} — entry {perShare(s.short_leg.entry_premium)}, fill {perShare(s.short_leg.fill_price)}
        </div>
        <div>
          Long ${s.long_leg.strike.toFixed(2)} {optionType} — entry {perShare(s.long_leg.entry_premium)}, fill {perShare(s.long_leg.fill_price)}
        </div>
        <div>Width: ${s.width.toFixed(2)}</div>
        <div>{netLabel}: {perShare(netValue)} ({position(netValue)})</div>
        <div>
          Max loss: <span className="text-red">{perShare(s.max_loss)} ({position(s.max_loss)})</span>
        </div>
        {s.max_profit != null && (
          <div>
            Max profit: <span className="text-hi">{perShare(s.max_profit)} ({position(s.max_profit)})</span>
          </div>
        )}
        <div>Expiration: <span className="text-mid">{s.expiration}</span></div>
      </div>
    </article>
  );
}
