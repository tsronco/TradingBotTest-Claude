import { fmtUsd } from '../../lib/format';

/** Pre-review cash summary shown on every order form.
 *  - direction='debit'  → "Total Cost: $X"   (money leaving the account)
 *  - direction='credit' → "Total Credit: $X" (money entering the account)
 *  Collateral is BP locked while the position is open (CSP strike value,
 *  credit-spread max loss, stock cost for cash buys, 0 for long options /
 *  debit spreads / closes). */
export default function CashSummary({
  direction,
  amount,
  collateral,
}: {
  direction: 'debit' | 'credit';
  amount: number;
  collateral: number;
}) {
  const label = direction === 'debit' ? 'Total Cost' : 'Total Credit';
  const amtClass = direction === 'debit' ? 'text-red' : 'text-cyan';
  return (
    <div className="border border-dashed border-border rounded-sm px-3 py-2 bg-panel/40 text-[12px] tnum">
      <div className="flex justify-between">
        <span className="text-dim uppercase tracking-[0.15em] text-[10px]">{label}</span>
        <span className={`${amtClass} font-semibold`}>{fmtUsd(amount)}</span>
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-dim uppercase tracking-[0.15em] text-[10px]">Collateral Held</span>
        <span className="text-fg">{fmtUsd(collateral)}</span>
      </div>
    </div>
  );
}
