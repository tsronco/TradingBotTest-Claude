import { useNavigate } from 'react-router-dom';
import { usePatterns, useDeleteRule } from '../../hooks/useRules';
import type { Pattern } from '../../lib/rules-types';

export default function PatternsSection() {
  const { data, isLoading } = usePatterns();
  const del = useDeleteRule('patterns');
  const nav = useNavigate();
  const items = data?.items ?? [];

  function handleDelete(id: string) {
    if (!confirm('Delete this pattern?')) return;
    del.mutate(id);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-mid text-[11px]">{items.length} pattern{items.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=patterns')} className="text-cyan text-[11px] hover:underline">[+ add pattern]</button>
      </div>
      {isLoading ? <div className="text-dim text-[11px]">loading…</div> :
        items.length === 0 ? <div className="text-dim text-[11px]">no patterns yet</div> :
        <div className="space-y-2">
          {items.map((p: Pattern) => (
            <div key={p.id} className="border border-border bg-panel-2/30 p-3 space-y-1 rounded-sm text-[11px]">
              <div className="text-fg font-medium">{p.name}</div>
              <div className="text-dim text-[10px]">env: {p.environment}</div>
              {p.win_rate != null && <div className="text-amber">win rate: <span className="tnum">{(p.win_rate * 100).toFixed(0)}%</span></div>}
              {p.legs.length > 0 && <div className="text-mid"><span className="text-fg">legs:</span> {p.legs.join(' · ')}</div>}
              {p.rules.length > 0 && (
                <ul className="text-fg/85 ml-3 mt-1 space-y-0.5">
                  {p.rules.map((r, i) => <li key={i}>· {r}</li>)}
                </ul>
              )}
              <div className="flex gap-3 text-[10px] pt-1">
                <button onClick={() => nav(`/rules/edit?section=patterns&id=${p.id}`)} className="text-cyan hover:underline">[edit]</button>
                <button onClick={() => handleDelete(p.id)} className="text-red hover:underline">[delete]</button>
              </div>
            </div>
          ))}
        </div>
      }
    </div>
  );
}
