import { useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';

interface Pos {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

type Mode = 'manual' | 'live';
const MODES: readonly Mode[] = ['manual', 'live'] as const;

const MODE_ACCENT: Record<Mode, { dot: string; text: string }> = {
  manual: { dot: 'bg-cyan', text: 'text-cyan' },
  live:   { dot: 'bg-red',  text: 'text-red' },
};

export default function PositionContextPanel({ symbol }: { symbol: string }) {
  const queries = useQueries({
    queries: MODES.map((mode) => ({
      queryKey: ['positions', mode],
      queryFn: () => api<{ positions: Pos[] }>(`/api/alpaca/positions?mode=${mode}`),
    })),
  });

  const matches: { mode: Mode; pos: Pos }[] = [];
  queries.forEach((q, i) => {
    const mode = MODES[i];
    const pos = q.data?.positions?.find((p) => p.symbol === symbol);
    if (pos) matches.push({ mode, pos });
  });

  if (queries.some((q) => q.isLoading)) return <div className="text-dim text-[11px]">checking…</div>;
  if (matches.length === 0) {
    return <div className="text-dim text-[11px]">you don&apos;t hold {symbol}.</div>;
  }

  return (
    <div>
      {matches.map(({ mode, pos }) => {
        const pl = Number(pos.unrealized_pl);
        const plpc = Number(pos.unrealized_plpc) * 100;
        const accent = MODE_ACCENT[mode];
        return (
          <div key={mode} className="mb-3 last:mb-0">
            <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] text-dim uppercase mb-1.5">
              <span className={`w-1.5 h-1.5 rounded-sm ${accent.dot}`} />
              <span className={accent.text}>{mode}</span>
            </div>
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
          </div>
        );
      })}
    </div>
  );
}
