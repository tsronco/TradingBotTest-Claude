import { useEffect, useRef } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Props { dateRange: string; account: string; }

interface History {
  history: { timestamp: number[]; equity: number[] };
}

const PERIODS: Record<string, { period: string; timeframe: string }> = {
  ALL: { period: '1A', timeframe: '1D' },
  '1Y': { period: '1A', timeframe: '1D' },
  '3M': { period: '3M', timeframe: '1D' },
  '1M': { period: '1M', timeframe: '1D' },
  '1W': { period: '1W', timeframe: '1H' },
};

export default function EquityPanel({ dateRange, account }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cfg = PERIODS[dateRange] ?? PERIODS.ALL;

  const showCons = !account || account === 'conservative_paper';
  const showAgg  = !account || account === 'aggressive_paper';
  const showMan  = !account || account === 'manual_paper';

  const cons = useEquityHistory('conservative', cfg, showCons);
  const agg  = useEquityHistory('aggressive',  cfg, showAgg);
  const man  = useEquityHistory('manual',      cfg, showMan);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 220,
      layout: { background: { color: 'transparent' }, textColor: 'rgba(220, 220, 220, 0.7)' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    });

    if (showCons && cons.data?.history?.equity?.length) {
      const s = chart.addSeries(LineSeries, { color: '#22d3ee', lineWidth: 2 });
      s.setData(toData(cons.data.history));
    }
    if (showAgg && agg.data?.history?.equity?.length) {
      const s = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2 });
      s.setData(toData(agg.data.history));
    }
    if (showMan && man.data?.history?.equity?.length) {
      const s = chart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 2 });
      s.setData(toData(man.data.history));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [showCons, showAgg, showMan, cons.data, agg.data, man.data]);

  return (
    <div>
      <div ref={ref} />
      <div className="text-[10px] text-dim mt-2 flex gap-3">
        {showCons && <span><span className="inline-block w-2 h-2 mr-1" style={{ background: '#22d3ee' }} />conservative</span>}
        {showAgg && <span><span className="inline-block w-2 h-2 mr-1" style={{ background: '#f59e0b' }} />aggressive</span>}
        {showMan && <span><span className="inline-block w-2 h-2 mr-1" style={{ background: '#a78bfa' }} />manual</span>}
      </div>
    </div>
  );
}

function useEquityHistory(mode: string, cfg: { period: string; timeframe: string }, enabled: boolean) {
  return useQuery({
    queryKey: ['equity-history', mode, cfg.period, cfg.timeframe],
    queryFn: () => api<History & { mode: string }>(`/api/alpaca/equity-history?mode=${mode}&period=${cfg.period}&timeframe=${cfg.timeframe}`),
    enabled,
  });
}

function toData(history: { timestamp: number[]; equity: number[] }) {
  return history.timestamp.map((ts, i) => ({ time: ts as never, value: history.equity[i] }));
}
