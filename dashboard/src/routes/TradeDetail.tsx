import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTrade } from '../hooks/useTrade';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { TradeHeader } from '../components/trade/TradeHeader';
import { SpreadMetadata } from '../components/trade/SpreadMetadata';
import { TradeChart } from '../components/trade/TradeChart';
import { Timeline } from '../components/trade/Timeline';
import { GradePanel } from '../components/trade/GradePanel';
import { RuleViolationsPanel } from '../components/trade/RuleViolationsPanel';
import AssignmentLink from '../components/trade/AssignmentLink';
import { api } from '../lib/api';
import type { Trade } from '../lib/trade-types';
import { useDisplayName } from '../hooks/useDisplayName';

export default function TradeDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useTrade(id);
  const { handle } = useDisplayName();

  if (isLoading) return <div className="p-3 md:p-6 text-mid">loading…</div>;
  if (error || !data) return <div className="p-3 md:p-6 text-red">trade not found.</div>;

  return (
    <div className="p-3 md:p-6 max-w-5xl space-y-4">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">{handle}@dash:~/portfolio/trade$</span>{' '}
        <span className="text-fg">show --id={id}</span>
      </div>
      {data.trade.parent_id && data.trade.source === 'assignment' && (
        <AssignmentLink
          direction="up"
          tradeId={data.trade.parent_id}
          inherited={data.trade.ai_grade_inherited}
        />
      )}
      {data.assignment_child_id && (
        <AssignmentLink
          direction="down"
          tradeId={data.assignment_child_id}
        />
      )}
      <TradeHeader trade={data.trade} />
      <ErrorBoundary><SpreadMetadata trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><TradeChart trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><Timeline trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><RuleViolationsPanel trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><GradePanel trade={data.trade} grade={data.grade} /></ErrorBoundary>
      <ErrorBoundary><TagsJournal trade={data.trade} /></ErrorBoundary>
      <ErrorBoundary><DeletePanel trade={data.trade} /></ErrorBoundary>

      {/* footer ribbon per brand guidelines */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>
      <div className="mt-4 text-[12px]">
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/trade</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}

/**
 * Danger zone — permanently delete this trade record. Used to clean up
 * duplicates / bad imports. Two-step (arm → confirm) so a stray tap can't
 * nuke a record. On success, navigates back to /trades.
 */
function DeletePanel({ trade }: { trade: Trade }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: () => api(`/api/trades/delete?id=${trade.id}`, { method: 'POST', body: JSON.stringify({ id: trade.id }) }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['trades'] });
      navigate('/trades');
    },
    onError: (e: Error) => { setError(e.message ?? 'delete failed.'); setArmed(false); },
  });

  return (
    <article className="relative border border-red/40 bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-red">DANGER</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4 flex flex-col gap-2">
        <div className="text-mid text-[10px]">
          permanently delete this trade record — removes it from P&amp;L, win-rate, and
          calibration. Use for duplicates / bad imports. This does NOT touch Alpaca.
        </div>
        <div className="flex items-center gap-3">
          {!armed ? (
            <button
              type="button"
              className="px-3 py-1.5 border border-red/40 text-red text-[11px] rounded-sm tracking-wider hover:bg-red/5"
              onClick={() => setArmed(true)}
            >[delete trade]</button>
          ) : (
            <>
              <span className="text-red text-[10px]">delete {trade.id}? this can't be undone.</span>
              <button
                type="button"
                className="px-3 py-1.5 border border-red text-red text-[11px] rounded-sm tracking-wider hover:bg-red/10 disabled:opacity-50"
                onClick={() => del.mutate()}
                disabled={del.isPending}
              >[{del.isPending ? 'deleting…' : 'confirm delete'}]</button>
              <button
                type="button"
                className="px-3 py-1.5 border border-border text-dim text-[11px] rounded-sm tracking-wider hover:bg-hi/5"
                onClick={() => setArmed(false)}
                disabled={del.isPending}
              >[cancel]</button>
            </>
          )}
          {error && <span className="text-red text-[10px]">error: {error}</span>}
        </div>
      </div>
    </article>
  );
}

function TagsJournal({ trade }: { trade: Trade }) {
  const qc = useQueryClient();
  const [journal, setJournal] = useState(trade.journal ?? '');
  const save = useMutation({
    mutationFn: (j: string) => api(`/api/trades/update?id=${trade.id}`, { method: 'POST', body: JSON.stringify({ journal: j }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trade', trade.id] }),
  });

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">TAGS · JOURNAL</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4">
        <div className="flex flex-wrap gap-1 mb-3">
          {(trade.tags ?? []).map((t: string) => (
            <span key={t} className="px-2 py-0.5 border border-hi text-hi text-[10px]">{t}</span>
          ))}
          {(!trade.tags || trade.tags.length === 0) && <span className="text-dim text-[10px]">— no tags —</span>}
        </div>
        <div className="text-mid text-[10px] mt-2">journal <span className="text-dim">(optional)</span></div>
        <textarea
          rows={3}
          className="w-full bg-panel-2 border border-border px-2 py-1 text-fg text-[10px] mt-1"
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
          onBlur={() => journal !== trade.journal && save.mutate(journal)}
        />
      </div>
    </article>
  );
}
