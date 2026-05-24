// dashboard/src/components/strategy/PayoffSparkline.tsx
//
// Tiny SVG payoff curve used inside StrategyCard. Same payoff engine as
// the full PayoffChart, but stripped of axes, breakevens, scrubber, and
// readout — just a two-color filled curve that conveys the strategy
// shape at a glance, Robinhood-style.
import { useMemo } from 'react';
import { buildPayoff } from '../../lib/payoff';
import type { Leg } from '../../lib/payoff';

interface Props {
  legs: Leg[];
  currentPrice: number;
  /**
   * Optional pre-computed payoff points. When set, the sparkline renders
   * these directly and skips the leg-based payoff engine — used by
   * calendar-spread cards (see strategy-catalog.calendarTent) whose true
   * P&L curve isn't expressible as expiry-only leg math.
   */
  pointsOverride?: Array<{ price: number; pl: number }>;
}

const VIEW_W = 240;
const VIEW_H = 110;

export default function PayoffSparkline({ legs, currentPrice, pointsOverride }: Props) {
  const result = useMemo(
    () => {
      if (pointsOverride && pointsOverride.length >= 2) {
        const prices = pointsOverride.map((p) => p.price);
        return {
          points: pointsOverride,
          window: { lo: Math.min(...prices), hi: Math.max(...prices) },
        };
      }
      return buildPayoff(legs, currentPrice, 64);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(legs), currentPrice, JSON.stringify(pointsOverride)]
  );

  if (result.points.length < 2) {
    return <div className="w-full h-full bg-panel-2/40" />;
  }

  const { points, window: win } = result;
  const priceRange = win.hi - win.lo || 1;
  const xAt = (p: number) => ((p - win.lo) / priceRange) * VIEW_W;

  const allPLs = points.map((p) => p.pl);
  const minPL = Math.min(...allPLs, 0);
  const maxPL = Math.max(...allPLs, 0);
  const plRange = maxPL - minPL || 1;
  const yAt = (pl: number) => VIEW_H - ((pl - minPL) / plRange) * VIEW_H;
  const zeroY = yAt(0);

  // Build sign-aware polylines for the green (profit) and red (loss) regions
  // by inserting zero-crossings at sign changes (same approach as PayoffChart).
  type Pt = { x: number; y: number };
  const greenPts: Pt[] = [];
  const redPts: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const x = xAt(p.price);
    const y = yAt(p.pl);
    if (p.pl >= 0) greenPts.push({ x, y }); else redPts.push({ x, y });
    if (i + 1 < points.length) {
      const next = points[i + 1];
      if ((p.pl < 0 && next.pl >= 0) || (p.pl >= 0 && next.pl < 0)) {
        const t = p.pl / (p.pl - next.pl);
        const crossPrice = p.price + t * (next.price - p.price);
        const cx = xAt(crossPrice);
        const cy = zeroY;
        if (p.pl < 0) {
          redPts.push({ x: cx, y: cy });
          greenPts.push({ x: cx, y: cy });
        } else {
          greenPts.push({ x: cx, y: cy });
          redPts.push({ x: cx, y: cy });
        }
      }
    }
  }

  function polyPath(pts: Pt[]): string {
    if (pts.length < 2) return '';
    return `M${pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L')}`;
  }

  // Fill polygons under each segment by closing back along the zero axis.
  function fillPath(pts: Pt[]): string {
    if (pts.length < 2) return '';
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return `M${first.x.toFixed(2)},${zeroY.toFixed(2)} L${sorted
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' L')} L${last.x.toFixed(2)},${zeroY.toFixed(2)} Z`;
  }

  // Locate vertex markers (sign changes / kinks) for green and red ends.
  const greenVertex = greenPts.find((p) => p.y !== zeroY);
  const redVertex = redPts.find((p) => p.y !== zeroY);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      className="w-full h-full"
      aria-hidden="true"
    >
      {/* zero axis */}
      <line
        x1={0}
        x2={VIEW_W}
        y1={zeroY}
        y2={zeroY}
        stroke="var(--color-dim)"
        strokeWidth="0.5"
        strokeDasharray="2 3"
      />

      {/* green fill (profit) */}
      {greenPts.length >= 2 && (
        <path d={fillPath(greenPts)} fill="var(--color-hi)" fillOpacity="0.7" />
      )}

      {/* red fill (loss) */}
      {redPts.length >= 2 && (
        <path d={fillPath(redPts)} fill="var(--color-red)" fillOpacity="0.7" />
      )}

      {/* outlines */}
      {greenPts.length >= 2 && (
        <path
          d={polyPath(greenPts)}
          fill="none"
          stroke="var(--color-hi)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {redPts.length >= 2 && (
        <path
          d={polyPath(redPts)}
          fill="none"
          stroke="var(--color-red)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* vertex dots — green (max profit point) + red (max loss point) */}
      {greenVertex && (
        <circle cx={greenVertex.x} cy={greenVertex.y} r="3" fill="var(--color-hi)" stroke="var(--color-bg)" strokeWidth="1" />
      )}
      {redVertex && (
        <circle cx={redVertex.x} cy={redVertex.y} r="3" fill="var(--color-red)" stroke="var(--color-bg)" strokeWidth="1" />
      )}
    </svg>
  );
}
