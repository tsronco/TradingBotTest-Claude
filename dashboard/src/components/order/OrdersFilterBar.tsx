import type { DateRangeKey } from '../../lib/order-filters';
import { DATE_RANGE_OPTIONS } from '../../lib/order-filters';

interface Props {
  symbols: string[];
  symbol: string;
  onSymbolChange: (s: string) => void;
  dateRange: DateRangeKey;
  onDateRangeChange: (r: DateRangeKey) => void;
}

export function OrdersFilterBar({
  symbols,
  symbol,
  onSymbolChange,
  dateRange,
  onDateRangeChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-4 text-[11px]">
      {/* Symbol filter */}
      <label className="flex items-center gap-2 text-dim tracking-[0.15em] uppercase">
        <span>symbol</span>
        <select
          aria-label="filter by symbol"
          value={symbol}
          onChange={(e) => onSymbolChange(e.target.value)}
          className="bg-panel border border-border rounded-sm px-2 py-1 text-fg text-[12px] tnum focus:outline-none focus:border-cyan min-w-[7rem]"
        >
          <option value="">all ({symbols.length})</option>
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {/* Date range — segmented control */}
      <div
        role="radiogroup"
        aria-label="filter by date range (applies to filled orders)"
        className="flex items-center gap-1 border border-border rounded-sm p-0.5 bg-panel"
      >
        {DATE_RANGE_OPTIONS.map((opt) => {
          const active = opt.key === dateRange;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onDateRangeChange(opt.key)}
              className={`px-2.5 py-1 text-[11px] tracking-wider rounded-sm transition-colors ${
                active
                  ? 'bg-cyan/15 text-cyan'
                  : 'text-mid hover:text-fg hover:bg-panel-2/50'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {symbol && (
        <button
          type="button"
          onClick={() => onSymbolChange('')}
          className="text-dim hover:text-amber text-[11px]"
        >
          [clear symbol]
        </button>
      )}
    </div>
  );
}
