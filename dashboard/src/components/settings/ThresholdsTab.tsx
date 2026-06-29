import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Thresholds {
  manual_paper: number;
  live: number;
}

const DEFAULT_FORM: Thresholds = {
  manual_paper: 2500,
  live: 1500,
};

export function ThresholdsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'thresholds'],
    queryFn: () => api<{ thresholds: Thresholds }>('/api/settings/thresholds'),
  });
  const [form, setForm] = useState<Thresholds>(DEFAULT_FORM);
  useEffect(() => { if (data?.thresholds) setForm(data.thresholds); }, [data]);

  const save = useMutation({
    mutationFn: (body: Thresholds) => api('/api/settings/thresholds', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'thresholds'] }),
  });

  if (isLoading) return <div className="text-mid">loading…</div>;

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TOTP THRESHOLDS</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5 text-[12px] tnum">
        <div className="text-mid text-[10px] mb-3">orders at or above this $ exposure require a fresh totp code.</div>
        {(
          ['manual_paper', 'live'] as const
        ).map((k) => (
          <div key={k} className="flex justify-between py-1 border-b border-dashed border-border">
            <span className="text-mid">
              {k}
              {k === 'live' ? <span className="text-dim"> (LIVE_ENABLED=false)</span> : null}
            </span>
            <input
              type="number"
              min={0}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
              className="w-24 text-right bg-panel-2 border border-border px-2 py-0.5 text-fg"
            />
          </div>
        ))}
        <button
          type="button"
          className="pbtn active mt-4"
          onClick={() => save.mutate(form)}
          disabled={save.isPending}
        >
          [{save.isPending ? 'saving…' : 'save*'}]
        </button>
        {save.isError && <div className="text-red text-[10px] mt-2">save failed.</div>}
      </div>
    </article>
  );
}
