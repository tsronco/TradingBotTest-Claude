import { useEffect, useRef, useState } from 'react';
import { fmtUsd } from '../lib/format';
import type { Period, Granularity } from '../hooks/usePeriod';

export interface EquityChartProps {
  /** Equity values, ordered earliest → latest. Length must match `timestamps`. */
  values: number[];
  /** Unix epoch seconds parallel to `values`. */
  timestamps: number[];
  /** Used to format the hover-date label (date vs. time). */
  period: Period;
  /** Only consulted when period === '1D' for clock-time formatting. */
  granularity?: Granularity;
  /** Phosphor color for the line + dot (hex). Defaults to bright green. */
  color?: string;
  /** Called on hover with the snapped index, or null on mouseleave. */
  onHover?: (idx: number | null) => void;
  className?: string;
}

const VIEW_W = 600;
const VIEW_H = 180;
const PAD_X = 8;
const PAD_Y = 12;

/** Format a Unix-epoch-seconds timestamp into a label appropriate to the period. */
function formatStamp(epochSec: number, period: Period): string {
  const d = new Date(epochSec * 1000);
  if (period === '1D') {
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }
  if (period === '1A') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function EquityChart({
  values,
  color = '#22ff88',
  onHover,
  className,
}: EquityChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const hasData = values.length >= 2;
  const rawMin = hasData ? Math.min(...values) : 0;
  const rawMax = hasData ? Math.max(...values) : 1;
  // Pad the Y-axis so a flat-ish series doesn't fill the chart with magnified
  // micro-noise. Floor the visible range at 1% of max — meaningful moves still
  // show clearly, but a $300 swing on a $100k account renders as a small wave
  // around a stable baseline rather than a wild fake spike.
  const minVisibleRange = (rawMax || 1) * 0.01;
  const rawRange = rawMax - rawMin;
  const center = (rawMin + rawMax) / 2;
  const padded = rawRange < minVisibleRange;
  const min = padded ? center - minVisibleRange / 2 : rawMin;
  const max = padded ? center + minVisibleRange / 2 : rawMax;
  const range = max - min || 1;

  const xAt = (i: number) => PAD_X + (i / Math.max(1, values.length - 1)) * (VIEW_W - PAD_X * 2);
  const yAt = (v: number) => VIEW_H - PAD_Y - ((v - min) / range) * (VIEW_H - PAD_Y * 2);

  const linePath = hasData ? values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`).join(' ') : '';
  const areaPath = hasData ? `${linePath} L${xAt(values.length - 1).toFixed(2)} ${VIEW_H - PAD_Y} L${xAt(0).toFixed(2)} ${VIEW_H - PAD_Y} Z` : '';

  const lastIdx = values.length - 1;
  const endX = hasData ? xAt(lastIdx) : 0;
  const endY = hasData ? yAt(values[lastIdx]) : 0;
  const hoverPoint = hasData && hoverIdx != null ? { x: xAt(hoverIdx), y: yAt(values[hoverIdx]), v: values[hoverIdx] } : null;

  // Update floating label position on hover
  useEffect(() => {
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    const label = labelRef.current;
    if (!wrap || !svg || !label) return;

    if (hoverIdx == null || !hoverPoint) {
      label.classList.remove('visible');
      svg.classList.remove('is-hovering');
      return;
    }

    svg.classList.add('is-hovering');
    label.classList.add('visible');
    label.textContent = fmtUsd(hoverPoint.v);

    const wrapRect = wrap.getBoundingClientRect();
    const xPx = (hoverPoint.x / VIEW_W) * wrapRect.width;
    const yPx = (hoverPoint.y / VIEW_H) * wrapRect.height;
    label.style.left = `${xPx}px`;
    label.style.top = `${yPx}px`;
    label.style.color = color;

    // Edge-flip the label so it doesn't clip on the right or left
    const lw = label.offsetWidth;
    if (xPx + lw / 2 + 6 > wrapRect.width) label.style.transform = 'translate(-100%, -130%)';
    else if (xPx - lw / 2 - 6 < 0) label.style.transform = 'translate(0, -130%)';
    else label.style.transform = 'translate(-50%, -130%)';
  }, [hoverIdx, hoverPoint, color]);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const idx = Math.max(
      0,
      Math.min(values.length - 1, Math.round(((vx - PAD_X) / (VIEW_W - PAD_X * 2)) * (values.length - 1)))
    );
    if (idx !== hoverIdx) {
      setHoverIdx(idx);
      onHover?.(idx);
    }
  }

  function onLeave() {
    if (hoverIdx != null) {
      setHoverIdx(null);
      onHover?.(null);
    }
  }

  // unique gradient id per chart instance so multiple charts on a page don't collide
  const gradId = `eq-grad-${color.replace('#', '')}`;

  if (!hasData) {
    return (
      <div className={className} style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" data-role="chart" />
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        data-role="chart"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* horizontal gridlines */}
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={PAD_X}
            x2={VIEW_W - PAD_X}
            y1={PAD_Y + (VIEW_H - PAD_Y * 2) * p}
            y2={PAD_Y + (VIEW_H - PAD_Y * 2) * p}
            stroke="#143a25"
            strokeDasharray="2 4"
            strokeWidth="0.5"
          />
        ))}

        {/* area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />

        {/* line */}
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 2px ${color}55)` }}
        />

        {/* now layer (period-end marker, dimmed during hover) */}
        <g className="now-layer">
          <line x1={endX} x2={endX} y1={PAD_Y} y2={VIEW_H - PAD_Y} stroke={color} strokeOpacity="0.25" strokeDasharray="2 3" />
          <circle cx={endX} cy={endY} r="3.5" fill={color} stroke="#05080a" strokeWidth="1" />
        </g>

        {/* hover layer (crosshair + dot) */}
        <g className="hover-layer">
          {hoverPoint && (
            <>
              <line x1={hoverPoint.x} x2={hoverPoint.x} y1={PAD_Y} y2={VIEW_H - PAD_Y} stroke={color} strokeOpacity="0.7" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="3.5" fill={color} stroke="#05080a" strokeWidth="1.5" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="6" fill={color} fillOpacity="0.15" />
            </>
          )}
        </g>
      </svg>

      <div ref={labelRef} className="hover-label" />
    </div>
  );
}

/** Public helper used by AccountCard's hover handler to format a date label. */
export function formatHoverDate(timestamps: number[], idx: number, period: Period): string {
  if (idx < 0 || idx >= timestamps.length) return '';
  return formatStamp(timestamps[idx], period);
}
