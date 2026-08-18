// The agent's own reasoning for a trade, shown on the trade detail page.
//
// This is the thing that makes the agent account worth having: not the P&L,
// but a falsifiable statement written BEFORE the outcome was known, and a
// self-grade written after. Rendered read-only and verbatim — it is a record,
// not a live view.

import { useAgentState } from '../../hooks/useBotState';
import { linkAgentRecord, confidenceStars } from '../../lib/agent-trade-link';
import { fmtUsd } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';

export function AgentThesisPanel({ trade }: { trade: Trade }) {
  const isAgent = trade.account === 'agent_paper';
  // Hook order must not depend on the account, so the query is always declared
  // and simply ignored for other accounts.
  const stateQ = useAgentState();
  if (!isAgent) return null;

  const link = linkAgentRecord(stateQ.data?.payload, trade);

  if (!link) {
    return (
      <Panel>
        <div className="text-mid text-[11px] leading-relaxed">
          {stateQ.isLoading
            ? 'loading the agent’s record…'
            : 'No matching entry in the agent’s record for these legs. That happens '
              + 'when a position was closed and graded before the dashboard imported it, '
              + 'or when the agent state has not been pushed since the trade opened.'}
        </div>
      </Panel>
    );
  }

  const t = link.thesis;
  const g = link.grade;
  const stars = confidenceStars(t?.confidence);

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
        <span className="text-[10px] tracking-[0.2em] uppercase text-dim">at entry</span>
        {stars && (
          <span className="text-amber text-[11px]" title={`self-rated confidence ${t?.confidence} of 5`}>
            {stars} <span className="text-dim">confidence {t?.confidence}/5</span>
          </span>
        )}
        <span className="ml-auto text-[10px] text-dim">
          {link.kind === 'open' ? 'still held' : 'closed'}
        </span>
      </div>

      {t ? (
        <div className="flex flex-col gap-2 text-[11px] leading-relaxed">
          <Field label="thesis" value={t.thesis} />
          <Field label="getting paid" value={t.getting_paid} />
          <Field label="key risk" value={t.key_risk} tone="amber" />
          <Field label="invalidation" value={t.invalidation} tone="red" />
          <Field label="rejected alternatives" value={t.rejected} tone="dim" />
        </div>
      ) : (
        <div className="text-dim text-[11px]">no thesis recorded for this entry.</div>
      )}

      {link.kind === 'closed' && (
        <div className="mt-4 pt-3 border-t border-dashed border-border">
          <div className="text-[10px] tracking-[0.2em] uppercase text-dim mb-2">on close</div>
          {/* Process and outcome are graded separately on purpose — a sound
              decision can lose, and a sloppy one can win. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] mb-2">
            <span>
              <span className="text-dim">process </span>
              <span className="text-fg font-bold">{g?.process_grade ?? '—'}</span>
            </span>
            <span>
              <span className="text-dim">outcome </span>
              <span className="text-fg font-bold">{g?.outcome_grade ?? '—'}</span>
            </span>
            {typeof link.outcome?.estimated_pnl === 'number' && (
              <span className={link.outcome.estimated_pnl >= 0 ? 'text-hi' : 'text-red'}>
                {fmtUsd(link.outcome.estimated_pnl, { sign: true })}
              </span>
            )}
            {typeof link.outcome?.days_held === 'number' && (
              <span className="text-dim">{link.outcome.days_held.toFixed(1)}d held</span>
            )}
            {g?.loss_type && (
              <span className={`text-[9px] border rounded-sm px-1 py-0.5 ${
                g.loss_type === 'blind_spot' ? 'text-red border-red/40' : 'text-amber border-amber/40'
              }`}>
                {g.loss_type === 'blind_spot' ? 'BLIND SPOT' : 'ANTICIPATED'}
              </span>
            )}
          </div>
          {g?.lesson && (
            <div className="text-[11px] leading-relaxed">
              <span className="text-magenta text-[10px] tracking-[0.2em] uppercase">lesson </span>
              <span className="text-fg">{g.lesson}</span>
            </div>
          )}
          <div className="mt-2 text-[10px] text-dim flex flex-wrap gap-x-4 gap-y-1">
            {g?.invalidation_fired && <span>invalidation fired: <span className="text-fg">{g.invalidation_fired}</span></span>}
            {g?.exit_quality && <span>exit quality: <span className="text-fg">{g.exit_quality}</span></span>}
            {link.outcome?.estimated_pnl_basis && (
              <span>P&amp;L basis: <span className="text-fg">{link.outcome.estimated_pnl_basis}</span></span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-magenta">AGENT THESIS</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 pt-5">{children}</div>
    </article>
  );
}

function Field({ label, value, tone }: {
  label: string; value?: string; tone?: 'amber' | 'red' | 'dim';
}) {
  if (!value) return null;
  const c = tone === 'amber' ? 'text-amber' : tone === 'red' ? 'text-red' : tone === 'dim' ? 'text-dim' : 'text-mid';
  return (
    <div>
      <span className={`${c} text-[10px] tracking-[0.2em] uppercase`}>{label} </span>
      <span className={tone === 'dim' ? 'text-dim' : 'text-fg'}>{value}</span>
    </div>
  );
}
