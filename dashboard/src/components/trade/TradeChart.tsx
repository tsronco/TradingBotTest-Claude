import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createChart, ColorType, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import type { UTCTimestamp } from 'lightweight-charts';
import { api } from '../../lib/api';
import type { Trade } from '../../lib/trade-types';

interface Bar { t: string; o: number; h: number; l: number; c: number; }

function toTs(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

export function TradeChart({ trade }: { trade: Trade }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mode = trade.account === 'aggressive_paper' ? 'aggressive' : 'conservative';

  const start = trade.submitted_at;
  const end = trade.closed_at ?? new Date().toISOString();

  const { data } = useQuery({
    queryKey: ['trade-bars', trade.id, start, end],
    queryFn: () => api<{ bars: Bar[] }>(
      `/api/alpaca/bars?symbol=${trade.symbol}&mode=${mode}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeframe=1Hour`
    ),
  });

  useEffect(() => {
    if (!ref.current || !data?.bars?.length) return;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 200,
      layout: {
        background: { type: ColorType.Solid, color: '#05080a' },
        textColor: '#a7e0c2',
        fontFamily: 'JetBrains Mono',
      },
      grid: { vertLines: { color: '#143a25' }, horzLines: { color: '#143a25' } },
      timeScale: { borderColor: '#143a25' },
      rightPriceScale: { borderColor: '#143a25' },
    });

    // v5 API: addSeries(SeriesDefinition, options)
    const series = chart.addSeries(LineSeries, { color: '#22ff88', lineWidth: 1 });
    series.setData(data.bars.map((b) => ({ time: toTs(b.t), value: b.c })));

    // v5 API: createSeriesMarkers(series, markers[]) — plugin function, not method
    if (trade.filled_at && trade.filled_avg_price) {
      createSeriesMarkers(series, [
        {
          time: toTs(trade.filled_at),
          position: 'belowBar',
          color: '#22ff88',
          shape: 'arrowUp',
          text: `entry ${trade.filled_avg_price}`,
        },
        ...(trade.closed_at && trade.closed_avg_price
          ? [{
              time: toTs(trade.closed_at),
              position: 'aboveBar' as const,
              color: '#22ff88',
              shape: 'arrowDown' as const,
              text: `exit ${trade.closed_avg_price}`,
            }]
          : []),
      ]);
    }

    return () => chart.remove();
  }, [data, trade]);

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">CHART</span><span className="text-dim">──┐</span>
      </div>
      <div ref={ref} className="p-2 h-[220px]" />
    </article>
  );
}
