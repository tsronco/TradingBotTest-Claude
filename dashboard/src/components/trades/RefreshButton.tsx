import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface RefreshResult {
  ok: true;
  graded: number;
  synced: number;
  remaining_open: number;
  assignments_spawned: number;
  assignments_skipped: number;
}

const COOLDOWN_SECONDS = 15;

export default function RefreshButton() {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [lastResult, setLastResult] = useState<RefreshResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Countdown tick — only runs when cooldown is active. Cleared on unmount
  // and on each value change (the effect re-subscribes), so no leak.
  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const id = setTimeout(() => setCooldownLeft((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldownLeft]);

  const handleClick = useCallback(async () => {
    if (loading || cooldownLeft > 0) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<RefreshResult>('/api/trades/refresh', { method: 'POST' });
      setLastResult(data);
      setCooldownLeft(COOLDOWN_SECONDS);
      // Invalidate trades-list queries so the table re-fetches with the
      // freshly closed trades visible.
      await qc.invalidateQueries({ queryKey: ['trades'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'refresh failed');
    } finally {
      setLoading(false);
    }
  }, [loading, cooldownLeft, qc]);

  const disabled = loading || cooldownLeft > 0;

  return (
    <div className="flex items-center gap-3 text-[11px]">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`px-3 py-1.5 border rounded-sm tracking-wider transition-colors ${
          disabled
            ? 'border-border text-dim cursor-not-allowed'
            : 'border-hi/40 text-hi hover:bg-hi/5'
        }`}
        title={
          cooldownLeft > 0
            ? `wait ${cooldownLeft}s before refreshing again`
            : 'force-sync against Alpaca state (detects bot closes, syncs fills, AI grades)'
        }
      >
        {loading ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 bg-hi rounded-sm animate-pulse" />
            syncing…
          </span>
        ) : cooldownLeft > 0 ? (
          <>[refresh · {cooldownLeft}s]</>
        ) : (
          <>[↻ refresh]</>
        )}
      </button>

      {/* Inline result strip — collapses when there's nothing to show */}
      {error && (
        <span className="text-red text-[10px]">error: {error}</span>
      )}
      {!error && lastResult && (
        <ResultSummary result={lastResult} />
      )}
    </div>
  );
}

function ResultSummary({ result }: { result: RefreshResult }) {
  const parts: string[] = [];
  if (result.synced > 0) parts.push(`${result.synced} synced`);
  if (result.graded > 0) parts.push(`${result.graded} closed`);
  if (result.assignments_spawned > 0) parts.push(`${result.assignments_spawned} assigned`);

  if (parts.length === 0) {
    return (
      <span className="text-dim text-[10px]">
        nothing to update · {result.remaining_open} open
      </span>
    );
  }

  return (
    <span className="text-mid text-[10px]">
      {parts.join(' · ')} · {result.remaining_open} still open
    </span>
  );
}
