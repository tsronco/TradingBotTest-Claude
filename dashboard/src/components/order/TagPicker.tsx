// dashboard/src/components/order/TagPicker.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function TagPicker({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['settings', 'tags'],
    queryFn: () => api<{ tags: string[] }>('/api/settings/tags'),
  });
  const [draft, setDraft] = useState('');
  const tags = data?.tags ?? [];

  const add = useMutation({
    mutationFn: (t: string) => api('/api/settings/tags', { method: 'POST', body: JSON.stringify({ tag: t }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'tags'] }),
  });

  function toggle(t: string) {
    if (value.includes(t)) onChange(value.filter((v) => v !== t));
    else onChange([...value, t]);
  }

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => toggle(t)}
          className={`px-2 py-0.5 border text-[10px] ${
            value.includes(t) ? 'border-hi text-hi bg-hi/5' : 'border-border text-cyan bg-panel-2'
          }`}
        >
          {t}
        </button>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="+ add"
        className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[10px] w-24"
      />
      <button
        type="button"
        disabled={!draft}
        onClick={() => { add.mutate(draft, { onSuccess: () => { onChange([...value, draft]); setDraft(''); } }); }}
        className="pbtn"
      >
        [add]
      </button>
    </div>
  );
}
