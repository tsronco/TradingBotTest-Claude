interface Cell { dow: number; hour: number; trades: number; win_rate: number; }
interface Props { data: Cell[]; }

const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const HOURS = [9, 10, 11, 12, 13, 14, 15];

export default function TimeHeatmap({ data }: Props) {
  const map = new Map<string, Cell>();
  for (const c of data) map.set(`${c.dow}-${c.hour}`, c);

  function classFor(c: Cell | undefined): string {
    if (!c || c.trades === 0) return 'bg-panel-2/30';
    const r = c.win_rate;
    const intensity = Math.abs(r - 0.5) * 2;
    if (r > 0.5) {
      if (intensity > 0.66) return 'bg-hi/50';
      if (intensity > 0.33) return 'bg-hi/30';
      return 'bg-hi/15';
    }
    if (intensity > 0.66) return 'bg-red/50';
    if (intensity > 0.33) return 'bg-red/30';
    return 'bg-red/15';
  }

  return (
    <div>
      <div className="grid gap-1 text-[10px]" style={{ gridTemplateColumns: `auto repeat(${HOURS.length}, 1fr)` }}>
        <div></div>
        {HOURS.map((h) => (
          <div key={h} className="text-center text-dim uppercase tracking-[0.1em]">{h}</div>
        ))}
        {DOWS.map((label, dowIdx) => {
          const dow = dowIdx + 1;
          return (
            <Row key={dow} label={label}>
              {HOURS.map((h) => {
                const c = map.get(`${dow}-${h}`);
                const cls = classFor(c);
                return (
                  <div
                    key={h}
                    className={`aspect-square border border-border rounded-sm relative ${cls}`}
                    title={c ? `${c.trades} trade${c.trades === 1 ? '' : 's'}, ${(c.win_rate * 100).toFixed(0)}% win` : 'no trades'}
                  >
                    {c && c.trades > 0 && (
                      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-fg/85">
                        {c.trades}
                      </div>
                    )}
                  </div>
                );
              })}
            </Row>
          );
        })}
      </div>
      <div className="text-[10px] text-dim mt-2">cell = win rate · number = trade count · all times ET</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="text-dim uppercase tracking-[0.1em] flex items-center pr-1">{label}</div>
      {children}
    </>
  );
}
