import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';

export default function AccountCard({ mode, label }: { mode: 'conservative' | 'aggressive'; label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['account', mode],
    queryFn: () => api<{ account: any }>(`/api/alpaca/account?mode=${mode}`),
  });

  if (isLoading) return <div className="bg-panel border border-border rounded-xl p-5 text-muted">Loading {label}…</div>;
  if (error || !data) return <div className="bg-panel border border-red rounded-xl p-5 text-red">Failed to load {label}</div>;

  const a = data.account;
  const equity = Number(a.equity);
  const lastEquity = Number(a.last_equity);
  const dayChange = equity - lastEquity;
  const dayChangePct = lastEquity ? (dayChange / lastEquity) * 100 : 0;
  const dayClass = dayChange >= 0 ? 'text-green' : 'text-red';

  return (
    <div className="bg-panel border border-border rounded-xl p-5">
      <div className="text-muted text-[10px] uppercase tracking-wider mb-2">{label}</div>
      <div className="text-text-strong text-2xl font-bold">{fmtUsd(equity)}</div>
      <div className={`text-sm ${dayClass}`}>
        {fmtUsd(dayChange, { sign: true })} ({fmtPct(dayChangePct, { sign: true })}) today
      </div>
      <div className="grid grid-cols-2 gap-y-1 mt-4 text-xs">
        <span className="text-muted">Buying power</span>
        <span className="text-text text-right">{fmtUsd(Number(a.buying_power))}</span>
        <span className="text-muted">Cash</span>
        <span className="text-text text-right">{fmtUsd(Number(a.cash))}</span>
        <span className="text-muted">Long mkt value</span>
        <span className="text-text text-right">{fmtUsd(Number(a.long_market_value))}</span>
        <span className="text-muted">Short mkt value</span>
        <span className="text-text text-right">{fmtUsd(Number(a.short_market_value))}</span>
      </div>
    </div>
  );
}
