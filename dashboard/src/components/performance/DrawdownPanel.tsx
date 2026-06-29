import { useEffect, useMemo, useRef } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Props { dateRange: string; account: string; }

const PERIODS: Record<string, { period: string; timeframe: string }> = {
  ALL: { period: '1A', timeframe: '1D' },
  '1Y': { period: '1A', timeframe: '1D' },
  '3M': { period: '3M', timeframe: '1D' },
  '1M': { period: '1M', timeframe: '1D' },
  '1W': { period: '1W', timeframe: '1H' },
};

export default function DrawdownPanel({ dateRange, account }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cfg = PERIODS[dateRange] ?? PERIODS.ALL;
  const accountForApi = account ? account.replace('_paper', '') : 'manual';

  const q = useQuery({
    queryKey: ['equity-history', accountForApi, cfg.period, cfg.timeframe],
    queryFn: () => api<{ history: { timestamp: number[]; equity: number[] } }>(
      `/api/alpaca/equity-history?mode=${accountForApi}&period=${cfg.period}&timeframe=${cfg.timeframe}`,
    ),
  });

  const data = useMemo(() => {
    if (!q.data?.history?.equity?.length) return [];
    let peak = -Infinity;
    return q.data.history.timestamp.map((ts, i) => {
      const eq = q.data!.history.equity[i];
      if (eq > peak) peak = eq;
      const ddPct = peak > 0 ? ((eq - peak) / peak) * 100 : 0;
      return { time: ts as never, value: ddPct };
    });
  }, [q.data]);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 200,
      layout: { background: { color: 'transparent' }, textColor: 'rgba(220, 220, 220, 0.7)' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(LineSeries, { color: '#ef4444', lineWidth: 2 });
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  return (
    <div>
      <div ref={ref} />
      <div className="text-[10px] text-dim mt-2">
        Showing {accountForApi}. Negative % = below peak equity.
      </div>
    </div>
  );
}
