interface DayBucket {
  realized_pnl: number;
  trade_count: number;
  closed_trade_ids: string[];
  open_options_expiring: Array<{ trade_id: string; symbol: string; option_type: 'put' | 'call'; strike: number }>;
}

interface Props {
  year: number;
  month: number;     // 1-12
  days: Record<string, DayBucket>;
  monthTotal: number;
  onDayClick: (date: string) => void;
}

export default function MonthGrid({ year, month, days, monthTotal, onDayClick }: Props) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  const startDay = first.getUTCDay();              // Sun = 0

  const cells: Array<{ date: string; day: number } | null> = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= last.getUTCDate(); d++) {
    cells.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      day: d,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const maxAbs = Math.max(0.01, ...Object.values(days).map((d) => Math.abs(d.realized_pnl)));

  function pnlClass(pnl: number): string {
    if (pnl === 0) return 'bg-panel-2/30';
    const intensity = Math.min(1, Math.abs(pnl) / maxAbs);
    if (pnl > 0) {
      return intensity < 0.33 ? 'bg-hi/10' : intensity < 0.66 ? 'bg-hi/25' : 'bg-hi/40';
    }
    return intensity < 0.33 ? 'bg-red/10' : intensity < 0.66 ? 'bg-red/25' : 'bg-red/40';
  }

  return (
    <div>
      <div className="flex items-center justify-end mb-2 text-[11px]">
        <span className="text-dim mr-2">month total</span>
        <span className={`tnum font-semibold ${monthTotal >= 0 ? 'text-hi' : 'text-red'}`}>
          {monthTotal >= 0 ? '+' : '-'}${Math.abs(monthTotal).toFixed(2)}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] text-dim mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="text-center uppercase tracking-[0.15em]">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`pad-${i}`} className="aspect-square" />;
          const info = days[cell.date];
          const pnl = info?.realized_pnl ?? 0;
          const expiring = info?.open_options_expiring ?? [];
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => onDayClick(cell.date)}
              title={info ? `${info.trade_count} trade${info.trade_count === 1 ? '' : 's'}, ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}` : ''}
              className={`aspect-square border border-border rounded-sm p-1 max-md:p-0.5 hover:border-cyan transition-colors relative ${pnlClass(pnl)}`}
            >
              <div className="absolute top-1 left-1.5 max-md:top-0.5 max-md:left-1 text-[10px] max-md:text-[8px] text-fg/80">{cell.day}</div>
              {pnl !== 0 && (
                <>
                  {/* Desktop: dollar amount. Mobile (max-md): colored heat dot — detail still in day-drawer on tap. */}
                  <div className={`absolute bottom-1 right-1.5 text-[10px] tnum ${pnl >= 0 ? 'text-hi' : 'text-red'} max-md:hidden`}>
                    {pnl >= 0 ? '+' : '-'}$
                    {Math.abs(pnl) >= 1000 ? `${(Math.abs(pnl) / 1000).toFixed(1)}k` : Math.abs(pnl).toFixed(0)}
                  </div>
                  <div className={`absolute bottom-1 right-1 text-[10px] hidden max-md:block ${pnl >= 0 ? 'text-hi' : 'text-red'}`}>●</div>
                </>
              )}
              {expiring.length > 0 && (
                <div className="absolute top-1 right-1.5 max-md:top-0.5 max-md:right-1 text-[9px] max-md:text-[7px] text-cyan">
                  ○ {expiring.length}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
