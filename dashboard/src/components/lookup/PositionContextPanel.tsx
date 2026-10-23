import { useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';
import { parseOptionSymbol } from '../../lib/option-symbol';
import { groupPositions, type RawPosition, type PositionGroup } from '../../lib/position-spreads';

type Mode = 'manual' | 'live' | 'agent';
const MODES: readonly Mode[] = ['manual', 'live', 'agent'] as const;

const MODE_ACCENT: Record<Mode, { dot: string; text: string }> = {
  manual: { dot: 'bg-cyan',    text: 'text-cyan' },
  live:   { dot: 'bg-red',     text: 'text-red' },
  agent:  { dot: 'bg-magenta', text: 'text-magenta' },
};

// What one account holds in `symbol`: the stock position (if any) plus any
// option positions whose UNDERLYING is `symbol` (a lone call, a spread, etc.).
interface Holding {
  mode: Mode;
  stock: RawPosition | null;
  optionGroups: PositionGroup[];
}

function money(v: number | null): string {
  if (v == null) return '∞';
  return `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
}

export default function PositionContextPanel({ symbol }: { symbol: string }) {
  const queries = useQueries({
    queries: MODES.map((mode) => ({
      queryKey: ['positions', mode],
      queryFn: () => api<{ positions: RawPosition[] }>(`/api/alpaca/positions?mode=${mode}`),
    })),
  });

  const holdings: Holding[] = [];
  queries.forEach((q, i) => {
    const mode = MODES[i];
    const positions = q.data?.positions ?? [];
    // Stock leg: a non-option position named exactly `symbol`.
    const stock = positions.find(
      (p) => p.asset_class !== 'us_option' && p.symbol === symbol,
    ) ?? null;
    // Option legs: any option position whose OCC underlying is `symbol`. These
    // were previously missed — the old panel only matched an exact-symbol stock
    // position, so a spread or lone call on the name read as "you don't hold it."
    const optionPositions = positions.filter(
      (p) => p.asset_class === 'us_option' && parseOptionSymbol(p.symbol)?.underlying === symbol,
    );
    if (stock || optionPositions.length > 0) {
      holdings.push({ mode, stock, optionGroups: groupPositions(optionPositions) });
    }
  });

  if (queries.some((q) => q.isLoading)) return <div className="text-dim text-[11px]">checking…</div>;
  if (holdings.length === 0) {
    return <div className="text-dim text-[11px]">you don&apos;t hold {symbol}.</div>;
  }

  return (
    <div>
      {holdings.map(({ mode, stock, optionGroups }) => {
        const accent = MODE_ACCENT[mode];
        return (
          <div key={mode} className="mb-3 last:mb-0">
            <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] text-dim uppercase mb-1.5">
              <span className={`w-1.5 h-1.5 rounded-sm ${accent.dot}`} />
              <span className={accent.text}>{mode}</span>
            </div>

            {stock && <StockRow pos={stock} />}

            {optionGroups.length > 0 && (
              <div className={`space-y-1.5 ${stock ? 'mt-2' : ''}`}>
                {optionGroups.map((g) =>
                  g.kind === 'spread'
                    ? <SpreadRow key={`s-${g.long.symbol}`} group={g} />
                    : <OptionLegRow key={g.pos.symbol} pos={g.pos} />,
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StockRow({ pos }: { pos: RawPosition }) {
  const pl = Number(pos.unrealized_pl);
  const plpc = Number(pos.unrealized_plpc) * 100;
  return (
    <div className="grid grid-cols-2 gap-y-1 text-[11px] tnum">
      <span className="text-dim tracking-[0.15em] uppercase text-[10px]">qty</span>
      <span className="text-fg text-right">{fmtNum(Number(pos.qty))}</span>
      <span className="text-dim tracking-[0.15em] uppercase text-[10px]">avg cost</span>
      <span className="text-fg text-right">{fmtUsd(Number(pos.avg_entry_price))}</span>
      <span className="text-dim tracking-[0.15em] uppercase text-[10px]">unrealized P/L</span>
      <span className={`text-right ${pl >= 0 ? 'text-hi' : 'text-red'}`}>
        {pl >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(pl), { sign: false }).replace('-$', '$')}{' '}
        <span className="text-dim">({fmtPct(plpc, { sign: true }).replace('-', '−')})</span>
      </span>
    </div>
  );
}

// A detected vertical spread on this underlying — strategy name + defined-risk
// numbers, matching the Positions screen so the two panels agree.
function SpreadRow({ group }: { group: Extract<PositionGroup, { kind: 'spread' }> }) {
  const m = group.metrics;
  const lo = Math.min(m.longStrike, m.shortStrike);
  const hi = Math.max(m.longStrike, m.shortStrike);
  return (
    <div className="border border-border bg-panel-2/30 rounded-sm px-2 py-1.5 text-[11px] tnum">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-fg font-medium">{m.name}</span>
        <span className={m.groupPL >= 0 ? 'text-hi' : 'text-red'}>
          {m.groupPL >= 0 ? '▲' : '▼'} {money(Math.abs(m.groupPL))}
        </span>
      </div>
      <div className="text-dim text-[10px] mt-0.5">
        {lo}/{hi} {m.optionType.toUpperCase()}{m.contracts > 1 && ` ×${m.contracts}`}
        <span className="mx-1">·</span>
        {m.isDebit ? 'debit' : 'credit'} {money(Math.abs(m.netCost))}
        <span className="mx-1">·</span>
        max loss <span className="text-red">{money(m.maxLoss)}</span>
      </div>
    </div>
  );
}

// A single option leg (lone long call, naked short, orphaned spread leg).
function OptionLegRow({ pos }: { pos: RawPosition }) {
  const parsed = parseOptionSymbol(pos.symbol);
  const qty = Number(pos.qty);
  const isLong = qty > 0;
  const pl = Number(pos.unrealized_pl);
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] tnum">
      <span className="min-w-0 truncate">
        <span
          className={`inline-block mr-1.5 px-1 py-0.5 rounded-sm text-[8px] font-bold tracking-[0.12em] leading-none align-middle ${
            isLong ? 'bg-hi/15 text-hi' : 'bg-red/15 text-red'
          }`}
        >
          {isLong ? 'LONG' : 'SHORT'}
        </span>
        {parsed ? (
          <span className="text-fg">{parsed.type.toUpperCase()} ${parsed.strike}</span>
        ) : (
          <span className="text-fg">{pos.symbol}</span>
        )}
      </span>
      <span className={pl >= 0 ? 'text-hi' : 'text-red'}>
        {pl >= 0 ? '▲' : '▼'} {money(Math.abs(pl))}
      </span>
    </div>
  );
}
