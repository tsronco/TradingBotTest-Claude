interface Row { tag: string; trades: number; wins: number; total_pnl: number; }
interface Props { data: Row[]; }

export default function WinRateByTagBar({ data }: Props) {
  if (!data.length) return <div className="text-dim text-[11px]">no tagged trades yet</div>;
  const max = Math.max(...data.map((d) => d.trades));
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const winRate = d.trades > 0 ? d.wins / d.trades : 0;
        return (
          <div key={d.tag}>
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-fg">
                {d.tag}{' '}
                <span className="text-dim">({d.trades})</span>
              </span>
              <span className={`tnum ${d.total_pnl >= 0 ? 'text-hi' : 'text-red'}`}>
                {(winRate * 100).toFixed(0)}% · {d.total_pnl >= 0 ? '+' : '-'}${Math.abs(d.total_pnl).toFixed(0)}
              </span>
            </div>
            <div className="h-2 bg-panel-2 rounded-sm overflow-hidden">
              <div
                className={d.total_pnl >= 0 ? 'h-full bg-hi/60' : 'h-full bg-red/60'}
                style={{ width: `${(d.trades / max) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
