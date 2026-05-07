import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';

interface AcctResp {
  account: { buying_power: string; options_buying_power?: string; cash: string };
}

interface Props {
  /** Drives which account's BP to fetch — flips when the user toggles the selector. */
  mode: 'conservative' | 'aggressive' | 'manual';
  /** Stock orders draw from regular buying_power; option orders only from options_buying_power. */
  assetClass: 'stock' | 'option';
  /** Live exposure for the in-progress order. When provided, the indicator
   *  goes red if exposure exceeds available BP — surfacing the rejection
   *  Alpaca will throw before the user has to TOTP and submit. */
  exposure?: number;
}

export function AccountBpIndicator({ mode, assetClass, exposure }: Props) {
  // Same query key as AccountCard / WheelabilityPanel so React Query dedupes
  // — switching account triggers a single refetch shared across consumers.
  const acctQ = useQuery({
    queryKey: ['account', mode],
    queryFn: () => api<AcctResp>(`/api/alpaca/account?mode=${mode}`),
    staleTime: 30_000,
  });

  if (acctQ.isLoading || !acctQ.data) {
    return <div className="text-dim text-[10px] mt-2">loading bp…</div>;
  }

  const acct = acctQ.data.account;
  const bp = assetClass === 'option'
    ? Number(acct.options_buying_power ?? acct.buying_power)
    : Number(acct.buying_power);
  const label = assetClass === 'option' ? 'options bp' : 'buying power';
  const overflow = exposure != null && exposure > bp;

  return (
    <div className="mt-2 text-[10px] flex items-center gap-3 flex-wrap">
      <span className="text-dim tracking-[0.15em] uppercase">{label}</span>
      <span className={`tnum ${overflow ? 'text-red' : 'text-fg'}`}>{fmtUsd(bp)}</span>
      {overflow && (
        <span className="text-red text-[10px]">
          ⚠ exposure {fmtUsd(exposure!)} exceeds available bp — alpaca will reject
        </span>
      )}
    </div>
  );
}
