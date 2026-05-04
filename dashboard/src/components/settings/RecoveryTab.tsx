import { useState } from 'react';
import { api } from '../../lib/api';

export function RecoveryTab() {
  const [totp, setTotp] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function regenerate() {
    setError(null); setPending(true);
    try {
      const res = await api<{ codes: string[] }>('/api/settings/backup-codes', {
        method: 'POST',
        body: JSON.stringify({ totp_code: totp }),
      });
      setCodes(res.codes);
      setTotp('');
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err.message ?? 'regenerate failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">BACKUP CODES</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-5 text-[12px]">
        <div className="text-mid text-[10px] mb-3">
          rotating invalidates all previous codes. you must save the new set somewhere durable before closing this tab.
        </div>
        {codes ? (
          <div>
            <div className="text-amber text-[10px] mb-2">// new codes — saved nowhere on the server. copy now.</div>
            <pre className="border border-border bg-panel-2 p-3 text-fg text-[12px] tnum">{codes.join('\n')}</pre>
            <button type="button" className="pbtn active mt-3" onClick={() => setCodes(null)}>[i&apos;ve saved them]</button>
          </div>
        ) : (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              inputMode="numeric"
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="totp code"
              className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[14px] tnum tracking-[0.4em] w-32 text-center"
            />
            <button type="button" className="pbtn active" disabled={totp.length !== 6 || pending} onClick={regenerate}>
              [{pending ? 'regenerating…' : 'regenerate*'}]
            </button>
          </div>
        )}
        {error && <div className="text-red text-[10px] mt-2">{error}</div>}
      </div>
    </article>
  );
}
