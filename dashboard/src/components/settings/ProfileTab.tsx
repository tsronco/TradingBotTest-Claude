import { useEffect, useState } from 'react';
import { DEFAULT_DISPLAY_NAME, useDisplayName, useSaveDisplayName } from '../../hooks/useDisplayName';

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,23}$/;

export function ProfileTab() {
  const { name, isLoading } = useDisplayName();
  const save = useSaveDisplayName();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading) setDraft(name);
  }, [name, isLoading]);

  function onSave() {
    setError(null);
    const trimmed = draft.trim();
    if (!NAME_PATTERN.test(trimmed)) {
      setError('1–24 chars, must start with a letter, only letters/digits/space/_/- allowed.');
      return;
    }
    save.mutate(trimmed, {
      onError: (e: unknown) => {
        const err = e as { message?: string };
        setError(err.message ?? 'save failed.');
      },
    });
  }

  const dirty = draft.trim() !== name;
  const handle = (draft.trim() || DEFAULT_DISPLAY_NAME).toLowerCase().replace(/[^a-z0-9]+/g, '');

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">DISPLAY NAME</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5 text-[12px] space-y-3">
        <div className="text-mid text-[10px] leading-relaxed">
          shown in the terminal prompts, the sidebar logo, and injected into the AI coach's grading prompt
          so it addresses you by name. default is <span className="text-fg">"{DEFAULT_DISPLAY_NAME}"</span>.
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={DEFAULT_DISPLAY_NAME}
            maxLength={24}
            className="bg-panel-2 border border-border px-2 py-1 text-fg text-[13px] w-48"
          />
          <button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={onSave}
            className={`pbtn ${dirty ? 'active' : ''}`}
          >
            [{save.isPending ? 'saving…' : 'save'}]
          </button>
          {save.isSuccess && !dirty && (
            <span className="text-cyan text-[10px]">saved ✓</span>
          )}
        </div>

        <div className="text-dim text-[10px] tnum">
          preview: <span className="text-cyan">{handle}@dash</span>
          <span className="text-dim">:</span>
          <span className="text-cyan">~/portfolio</span>
          <span className="text-dim">$</span>
        </div>

        {error && <div className="text-red text-[10px]">{error}</div>}
      </div>
    </article>
  );
}
