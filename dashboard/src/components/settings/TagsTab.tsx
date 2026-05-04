import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function TagsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'tags'],
    queryFn: () => api<{ tags: string[] }>('/api/settings/tags'),
  });
  const [draft, setDraft] = useState('');

  const add = useMutation({
    mutationFn: (tag: string) => api('/api/settings/tags', { method: 'POST', body: JSON.stringify({ tag }) }),
    onSuccess: () => { setDraft(''); qc.invalidateQueries({ queryKey: ['settings', 'tags'] }); },
  });
  const del = useMutation({
    mutationFn: (tag: string) => api('/api/settings/tags', { method: 'DELETE', body: JSON.stringify({ tag }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'tags'] }),
  });

  if (isLoading) return <div className="text-mid">loading…</div>;
  const tags = data?.tags ?? [];

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TAGS</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5">
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <span key={t} className="px-2 py-0.5 border border-border bg-panel-2 text-cyan text-[10px] inline-flex items-center gap-1">
              {t}
              <button type="button" onClick={() => del.mutate(t)} className="text-dim hover:text-red" aria-label={`remove ${t}`}>×</button>
            </span>
          ))}
        </div>
        <div className="mt-4 flex gap-2 items-center">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="new tag (a-z, 0-9, _)"
            className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] flex-1 max-w-xs"
          />
          <button type="button" className="pbtn active" onClick={() => add.mutate(draft)} disabled={!draft || add.isPending}>[+ add]</button>
        </div>
        {add.isError && <div className="text-red text-[10px] mt-2">add failed (invalid tag?).</div>}
      </div>
    </article>
  );
}
