import { useState } from 'react';
import { fmtUsd } from '../../lib/format';

interface Row { symbol: string; trades: number; wins: number; total_pnl: number; avg_grade: number; }
type SortKey = 'symbol' | 'trades' | 'win_pct' | 'total_pnl' | 'avg_grade';
interface Props { data: Row[]; }

export default function PnLBySymbolTable({ data }: Props) {
  const [sort, setSort] = useState<SortKey>('total_pnl');
  const [dir, setDir] = useState<1 | -1>(-1);

  if (!data.length) return <div className="text-dim text-[11px]">no closed trades yet</div>;

  const sorted = [...data].sort((a, b) => {
    const av = sort === 'win_pct' ? (a.wins / Math.max(1, a.trades)) : (a as unknown as Record<string, number | string>)[sort];
    const bv = sort === 'win_pct' ? (b.wins / Math.max(1, b.trades)) : (b as unknown as Record<string, number | string>)[sort];
    if (typeof av === 'string') return dir * av.localeCompare(bv as string);
    return dir * ((av as number) < (bv as number) ? -1 : (av as number) > (bv as number) ? 1 : 0);
  });

  function header(label: string, key: SortKey) {
    const active = sort === key;
    return (
      <th
        className="text-right px-3 py-2 cursor-pointer select-none uppercase tracking-[0.15em] text-[10px] hover:text-fg"
        onClick={() => {
          if (active) setDir((d) => -d as 1 | -1);
          else { setSort(key); setDir(-1); }
        }}
      >
        {label}{active ? (dir === 1 ? ' ↑' : ' ↓') : ''}
      </th>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] tnum">
        <thead className="text-dim border-b border-border">
          <tr>
            <th
              className="text-left px-3 py-2 cursor-pointer select-none uppercase tracking-[0.15em] text-[10px] hover:text-fg"
              onClick={() => { if (sort === 'symbol') setDir((d) => -d as 1 | -1); else { setSort('symbol'); setDir(1); } }}
            >
              symbol{sort === 'symbol' ? (dir === 1 ? ' ↑' : ' ↓') : ''}
            </th>
            {header('trades', 'trades')}
            {header('win %', 'win_pct')}
            {header('total p&l', 'total_pnl')}
            {header('avg grade', 'avg_grade')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.symbol} className="border-b border-border/50">
              <td className="px-3 py-1.5 text-left font-mono text-cyan">{r.symbol}</td>
              <td className="px-3 py-1.5 text-right text-fg">{r.trades}</td>
              <td className="px-3 py-1.5 text-right text-fg">{((r.wins / Math.max(1, r.trades)) * 100).toFixed(0)}%</td>
              <td className={`px-3 py-1.5 text-right ${r.total_pnl >= 0 ? 'text-hi' : 'text-red'}`}>
                {r.total_pnl >= 0 ? '+' : '-'}{fmtUsd(Math.abs(r.total_pnl))}
              </td>
              <td className="px-3 py-1.5 text-right text-fg">{r.avg_grade.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
