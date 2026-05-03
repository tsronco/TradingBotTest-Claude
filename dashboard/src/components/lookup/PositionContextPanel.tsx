import { useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';

export default function PositionContextPanel({ symbol }: { symbol: string }) {
  const queries = useQueries({
    queries: (['conservative', 'aggressive'] as const).map((mode) => ({
      queryKey: ['positions', mode],
      queryFn: () => api<{ positions: any[] }>(`/api/alpaca/positions?mode=${mode}`),
    })),
  });

  const matches: { mode: string; pos: any }[] = [];
  queries.forEach((q, i) => {
    const mode = (['conservative', 'aggressive'] as const)[i];
    const pos = q.data?.positions?.find((p: any) => p.symbol === symbol);
    if (pos) matches.push({ mode, pos });
  });

  if (queries.some((q) => q.isLoading)) return <div className="text-muted text-xs">Checking…</div>;
  if (matches.length === 0) {
    return <div className="text-muted text-xs">You don't hold {symbol}.</div>;
  }

  return (
    <div>
      {matches.map(({ mode, pos }) => {
        const pl = Number(pos.unrealized_pl);
        const plpc = Number(pos.unrealized_plpc) * 100;
        return (
          <div key={mode} className="mb-3 last:mb-0">
            <div className="text-muted text-[10px] uppercase">{mode}</div>
            <div className="grid grid-cols-2 gap-y-1 text-xs mt-1">
              <span className="text-muted">Qty</span>
              <span className="text-text text-right">{fmtNum(Number(pos.qty))}</span>
              <span className="text-muted">Avg cost</span>
              <span className="text-text text-right">{fmtUsd(Number(pos.avg_entry_price))}</span>
              <span className="text-muted">Unrealized P&L</span>
              <span className={`text-right ${pl >= 0 ? 'text-green' : 'text-red'}`}>
                {fmtUsd(pl, { sign: true })} ({fmtPct(plpc, { sign: true })})
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
