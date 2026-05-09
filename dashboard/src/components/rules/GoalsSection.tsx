import { useNavigate } from 'react-router-dom';
import { useGoals, useDeleteRule } from '../../hooks/useRules';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Goal } from '../../lib/rules-types';

export default function GoalsSection() {
  const { data, isLoading } = useGoals();
  const del = useDeleteRule('goals');
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ id, checked }: { id: string; checked: boolean }) =>
      api('/api/rules/goals', {
        method: 'PATCH',
        body: JSON.stringify({ id, patch: { checked } }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', 'goals'] }),
  });
  const nav = useNavigate();
  const items = data?.items ?? [];

  function handleDelete(id: string) {
    if (!confirm('Delete this goal?')) return;
    del.mutate(id);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-mid text-[11px]">{items.length} goal{items.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=goals')} className="text-cyan text-[11px] hover:underline">[+ add goal]</button>
      </div>
      {isLoading ? <div className="text-dim text-[11px]">loading…</div> :
        <ul className="space-y-1">
          {items.map((g: Goal) => (
            <li key={g.id} className="flex items-start gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={!!g.checked}
                onChange={(e) => toggle.mutate({ id: g.id, checked: e.target.checked })}
                className="mt-1"
              />
              <div className="flex-1">
                <div className={g.checked ? 'line-through text-dim' : 'text-fg'}>{g.body}</div>
                {(g.target || g.due) && (
                  <div className="text-[10px] text-dim space-x-3">
                    {g.target && <span>target: <span className="text-mid">{g.target}</span></span>}
                    {g.due && <span>due: <span className="text-mid">{g.due}</span></span>}
                  </div>
                )}
              </div>
              <button onClick={() => nav(`/rules/edit?section=goals&id=${g.id}`)} className="text-cyan text-[10px] hover:underline">[edit]</button>
              <button onClick={() => handleDelete(g.id)} className="text-red text-[10px] hover:underline">[×]</button>
            </li>
          ))}
        </ul>
      }
    </div>
  );
}
