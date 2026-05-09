import { useNavigate } from 'react-router-dom';
import { useCheatsheets, useDeleteRule } from '../../hooks/useRules';
import type { Cheatsheet } from '../../lib/rules-types';

export default function CheatsheetsSection() {
  const { data, isLoading } = useCheatsheets();
  const del = useDeleteRule('cheatsheets');
  const nav = useNavigate();
  const items = data?.items ?? [];

  function handleDelete(id: string) {
    if (!confirm('Delete this cheatsheet?')) return;
    del.mutate(id);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-mid text-[11px]">{items.length} cheatsheet{items.length === 1 ? '' : 's'}</div>
        <button onClick={() => nav('/rules/edit?section=cheatsheets')} className="text-cyan text-[11px] hover:underline">[+ add]</button>
      </div>
      {isLoading ? <div className="text-dim text-[11px]">loading…</div> :
        items.length === 0 ? <div className="text-dim text-[11px]">no cheatsheets yet</div> :
        <div className="space-y-2">
          {items.map((c: Cheatsheet) => (
            <details key={c.id} className="border border-border bg-panel-2/30 p-3 rounded-sm text-[11px]">
              <summary className="text-fg font-medium cursor-pointer">{c.title}</summary>
              <div className="mt-2 whitespace-pre-wrap text-fg/85">{c.body}</div>
              <div className="flex gap-3 text-[10px] mt-2">
                <button onClick={() => nav(`/rules/edit?section=cheatsheets&id=${c.id}`)} className="text-cyan hover:underline">[edit]</button>
                <button onClick={() => handleDelete(c.id)} className="text-red hover:underline">[delete]</button>
              </div>
            </details>
          ))}
        </div>
      }
    </div>
  );
}
