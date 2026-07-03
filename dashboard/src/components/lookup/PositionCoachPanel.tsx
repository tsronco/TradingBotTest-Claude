import { useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import type { TrailingCoach } from '../../../api/_lib/position-coach';

type Mode = 'manual' | 'live';
const MODES: readonly Mode[] = ['manual', 'live'] as const;

const MODE_ACCENT: Record<Mode, { dot: string; text: string }> = {
  manual: { dot: 'bg-cyan', text: 'text-cyan' },
  live: { dot: 'bg-red', text: 'text-red' },
};

interface Facts {
  symbol: string;
  mode: Mode;
  is_live: boolean;
  asset_class: 'stock' | 'option' | 'other';
  side: 'long' | 'short';
  qty: number;
  avg_cost: number;
  current_price: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pct: number | null;
  stop_price: number | null;
  trailing_active: boolean | null;
  trailing_coach: TrailingCoach | null;
  ladder_rungs_total: number | null;
  ladder_rungs_remaining: number | null;
  wheel_stage: number | null;
  is_excluded: boolean;
}

interface CoachResp {
  symbol: string;
  mode: Mode;
  held: boolean;
  facts: Facts | null;
  explainer: string | null;
  generated_at: string | null;
  cached: boolean;
}

// Mirror of the server's deterministicReadout — used only when the LLM
// explainer is null (model down) so the panel never goes blank.
function fmtUsd(n: number | null): string {
  return n == null ? 'unknown' : `$${n.toFixed(2)}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}
// Mirror of trailingReadoutSentences() in api/_lib/position-coach.ts — kept in
// lockstep by tests/lib/position-coach-parity.test.ts.
function trailingReadoutSentences(tc: TrailingCoach, qty: number): string[] {
  const unit = qty === 1 ? 'share' : 'shares';
  if (tc.state === 'off') {
    const out = ['The trailing stop is off — it arms on its own once the price climbs to ' + fmtUsd(tc.activation_price) + ` (${Math.round(tc.activation_pct * 100)}% above entry).`];
    if (tc.activation_gap_abs != null && tc.activation_gap_pct != null) {
      out.push(`That's ${fmtUsd(tc.activation_gap_abs)} (${fmtPct(tc.activation_gap_pct)}) above the current price.`);
    }
    return out;
  }
  if (tc.state === 'triggering') {
    return [`The trailing stop is on and the price has fallen to its ${fmtUsd(tc.trigger_price)} trigger — the bot sells on its next cycle.`];
  }
  // state === 'on'
  const out = [`The trailing stop is on, with its trigger at ${fmtUsd(tc.trigger_price)} — a stop that ratchets up as the price rises but never moves down.`];
  if (tc.locked_kind === 'gain') {
    out.push(`If it triggers, that locks in a gain of at least ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${qty} ${unit}) over your cost.`);
  } else {
    out.push(`Its trigger sits below your cost, so if it fires it caps the loss at ${fmtUsd(tc.locked_per_share)}/share (${fmtUsd(tc.locked_total)} across ${qty} ${unit}).`);
  }
  if (tc.next_raise_above != null) {
    out.push(`Your floor climbs the moment the price prints above ${fmtUsd(tc.next_raise_above)}; every new high drags the stop up ${Math.round(tc.trail_distance_pct * 100)}% behind it.`);
  }
  return out;
}
function deterministicReadout(f: Facts): string {
  const unit = f.asset_class === 'option' ? 'contract' : 'share';
  const parts: string[] = [];
  parts.push(
    `You ${f.side === 'short' ? 'are short' : 'hold'} ${f.qty} ${unit}${f.qty === 1 ? '' : 's'} of ${f.symbol} at an average cost of ${fmtUsd(f.avg_cost)}${f.current_price != null ? `, now ${fmtUsd(f.current_price)}` : ''}.`,
  );
  if (f.unrealized_pl != null) {
    const dir = f.unrealized_pl >= 0 ? 'gain' : 'loss';
    const pct = f.unrealized_pl_pct != null ? ` (${f.unrealized_pl_pct >= 0 ? '+' : ''}${f.unrealized_pl_pct.toFixed(2)}%)` : '';
    parts.push(`That's an unrealized (on-paper) ${dir} of ${fmtUsd(Math.abs(f.unrealized_pl))}${pct}.`);
  }
  if (f.stop_price != null) {
    parts.push(`The bot's stop is set at ${fmtUsd(f.stop_price)} — it sells automatically if the price falls there, which would realize the loss.`);
    if (f.trailing_coach) parts.push(...trailingReadoutSentences(f.trailing_coach, f.qty));
  } else if (!f.is_excluded) {
    parts.push("The bot hasn't recorded a stop for this symbol yet.");
  }
  if (f.ladder_rungs_remaining != null && f.ladder_rungs_total != null) {
    parts.push(`${f.ladder_rungs_remaining} of ${f.ladder_rungs_total} ladder add-on buys remain.`);
  }
  if (f.wheel_stage != null) parts.push(`Wheel stage ${f.wheel_stage} (1 = cash-secured put, 2 = covered call).`);
  if (f.is_excluded) parts.push('This symbol is on the exclusion list, so the bot leaves it alone.');
  return parts.join(' ');
}

export default function PositionCoachPanel({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const queries = useQueries({
    queries: MODES.map((mode) => ({
      queryKey: ['position-coach', mode, symbol],
      queryFn: () => api<CoachResp>(`/api/alpaca/position-coach?symbol=${symbol}&mode=${mode}`),
      enabled: !!symbol,
      staleTime: 5 * 60 * 1000,
    })),
  });

  const refresh = useMutation({
    mutationFn: (mode: Mode) => api<CoachResp>(`/api/alpaca/position-coach?symbol=${symbol}&mode=${mode}&refresh=1`),
    onSuccess: (fresh, mode) => qc.setQueryData(['position-coach', mode, symbol], fresh),
  });

  const held = queries
    .map((q, i) => ({ mode: MODES[i], data: q.data }))
    .filter((x): x is { mode: Mode; data: CoachResp } => !!x.data && x.data.held && !!x.data.facts);

  // Render nothing at all when the symbol isn't held in either account — no
  // empty box on un-held lookups. Also nothing while still loading the first time.
  if (queries.some((q) => q.isLoading)) return null;
  if (held.length === 0) return null;

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm min-w-0 mb-6 mt-3">
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">POSITION_COACH</span>
        <span className="text-dim">·</span>
        <span className="text-amber">{symbol}</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 pt-5 space-y-3">
      {held.map(({ mode, data }) => {
        const f = data.facts!;
        const accent = MODE_ACCENT[mode];
        const text = data.explainer ?? deterministicReadout(f);
        const refreshing = refresh.isPending && refresh.variables === mode;
        return (
          <div key={mode}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] uppercase">
                <span className={`w-1.5 h-1.5 rounded-sm ${accent.dot}`} />
                <span className={accent.text}>{mode}</span>
                {f.is_live && <span className="text-red text-[9px] border border-red/40 rounded-sm px-1 py-0.5">REAL MONEY</span>}
              </div>
              <button
                type="button"
                onClick={() => refresh.mutate(mode)}
                disabled={refreshing}
                className="text-mid hover:text-cyan flex items-center gap-1 text-[10px] disabled:opacity-50 transition-colors"
                title="Regenerate explanation"
              >
                <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> refresh
              </button>
            </div>
            <p className="text-fg text-[12px] md:text-[13px] leading-relaxed">
              {refreshing ? 'rewriting…' : text}
            </p>
          </div>
        );
      })}
      <div className="flex items-center gap-1.5 text-dim text-[10px] tracking-[0.1em] pt-1 border-t border-dashed border-border">
        <GraduationCap size={11} className="text-amber" />
        Educational — explains your position and the bot&apos;s plan. Not financial advice.
      </div>
      </div>
    </article>
  );
}

// Exported for unit tests of the client-side fallback parity.
export { deterministicReadout, type Facts };
