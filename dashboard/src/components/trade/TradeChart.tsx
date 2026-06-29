import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createChart, ColorType, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import type { UTCTimestamp } from 'lightweight-charts';
import { api } from '../../lib/api';
import type { Trade } from '../../lib/trade-types';
import { accountToMode, type Mode } from '../../lib/account-utils';
import { tradeBreakevens } from '../../lib/trade-breakeven';

interface Bar { t: string; o: number; h: number; l: number; c: number; }

function toTs(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

export function TradeChart({ trade }: { trade: Trade }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Single source of truth — mirrors api/_lib/rule-check.ts accountToMode().
  // A live trade's chart must pull bars from the live account, not manual.
  const mode: Mode = accountToMode(trade.account);

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

    const containerEl = ref.current;
    // read once at chart-create; rotation keeps the initial height (acceptable — width tracks via the ResizeObserver below)
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    const chart = createChart(containerEl, {
      width: containerEl.clientWidth,
      // 180 mobile / 200 desktop — compact chart on phones
      height: isMobile ? 180 : 200,
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

    // Spread strikes — draw both as horizontal price lines so the chart
    // visually shows where the short and long legs sit relative to spot.
    if (trade.asset_class === 'spread' && trade.spread) {
      series.createPriceLine({
        price: trade.spread.short_leg.strike,
        color: '#f0b429',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `short $${trade.spread.short_leg.strike.toFixed(2)}`,
      });
      series.createPriceLine({
        price: trade.spread.long_leg.strike,
        color: '#5d8eff',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `long $${trade.spread.long_leg.strike.toFixed(2)}`,
      });
    }

    // Break-even — recomputed from the trade's entry data (same engine the
    // order form uses). Drawn for every asset class as a dashed cyan line so
    // it's obvious whether price sits above or below it.
    for (const be of tradeBreakevens(trade)) {
      series.createPriceLine({
        price: be,
        color: '#5ad1e6',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `BE $${be.toFixed(2)}`,
      });
    }

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: containerEl.clientWidth });
    });
    ro.observe(containerEl);

    return () => {
      ro.disconnect();
      chart.remove();
    };
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
