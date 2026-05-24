// dashboard/src/components/strategy/StrategyCard.tsx
import type { StrategyDef } from '../../lib/strategy-catalog';
import PayoffSparkline from './PayoffSparkline';

interface Props {
  strategy: StrategyDef;
  spot: number;
  onClick: () => void;
}

const DIRECTION_COLOR: Record<StrategyDef['direction'], string> = {
  Bullish: 'text-hi',
  Bearish: 'text-red',
  Neutral: 'text-mid',
  Volatile: 'text-magenta',
};

export default function StrategyCard({ strategy, spot, onClick }: Props) {
  const disabled = strategy.status === 'coming_soon';
  const effectiveSpot = spot > 0 ? spot : 100;
  const legs = strategy.sampleLegs(effectiveSpot);
  const pointsOverride = strategy.previewPoints?.(effectiveSpot);

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-strategy-id={strategy.id}
      data-status={strategy.status}
      aria-disabled={disabled}
      className={`relative w-full text-left border border-border bg-panel/60 rounded-sm overflow-hidden transition-colors ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:border-hi/60 hover:bg-panel-2/60 cursor-pointer'
      }`}
    >
      <div className="h-[110px] w-full bg-panel-2/40">
        <PayoffSparkline legs={legs} currentPrice={effectiveSpot} pointsOverride={pointsOverride} />
      </div>
      <div className="p-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-fg text-[13px] font-semibold leading-tight">{strategy.name}</div>
          {disabled && (
            <span className="text-amber text-[9px] tracking-[0.2em] uppercase">soon</span>
          )}
        </div>
        <div className={`text-[10px] ${DIRECTION_COLOR[strategy.direction]} mt-0.5`}>
          {strategy.direction}
        </div>
        <div className="text-dim text-[10px] mt-1 leading-snug line-clamp-2">
          {strategy.blurb}
        </div>
      </div>
    </button>
  );
}
