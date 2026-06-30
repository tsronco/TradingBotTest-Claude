import { useState } from 'react';
import { api, ApiError } from '../../lib/api';

type Account = 'manual_paper' | 'live';

interface ImportSummary {
  imported: number;
  skipped_existing: number;
  spread_pairs_found: number;
  errors: string[];
  created_trade_ids: string[];
}

function defaultSince(): string {
  const d = new Date(Date.now() - 30 * 86400000);
  return d.toISOString().slice(0, 10);
}

export function ImportTab() {
  const [account, setAccount] = useState<Account>('manual_paper');
  const [since, setSince] = useState(defaultSince());
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runImport() {
    setError(null);
    setSummary(null);
    setPending(true);
    try {
      const res = await api<{ imported: ImportSummary }>('/api/trades/import', {
        method: 'POST',
        body: JSON.stringify({ account, since: new Date(since).toISOString() }),
      });
      setSummary(res.imported);
    } catch (e: unknown) {
      const err = e as ApiError;
      setError(err.message ?? 'import failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">IMPORT FROM ALPACA</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-5 text-[12px]">
        <div className="text-mid text-[10px] mb-3">
          one-shot backfill of dashboard trade records from raw alpaca fills (positions opened
          outside the dashboard — e.g. on alpaca&apos;s web UI, or by the bot before the
          external-close detection was wired up). only creates records for OPENS; closes
          flow in automatically via the next cron tick.
        </div>
        <div className="flex flex-col md:flex-row gap-2 md:gap-4 mb-3 items-start md:items-end">
          <label className="flex flex-col gap-1">
            <span className="text-dim text-[10px] tracking-[0.2em]">ACCOUNT</span>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value as Account)}
              className="bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
            >
              <option value="manual_paper">manual (paper)</option>
              <option value="live">live (real money)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-dim text-[10px] tracking-[0.2em]">SINCE</span>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
            />
          </label>
          <button
            type="button"
            className="pbtn active"
            onClick={runImport}
            disabled={pending || !account || !since}
          >
            [{pending ? 'importing…' : 'import'}]
          </button>
        </div>
        {error && <div className="text-red text-[10px] mt-2">error: {error}</div>}
        {summary && (
          <div className="mt-3 text-[11px] border border-border bg-panel-2 p-3">
            <div className="text-hi text-[10px] tracking-[0.2em] mb-2">// IMPORT RESULT</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 tnum">
              <span className="text-mid">imported</span>
              <span className="text-fg">{summary.imported}</span>
              <span className="text-mid">skipped (already exist)</span>
              <span className="text-fg">{summary.skipped_existing}</span>
              <span className="text-mid">spread pairs found</span>
              <span className="text-fg">{summary.spread_pairs_found}</span>
              <span className="text-mid">errors</span>
              <span className="text-fg">{summary.errors.length}</span>
            </div>
            {summary.errors.length > 0 && (
              <div className="mt-3">
                <div className="text-amber text-[10px] mb-1">// errors</div>
                <pre className="text-red text-[10px] whitespace-pre-wrap">{summary.errors.join('\n')}</pre>
              </div>
            )}
            {summary.created_trade_ids.length > 0 && (
              <div className="mt-3">
                <div className="text-dim text-[10px] mb-1">// new trade ids</div>
                <div className="text-cyan text-[10px] tnum">{summary.created_trade_ids.join(', ')}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
