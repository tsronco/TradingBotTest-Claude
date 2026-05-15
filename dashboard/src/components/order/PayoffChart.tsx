// dashboard/src/components/order/PayoffChart.tsx
import { useMemo, useRef, useState } from 'react';
import { buildPayoff, totalPL } from '../../lib/payoff';
import type { Leg, PayoffResult } from '../../lib/payoff';
import { fmtUsd } from '../../lib/format';

interface Props {
  legs: Leg[];
  currentPrice: number;
}

const VIEW_W = 600;
const VIEW_H = 180;
const PAD_X = 8;
const PAD_Y = 16;

export default function PayoffChart({ legs, currentPrice }: Props) {
  const result: PayoffResult = useMemo(
    () => buildPayoff(legs, currentPrice),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(legs), currentPrice]
  );

  if (result.points.length === 0) return null;

  const { points, maxProfit, maxLoss, breakevens, window: win } = result;

  const [scrubPrice, setScrubPrice] = useState<number>(currentPrice);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  // Map price → SVG x coordinate
  const priceRange = win.hi - win.lo || 1;
  const xAt = (price: number) => PAD_X + ((price - win.lo) / priceRange) * (VIEW_W - PAD_X * 2);

  // Map pl → SVG y coordinate
  const allPLs = points.map((p) => p.pl);
  const minPL = Math.min(...allPLs, 0);
  const maxPLVal = Math.max(...allPLs, 0);
  const plRange = maxPLVal - minPL || 1;
  const yAt = (pl: number) => VIEW_H - PAD_Y - ((pl - minPL) / plRange) * (VIEW_H - PAD_Y * 2);
  const zeroY = yAt(0);

  // Build two-color polyline segments: green where pl>=0, red where pl<0
  function buildSegments() {
    if (points.length < 2) return { green: '', red: '' };
    const greenPts: string[] = [];
    const redPts: string[] = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const x = xAt(p.price).toFixed(2);
      const y = yAt(p.pl).toFixed(2);
      if (p.pl >= 0) {
        greenPts.push(`${x},${y}`);
      } else {
        redPts.push(`${x},${y}`);
      }
      // At sign crossings, add the zero crossing point to both
      if (i + 1 < points.length) {
        const next = points[i + 1];
        if ((p.pl < 0 && next.pl >= 0) || (p.pl >= 0 && next.pl < 0)) {
          // linear interpolation for zero crossing
          const t = p.pl / (p.pl - next.pl);
          const crossPrice = p.price + t * (next.price - p.price);
          const cx = xAt(crossPrice).toFixed(2);
          const cy = yAt(0).toFixed(2);
          if (p.pl < 0) {
            redPts.push(`${cx},${cy}`);
            greenPts.push(`${cx},${cy}`);
          } else {
            greenPts.push(`${cx},${cy}`);
            redPts.push(`${cx},${cy}`);
          }
        }
      }
    }

    return {
      green: greenPts.length >= 2 ? `M${greenPts.join(' L')}` : '',
      red: redPts.length >= 2 ? `M${redPts.join(' L')}` : '',
    };
  }

  const { green: greenPath, red: redPath } = buildSegments();

  // Scrubber interaction
  function clientXToPrice(clientX: number): number {
    const svg = svgRef.current;
    if (!svg) return scrubPrice;
    const rect = svg.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * VIEW_W;
    const price = win.lo + ((vx - PAD_X) / (VIEW_W - PAD_X * 2)) * priceRange;
    return Math.max(win.lo, Math.min(win.hi, price));
  }

  function onPointerDown(e: React.PointerEvent<SVGGElement>) {
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setScrubPrice(clientXToPrice(e.clientX));
  }

  function onPointerMove(e: React.PointerEvent<SVGGElement>) {
    if (!dragging.current) return;
    setScrubPrice(clientXToPrice(e.clientX));
  }

  function onPointerUp(e: React.PointerEvent<SVGGElement>) {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  const step = priceRange / 96;

  function onKeyDown(e: React.KeyboardEvent<SVGGElement>) {
    if (e.key === 'ArrowLeft') {
      setScrubPrice((p) => Math.max(win.lo, p - step));
    } else if (e.key === 'ArrowRight') {
      setScrubPrice((p) => Math.min(win.hi, p + step));
    }
  }

  const scrubX = xAt(scrubPrice);
  const scrubPL = totalPL(scrubPrice, legs);

  return (
    <div className="w-full">
      {/* Chart SVG */}
      <div className="h-[200px] max-md:h-[170px] w-full relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="w-full h-full"
        >
          {/* zero axis */}
          <line
            x1={PAD_X}
            x2={VIEW_W - PAD_X}
            y1={zeroY}
            y2={zeroY}
            stroke="var(--color-dim)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />

          {/* green segment (profit) */}
          {greenPath && (
            <path
              d={greenPath}
              fill="none"
              stroke="var(--color-hi)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* red segment (loss) */}
          {redPath && (
            <path
              d={redPath}
              fill="none"
              stroke="var(--color-red)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* current price marker */}
          <line
            x1={xAt(currentPrice)}
            x2={xAt(currentPrice)}
            y1={PAD_Y}
            y2={VIEW_H - PAD_Y}
            stroke="var(--color-mid)"
            strokeWidth="1"
            strokeDasharray="2 4"
          />

          {/* breakeven markers */}
          {breakevens.map((be) => (
            <line
              key={be}
              x1={xAt(be)}
              x2={xAt(be)}
              y1={PAD_Y}
              y2={VIEW_H - PAD_Y}
              stroke="var(--color-amber)"
              strokeWidth="1"
              strokeDasharray="4 3"
              strokeOpacity="0.7"
            />
          ))}

          {/* strike tick marks */}
          {legs
            .filter((l): l is import('../../lib/payoff').OptionLeg => l.kind === 'option')
            .map((l) => (
              <line
                key={`strike-${l.strike}`}
                x1={xAt(l.strike)}
                x2={xAt(l.strike)}
                y1={VIEW_H - PAD_Y}
                y2={VIEW_H - PAD_Y + 5}
                stroke="var(--color-mid)"
                strokeWidth="1.5"
              />
            ))}

          {/* draggable scrubber */}
          <g
            role="slider"
            aria-label="P/L at underlying price"
            aria-valuemin={win.lo}
            aria-valuemax={win.hi}
            aria-valuenow={scrubPrice}
            aria-valuetext={`Underlying ${fmtUsd(scrubPrice)}, P/L ${fmtUsd(scrubPL)}`}
            tabIndex={0}
            className="payoff-scrub"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            {/* invisible wide hit area */}
            <rect
              x={scrubX - 18}
              y={PAD_Y}
              width={36}
              height={VIEW_H - PAD_Y * 2}
              className="payoff-scrub-hit"
            />
            {/* visual line */}
            <line
              x1={scrubX}
              x2={scrubX}
              y1={PAD_Y}
              y2={VIEW_H - PAD_Y}
              stroke="var(--color-fg)"
              strokeWidth="1.5"
            />
            {/* handle dot */}
            <circle
              cx={scrubX}
              cy={zeroY}
              r="5"
              fill="var(--color-fg)"
              stroke="var(--color-bg)"
              strokeWidth="1.5"
            />
          </g>
        </svg>
      </div>

      {/* Readout */}
      <div
        data-testid="payoff-readout"
        className="text-[11px] tnum text-center py-1"
        style={{ color: scrubPL >= 0 ? 'var(--color-hi)' : 'var(--color-red)' }}
      >
        Underlying {fmtUsd(scrubPrice)} · P/L {fmtUsd(scrubPL)}
      </div>

      {/* Stat strip */}
      <div className="flex gap-4 justify-center text-[11px] tnum py-1 border-t border-dashed border-border">
        <span>
          <span className="text-mid">Max Profit </span>
          <span className="text-hi">{maxProfit === null ? '∞' : fmtUsd(maxProfit)}</span>
        </span>
        <span>
          <span className="text-mid">Break-even </span>
          <span className="text-fg">
            {breakevens.length === 0
              ? '—'
              : breakevens.map((b) => fmtUsd(b)).join(' / ')}
          </span>
        </span>
        <span>
          <span className="text-mid">Max Loss </span>
          <span className="text-red">{maxLoss === null ? '−∞' : fmtUsd(maxLoss)}</span>
        </span>
      </div>
    </div>
  );
}
