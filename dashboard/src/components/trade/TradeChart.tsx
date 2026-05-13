import { useEffect, useMemo, useRef } from 'react';
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
  const mode: 'conservative' | 'aggressive' | 'manual' | 'live' =
    trade.account === 'aggressive_paper' ? 'aggressive'
    : trade.account === 'manual_paper' ? 'manual'
    : trade.account === 'live' ? 'live'
    : 'conservative';

  // Pad an hour of pre-trade context so the chart is meaningful even for
  // a trade submitted minutes ago (1Hour bars wouldn't have closed yet).
  // Pad 15 min after close so a same-bar close still has a tick after it.
  //
  // CRITICAL: memoize the window so `new Date()` for the open-trade `end`
  // doesn't tick every render. An unmemoized `new Date().toISOString()`
  // changes the React Query key on every render → infinite refetch loop.
  // Re-derive only when the trade's actual timestamps change.
  const { start, end, timeframe } = useMemo(() => {
    const submitted = new Date(trade.submitted_at);
    const closeMs = trade.closed_at ? new Date(trade.closed_at).getTime() : Date.now();
    const startIso = new Date(submitted.getTime() - 60 * 60 * 1000).toISOString();
    const endIso = (trade.closed_at
      ? new Date(closeMs + 15 * 60 * 1000)
      : new Date(closeMs)  // freeze "now" at memo time, not every render
    ).toISOString();
    const durationDays = (closeMs - submitted.getTime()) / (24 * 60 * 60 * 1000);
    const tf = durationDays > 14 ? '1Hour' : durationDays > 2 ? '15Min' : '5Min';
    return { start: startIso, end: endIso, timeframe: tf };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // skip live-ticking "now" for open trades; we'd rather show a static
    // window than refetch every second. A page refresh re-renders with a
    // new "now".
  }, [trade.submitted_at, trade.closed_at]);

  const { data } = useQuery({
    queryKey: ['trade-bars', trade.id, start, end, timeframe],
    queryFn: () => api<{ bars: Bar[] }>(
      `/api/alpaca/bars?symbol=${trade.symbol}&mode=${mode}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeframe=${timeframe}`
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
