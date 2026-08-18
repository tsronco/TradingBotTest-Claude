// dashboard/src/routes/Agent.tsx
//
// Read-only window onto the autonomous agent paper account.
//
// The other accounts are judged by their balance; this one is judged by its
// REASONING. Claude opens and closes every position here, attaches a
// falsifiable thesis to each entry, and grades its own decision separately
// from the result when the position closes. That record — not the equity curve
// — is what this page renders. Everything comes from `bot:agent:state`, pushed
// to KV by agent-trader.yml after each hourly cycle.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd, fmtPct } from '../lib/format';
import { useAgentState } from '../hooks/useBotState';
import { useDisplayName } from '../hooks/useDisplayName';
import {
  openPositions,
  closedTrades,
  agentStats,
  confidenceCalibration,
  openUnrealizedPnl,
  type AgentClosedTrade,
  type AgentLeg,
  type AgentPosition,
  type AgentThesis,
} from '../lib/agent-state';

interface AcctResp { account: { equity: string; last_equity: string; cash: string } }

export function legLine(legs: AgentLeg[] | undefined): string {
  if (!legs || legs.length === 0) return '—';
  return legs
    .map((l) => `${l.side ?? '?'} ${l.qty ?? '?'} ${l.symbol ?? '?'}`)
    .join('  ·  ');
}

/** Underlying tickers touched by a set of legs, in first-seen order.
 *  OCC symbols start with the root ticker, so the leading alpha run is it. */
export function underlyingsOf(legs: AgentLeg[] | undefined): string[] {
  const out: string[] = [];
  for (const l of legs ?? []) {
    const m = /^([A-Z]+)/.exec(l.symbol ?? '');
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function gradeColor(letter: string | undefined): string {
  if (!letter) return 'text-dim';
  const c = letter[0].toUpperCase();
  if (c === 'A') return 'text-hi';
  if (c === 'B') return 'text-cyan';
  if (c === 'C') return 'text-amber';
  return 'text-red';
}

export default function Agent() {
  const { handle } = useDisplayName();
  const stateQ = useAgentState();
  const acctQ = useQuery({
    queryKey: ['account', 'agent'],
    queryFn: () => api<AcctResp>('/api/alpaca/account?mode=agent'),
  });

  const state = stateQ.data?.payload ?? null;
  const meta = state?._meta;
  const open = openPositions(state);
  const closed = closedTrades(state);
  const stats = agentStats(closed);
  const buckets = confidenceCalibration(closed);
  const openPnl = openUnrealizedPnl(open);

  const equity = acctQ.data ? Number(acctQ.data.account.equity) : null;
  const seed = meta?.seed_capital ?? null;
  const sinceSeed = equity !== null && seed ? equity - seed : null;

  return (
    <div className="p-3 md:p-6 max-w-[1200px]">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/agent</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">lessons</span> <span className="text-amber">--account=agent</span>
      </div>

      <div className="mt-2 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-magenta leading-none">
            Agent
          </h1>
          <div className="mt-2 text-mid text-[12px]">
            autonomous paper account — Claude picks every trade, structure, size and exit.
            <span className="text-dim"> read-only here.</span>
          </div>
        </div>
        <div className="text-right text-[11px] text-dim tnum">
          <div>cycle <span className="text-fg">{meta?.cycle_count ?? '—'}</span></div>
          <div>last run <span className="text-fg">{fmtDate(meta?.last_cycle_at)}</span></div>
          {stateQ.data?.lastUpdate && (
            <div>pushed <span className="text-fg">{fmtDate(stateQ.data.lastUpdate)}</span></div>
          )}
        </div>
      </div>

      {stateQ.isLoading && <div className="mt-6 text-mid text-[12px]">loading agent state…</div>}

      {!stateQ.isLoading && !state && (
        <div className="mt-6 border border-border bg-panel/60 rounded-sm p-5 text-[12px]">
          <div className="text-amber">no agent state yet.</div>
          <div className="text-mid mt-2 leading-relaxed">
            The agent pushes <code className="text-fg">bot:agent:state</code> after each hourly
            cycle (<code className="text-fg">agent-trader.yml</code>). If this stays empty, check
            that the workflow is firing and that <code className="text-fg">BOT_PUSH_TOKEN</code>,
            the <code className="text-fg">ALPACA_AGENT_*</code> credentials and{' '}
            <code className="text-fg">ANTHROPIC_API_KEY</code> are set as GitHub Actions secrets.
          </div>
        </div>
      )}

      {state && (
        <>
          {/* ── scoreboard ─────────────────────────────────────────────── */}
          <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Stat label="equity" value={equity === null ? '—' : fmtUsd(equity)} />
            <Stat
              label="vs seed"
              value={sinceSeed === null ? '—' : fmtUsd(sinceSeed, { sign: true })}
              tone={sinceSeed === null ? undefined : sinceSeed >= 0 ? 'good' : 'bad'}
            />
            <Stat label="open" value={String(open.length)} />
            <Stat
              label="open P&L"
              value={openPnl === null ? '—' : fmtUsd(openPnl, { sign: true })}
              tone={openPnl === null ? undefined : openPnl >= 0 ? 'good' : 'bad'}
              hint="mid-based, from the agent's last cycle snapshot"
            />
            <Stat label="closed" value={String(stats.total)} />
            <Stat
              label="win rate"
              value={stats.winRate === null ? '—' : fmtPct(stats.winRate, { sign: false })}
              hint={`${stats.wins}W / ${stats.losses}L`}
            />
            <Stat
              label="avg win : avg loss"
              value={stats.winLossRatio === null ? '—' : `${stats.winLossRatio.toFixed(2)}×`}
              hint="the metric that matters more than win rate alone"
            />
            <Stat
              label="blind spots"
              value={`${stats.blindSpot} / ${stats.blindSpot + stats.anticipated}`}
              tone={stats.blindSpot > stats.anticipated ? 'bad' : undefined}
              hint="losses from a risk the thesis never named, vs one it did"
            />
          </div>

          {/* ── last market read ──────────────────────────────────────── */}
          {meta?.last_market_read && (
            <Panel title="LAST MARKET READ" className="mt-6">
              <p className="text-fg text-[12px] leading-relaxed whitespace-pre-wrap">
                {meta.last_market_read}
              </p>
              <div className="text-dim text-[10px] mt-2">
                written {fmtDate(meta.last_cycle_at)} — the agent's own summary going into its next cycle.
              </div>
            </Panel>
          )}

          {/* ── last cycle outcome ────────────────────────────────────── */}
          {meta?.last_cycle_outcome && (
            <CycleOutcome outcome={meta.last_cycle_outcome} />
          )}

          {/* ── open positions ────────────────────────────────────────── */}
          <Panel title={`OPEN POSITIONS [${open.length}]`} className="mt-6">
            {open.length === 0 ? (
              <div className="text-mid text-[12px]">flat — no open positions.</div>
            ) : (
              <div className="flex flex-col gap-4">
                {open.map((p) => <OpenCard key={p.id} pos={p} />)}
              </div>
            )}
          </Panel>

          {/* ── confidence calibration ────────────────────────────────── */}
          <Panel title="CONFIDENCE CALIBRATION" className="mt-6">
            <div className="text-mid text-[11px] mb-3">
              do its high-confidence entries actually do better? (self-rated 1–5 at entry)
            </div>
            <div className="flex flex-col gap-1 text-[11px] tnum">
              {buckets.map((b) => (
                <div key={b.confidence} className="flex items-center gap-3">
                  <span className="text-dim w-10">{'★'.repeat(b.confidence)}</span>
                  <span className="text-mid w-16">{b.trades} trade{b.trades === 1 ? '' : 's'}</span>
                  <span className="flex-1 h-2 bg-panel-2 rounded-sm overflow-hidden">
                    {b.winRate !== null && (
                      <span
                        className="block h-full bg-magenta"
                        style={{ width: `${Math.max(2, b.winRate)}%` }}
                      />
                    )}
                  </span>
                  <span className={`w-14 text-right ${b.winRate === null ? 'text-dim' : 'text-fg'}`}>
                    {b.winRate === null ? '—' : fmtPct(b.winRate, { sign: false })}
                  </span>
                  <span className={`w-20 text-right ${b.totalPnl >= 0 ? 'text-hi' : 'text-red'}`}>
                    {b.trades === 0 ? '' : fmtUsd(b.totalPnl, { sign: true })}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          {/* ── lesson cards ──────────────────────────────────────────── */}
          <Panel title={`CLOSED — LESSONS [${closed.length}]`} className="mt-6">
            {closed.length === 0 ? (
              <div className="text-mid text-[12px]">nothing closed yet.</div>
            ) : (
              <div className="flex flex-col gap-4">
                {closed.map((t, i) => <LessonCard key={`${t.closed_at}-${i}`} trade={t} />)}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────

function Stat({ label, value, tone, hint }: {
  label: string; value: string; tone?: 'good' | 'bad'; hint?: string;
}) {
  const toneClass = tone === 'good' ? 'text-hi' : tone === 'bad' ? 'text-red' : 'text-fg';
  return (
    <div className="border border-border bg-panel/60 rounded-sm px-3 py-2" title={hint}>
      <div className="text-dim text-[10px] tracking-[0.2em] uppercase">{label}</div>
      <div className={`text-[18px] font-bold tnum leading-tight ${toneClass}`}>{value}</div>
      {hint && <div className="text-dim text-[9px] mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}

function Panel({ title, children, className = '' }: {
  title: string; children: React.ReactNode; className?: string;
}) {
  return (
    <article className={`relative border border-border bg-panel/60 rounded-sm ${className}`} style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-magenta">{title}</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-5 pt-6">{children}</div>
    </article>
  );
}

function CycleOutcome({ outcome }: { outcome: NonNullable<import('../lib/agent-state').AgentMeta['last_cycle_outcome']> }) {
  const opened = outcome.opened ?? [];
  const closedOrders = outcome.closed ?? [];
  const rejected = outcome.rejected ?? [];
  if (opened.length === 0 && closedOrders.length === 0 && rejected.length === 0) return null;
  return (
    <Panel title="LAST CYCLE" className="mt-6">
      <div className="flex flex-col gap-2 text-[11px]">
        {opened.map((o, i) => (
          <div key={`o${i}`} className="flex gap-2">
            <span className="text-hi shrink-0">opened</span>
            <span className="text-fg break-all">{o.legs ?? '—'}</span>
          </div>
        ))}
        {closedOrders.map((c, i) => (
          <div key={`c${i}`} className="flex gap-2">
            <span className="text-cyan shrink-0">closed</span>
            <span className="text-fg break-all">{c.legs ?? '—'}</span>
          </div>
        ))}
        {/* Rejections are the highest-signal line here: a stateless agent can
            loop on an unplaceable structure, so surface the reason verbatim. */}
        {rejected.map((r, i) => (
          <div key={`r${i}`} className="flex gap-2">
            <span className="text-red shrink-0">rejected</span>
            <span className="text-fg break-all">
              {r.legs ?? '—'}
              <span className="text-dim"> — {r.source ?? 'unknown'}: {r.reason ?? 'no reason recorded'}</span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ThesisBlock({ thesis }: { thesis: AgentThesis | null | undefined }) {
  if (!thesis) return <div className="text-dim text-[11px]">no thesis recorded.</div>;
  return (
    <div className="flex flex-col gap-2 text-[11px] leading-relaxed">
      {thesis.thesis && <Field label="thesis" value={thesis.thesis} />}
      {thesis.getting_paid && <Field label="getting paid" value={thesis.getting_paid} />}
      {thesis.key_risk && <Field label="key risk" value={thesis.key_risk} tone="amber" />}
      {thesis.invalidation && <Field label="invalidation" value={thesis.invalidation} tone="red" />}
      {thesis.rejected && <Field label="rejected" value={thesis.rejected} tone="dim" />}
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'red' | 'dim' }) {
  const c = tone === 'amber' ? 'text-amber' : tone === 'red' ? 'text-red' : tone === 'dim' ? 'text-dim' : 'text-mid';
  return (
    <div>
      <span className={`${c} text-[10px] tracking-[0.2em] uppercase`}>{label} </span>
      <span className={tone === 'dim' ? 'text-dim' : 'text-fg'}>{value}</span>
    </div>
  );
}

function OpenCard({ pos }: { pos: AgentPosition & { id: string } }) {
  const [expanded, setExpanded] = useState(false);
  const pnl = pos.last_snapshot?.unrealized_pl;
  const tickers = underlyingsOf(pos.legs);
  const fill = pos.fill;
  return (
    <div className="border border-border rounded-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-panel-2/40"
      >
        <span className="text-dim text-[11px]">{expanded ? '▾' : '▸'}</span>
        <span className="text-magenta text-[13px] font-bold">{tickers.join(', ') || '—'}</span>
        <span className="text-dim text-[10px]">opened {fmtDate(pos.opened_at)}</span>
        {typeof pos.thesis?.confidence === 'number' && (
          <span className="text-amber text-[10px]" title="confidence at entry">
            {'★'.repeat(pos.thesis.confidence)}
          </span>
        )}
        <span className={`ml-auto tnum text-[12px] ${
          typeof pnl !== 'number' ? 'text-dim' : pnl >= 0 ? 'text-hi' : 'text-red'
        }`}>
          {typeof pnl === 'number' ? fmtUsd(pnl, { sign: true }) : '—'}
        </span>
      </button>
      <div className="px-3 pb-2 text-[11px] text-mid break-all">{legLine(pos.legs)}</div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-dashed border-border flex flex-col gap-3">
          <ThesisBlock thesis={pos.thesis} />
          {/* Persistent negative slippage means the agent's limits are too
              optimistic for that chain — worth seeing next to the thesis. */}
          {fill && fill.fill_available !== false && typeof fill.slippage === 'number' && (
            <div className="text-[10px] text-dim tnum">
              fill: asked {fill.intended_net_credit ?? '—'} · got {fill.actual_net_credit ?? '—'} ·{' '}
              <span className={fill.slippage >= 0 ? 'text-hi' : 'text-red'}>
                slippage {fill.slippage >= 0 ? '+' : ''}{fill.slippage}
              </span>{' '}
              per share
            </div>
          )}
          {pos.last_snapshot?.pnl_basis && (
            <div className="text-[10px] text-dim">P&amp;L basis: {pos.last_snapshot.pnl_basis}</div>
          )}
        </div>
      )}
    </div>
  );
}

function LessonCard({ trade }: { trade: AgentClosedTrade }) {
  const [expanded, setExpanded] = useState(false);
  const g = trade.grade;
  const pnl = trade.outcome?.estimated_pnl;
  const tickers = underlyingsOf(trade.legs);
  const days = trade.outcome?.days_held;
  return (
    <div className="border border-border rounded-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-panel-2/40"
      >
        <span className="text-dim text-[11px]">{expanded ? '▾' : '▸'}</span>
        <span className="text-magenta text-[13px] font-bold">{tickers.join(', ') || '—'}</span>
        <span className="text-dim text-[10px]">
          {fmtDate(trade.opened_at)} → {fmtDate(trade.closed_at)}
          {typeof days === 'number' && ` · ${days.toFixed(1)}d`}
        </span>
        {/* Process and outcome are graded SEPARATELY on purpose — a good
            decision can lose and a bad one can win. Show both, always. */}
        <span className="text-[10px]">
          <span className="text-dim">process </span>
          <span className={gradeColor(g?.process_grade)}>{g?.process_grade ?? '—'}</span>
          <span className="text-dim"> · outcome </span>
          <span className={gradeColor(g?.outcome_grade)}>{g?.outcome_grade ?? '—'}</span>
        </span>
        {g?.loss_type && (
          <span className={`text-[9px] border rounded-sm px-1 py-0.5 ${
            g.loss_type === 'blind_spot'
              ? 'text-red border-red/40'
              : 'text-amber border-amber/40'
          }`}>
            {g.loss_type === 'blind_spot' ? 'BLIND SPOT' : 'ANTICIPATED'}
          </span>
        )}
        <span className={`ml-auto tnum text-[12px] ${
          typeof pnl !== 'number' ? 'text-dim' : pnl >= 0 ? 'text-hi' : 'text-red'
        }`}>
          {typeof pnl === 'number' ? fmtUsd(pnl, { sign: true }) : '—'}
        </span>
      </button>

      {g?.lesson && (
        <div className="px-3 pb-2 text-[11px] text-fg leading-relaxed">
          <span className="text-magenta text-[10px] tracking-[0.2em] uppercase">lesson </span>
          {g.lesson}
        </div>
      )}

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-dashed border-border flex flex-col gap-3">
          <div className="text-[11px] text-mid break-all">{legLine(trade.legs)}</div>
          <ThesisBlock thesis={trade.thesis} />
          <div className="text-[10px] text-dim flex flex-wrap gap-x-4 gap-y-1">
            {g?.invalidation_fired && <span>invalidation fired: <span className="text-fg">{g.invalidation_fired}</span></span>}
            {g?.exit_quality && <span>exit quality: <span className="text-fg">{g.exit_quality}</span></span>}
            {trade.outcome?.estimated_pnl_basis && (
              <span>P&amp;L basis: <span className="text-fg">{trade.outcome.estimated_pnl_basis}</span></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
