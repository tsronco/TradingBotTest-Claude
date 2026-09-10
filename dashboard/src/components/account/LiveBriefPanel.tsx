import { useState } from 'react';
import { useLiveBrief } from '../../hooks/useBotState';
import { fmtUsd } from '../../lib/format';
import { briefDateLabel, briefIsStale, type BriefIdea } from '../../lib/live-brief';

/**
 * Today's read-only morning brief for the live account, on the Home card.
 *
 * live_brief.py runs at 9:40 ET each trading day and pushes its record to KV
 * as `bot:live:brief`. This panel shows the market read, each idea with its
 * fit-to-account verdict, and the per-holding watch lines. Nothing here is a
 * button that trades — the user reads and decides. A brief from a previous
 * session is shown dimmed with a STALE tag so old prices are never mistaken
 * for today's.
 */
export default function LiveBriefPanel() {
  const { data, isLoading } = useLiveBrief();
  const brief = data?.payload?.last_brief ?? null;
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="px-5 pb-3 border-t border-dashed border-border pt-3">
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <span className="text-[10px] tracking-[0.25em] text-dim">MORNING BRIEF</span>
        {brief && (
          <span className="text-[10px] text-mid tnum">{briefDateLabel(brief.date)} · 9:40 ET</span>
        )}
        {brief && briefIsStale(brief) && (
          <span
            className="text-[9px] text-amber border border-amber/40 rounded-sm px-1 py-0.5"
            title="From a previous session — prices and ideas are out of date."
          >
            STALE
          </span>
        )}
        <span className="ml-auto text-[10px] text-dim">read-only · ideas, not signals</span>
      </div>

      {isLoading && <div className="text-[11px] text-dim">loading brief…</div>}

      {!isLoading && !brief && (
        <div className="text-[11px] text-dim">
          no brief yet — the first one lands at 9:40 ET on the next trading day
        </div>
      )}

      {brief && (
        <div className={briefIsStale(brief) ? 'opacity-60' : ''}>
          <p className="text-[12px] text-fg leading-snug mb-2">{brief.market_read}</p>

          {brief.ideas.length === 0 && (
            <div className="text-[11px] text-mid mb-2">
              <span className="text-amber">no actionable trade today</span>
              {brief.no_trade_reason && <span className="text-dim"> — {brief.no_trade_reason}</span>}
            </div>
          )}

          {brief.ideas.length > 0 && (
            <ul className="space-y-1 mb-2">
              {brief.ideas.map((idea, i) => (
                <IdeaRow
                  key={`${idea.symbol}-${i}`}
                  n={i + 1}
                  idea={idea}
                  open={open === i}
                  onToggle={() => setOpen(open === i ? null : i)}
                />
              ))}
            </ul>
          )}

          {brief.ideas.length > 0 && !brief.ideas.some((i) => i.fits_account) && brief.no_trade_reason && (
            <div className="text-[11px] text-dim mb-2">{brief.no_trade_reason}</div>
          )}

          {brief.held.length > 0 && (
            <div className="text-[11px]">
              <div className="text-[10px] tracking-[0.25em] text-dim mb-1">ON WHAT YOU HOLD</div>
              <ul className="space-y-0.5">
                {brief.held.map((h) => (
                  <li key={h.symbol}>
                    <span className="text-fg">{h.symbol}</span>
                    <span className="text-mid"> — {h.watch}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IdeaRow({ n, idea, open, onToggle }: { n: number; idea: BriefIdea; open: boolean; onToggle: () => void }) {
  const dirClass = idea.direction === 'bullish' ? 'text-hi' : idea.direction === 'bearish' ? 'text-red' : 'text-mid';
  return (
    <li className="text-[11px]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left flex items-baseline gap-2 flex-wrap hover:bg-panel-2/60 rounded-sm px-1 -mx-1"
      >
        <span className="text-dim tnum">{n}.</span>
        <span className="text-fg font-bold">{idea.symbol}</span>
        <span className="text-mid">{idea.structure}</span>
        <span className={dirClass}>{idea.direction}</span>
        <span className="text-dim tnum">max loss {fmtUsd(idea.max_loss_usd, { sign: false })}</span>
        <span className={idea.fits_account ? 'text-hi' : 'text-amber'}>
          {idea.fits_account ? '✓ fits' : `✗ needs ${fmtUsd(idea.capital_required_usd, { sign: false })}`}
        </span>
        <span className="text-dim tnum ml-auto">conf {idea.confidence}/5 {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 ml-4 space-y-0.5 text-[11px] text-mid">
          <div><span className="text-dim">legs</span> {idea.legs}</div>
          <div><span className="text-dim">why</span> {idea.why}</div>
          <div><span className="text-dim">paid</span> {idea.getting_paid}</div>
          <div><span className="text-dim">wrong if</span> {idea.invalidation}</div>
          <div><span className="text-dim">risk</span> {idea.key_risk}</div>
        </div>
      )}
    </li>
  );
}
