import { useParams } from 'react-router-dom';
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

export default function TradeDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useTrade(id);

  if (isLoading) return <div className="p-6 text-mid">loading…</div>;
  if (error || !data) return <div className="p-6 text-red">trade not found.</div>;

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash:~/portfolio/trade$</span>{' '}
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

      {/* footer ribbon per brand guidelines */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>
      <div className="mt-4 text-[12px]">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/trade</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
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
