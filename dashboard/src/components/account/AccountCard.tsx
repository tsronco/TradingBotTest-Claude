import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import Sparkline from '../Sparkline';

type Period = '1D' | '1W' | '1M' | '3M' | '1A' | 'all';

const PERIODS: { value: Period; label: string }[] = [
  { value: '1D', label: '1D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '1A', label: '1Y' },
];

interface HistoryResp {
  history?: {
    timestamp?: number[];
    equity?: number[];
    profit_loss?: number[];
    profit_loss_pct?: number[];
    base_value?: number;
  };
}

export default function AccountCard({ mode, label }: { mode: 'conservative' | 'aggressive'; label: string }) {
  const [period, setPeriod] = useState<Period>('1M');

  const { data, isLoading, error } = useQuery({
    queryKey: ['account', mode],
    queryFn: () => api<{ account: any }>(`/api/alpaca/account?mode=${mode}`),
  });

  // Hourly granularity for short windows, daily for long ones (Alpaca requires
  // sub-day timeframes only on intraday windows).
  const timeframe = period === '1D' || period === '1W' ? '1H' : '1D';
  const histQ = useQuery({
    queryKey: ['equity-history', mode, period, timeframe],
    queryFn: () => api<HistoryResp>(`/api/alpaca/equity-history?mode=${mode}&period=${period}&timeframe=${timeframe}`),
    staleTime: 60_000,
  });

  if (isLoading) return <div className="bg-panel border border-border rounded-xl p-5 text-muted">Loading {label}…</div>;
  if (error || !data) return <div className="bg-panel border border-red rounded-xl p-5 text-red">Failed to load {label}</div>;

  const a = data.account;
  const equity = Number(a.equity);
  const lastEquity = Number(a.last_equity);
  const dayChange = equity - lastEquity;
  const dayChangePct = lastEquity ? (dayChange / lastEquity) * 100 : 0;
  const dayClass = dayChange >= 0 ? 'text-green' : 'text-red';

  // Sparkline data + period-over-period change.
  const equityHistory = histQ.data?.history?.equity ?? [];
  const periodStart = equityHistory.length > 0 ? equityHistory[0] : null;
  const periodChange = periodStart != null ? equity - periodStart : null;
  const periodChangePct = periodStart != null && periodStart > 0 ? (periodChange! / periodStart) * 100 : null;
  const periodClass = (periodChange ?? 0) >= 0 ? 'text-green' : 'text-red';

  return (
    <div className="bg-panel border border-border rounded-xl p-5">
      <div className="text-muted text-[10px] uppercase tracking-wider mb-2">{label}</div>
      <div className="text-text-strong text-2xl font-bold">{fmtUsd(equity)}</div>
      <div className={`text-sm ${dayClass}`}>
        {fmtUsd(dayChange, { sign: true })} ({fmtPct(dayChangePct, { sign: true })}) today
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <div className="inline-flex bg-panel-2 border border-border rounded overflow-hidden text-[10px]">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-2 py-0.5 ${
                  period === p.value
                    ? 'bg-panel text-text-strong'
                    : 'text-muted hover:text-text'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {periodChange != null && (
            <div className={`text-[10px] ${periodClass}`}>
              {fmtUsd(periodChange, { sign: true })} ({fmtPct(periodChangePct ?? 0, { sign: true })})
            </div>
          )}
        </div>
        {histQ.isLoading ? (
          <div className="h-[56px] flex items-center text-muted text-[10px]">loading…</div>
        ) : (
          <Sparkline values={equityHistory} width={280} height={56} className="w-full" />
        )}
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
