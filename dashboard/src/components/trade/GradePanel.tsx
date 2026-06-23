import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { isGradeable } from '../../lib/trade-types';
import type { Trade, GradeRecord, Calibration } from '../../lib/trade-types';

const CAL_COLORS: Record<Calibration, string> = {
  matched: 'text-hi',
  over_1: 'text-amber',
  under_1: 'text-amber',
  over_2: 'text-red',
  under_2: 'text-red',
};

const CAL_LABELS: Record<Calibration, string> = {
  matched: 'matched',
  over_1: 'over by 1 step',
  over_2: 'over by 2+ steps',
  under_1: 'under by 1 step',
  under_2: 'under by 2+ steps',
};

export function GradePanel({ trade, grade }: { trade: Trade; grade: GradeRecord }) {
  const qc = useQueryClient();
  const [regrading, setRegrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const regrade = useMutation({
    mutationFn: () => api('/api/trades/regrade', { method: 'POST', body: JSON.stringify({ id: trade.id }) }),
    onMutate: () => { setRegrading(true); setError(null); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trade', trade.id] }),
    onError: (e: Error) => setError(e.message ?? 'regrade failed.'),
    onSettled: () => setRegrading(false),
  });

  const h = grade.hindsight;
  const calLabel = h?.calibration ? CAL_LABELS[h.calibration] : null;
  const calColor = h?.calibration ? CAL_COLORS[h.calibration] : 'text-mid';
  const canGrade = isGradeable(trade.account);

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span><span className="text-hi">GRADES</span><span className="text-dim">──┐</span>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-mid text-[10px]">your entry grade</div>
          <div className="inline-block mt-1 px-4 py-2 border border-hi text-hi text-[28px] font-bold tnum">{grade.entry.letter}</div>
          <div className="text-fg text-[10px] mt-2">"{grade.entry.reasoning}"</div>
        </div>
        <div>
          <div className="text-mid text-[10px]">ai hindsight grade <span className="text-dim">// {h?.model ?? 'sonnet 4.6'}</span></div>
          {h ? (
            <>
              <div className={`inline-block mt-1 px-4 py-2 border ${calColor.replace('text-', 'border-')} ${calColor} text-[28px] font-bold tnum`}>
                {h.letter}
              </div>
              <div className="text-fg text-[10px] mt-2">"{h.review}"</div>
              {h.tendencies_hit.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {h.tendencies_hit.map((t) => (
                    <span key={t} className="px-2 py-0.5 border border-amber text-amber text-[10px]">{t}</span>
                  ))}
                </div>
              )}
            </>
          ) : canGrade ? (
            <div className="mt-2">
              <div className="text-mid text-[10px] pulse">// ungraded — cron picks up closed trades within 5 min</div>
              <button
                type="button"
                className="pbtn active mt-2"
                onClick={() => regrade.mutate()}
                disabled={regrading}
              >[{regrading ? 'grading…' : 'grade now*'}]</button>
            </div>
          ) : (
            <div className="mt-2">
              <div className="text-dim text-[10px]">// grading is off for bot accounts — only manual &amp; live are AI-graded</div>
            </div>
          )}
        </div>
      </div>
      <div className="px-4 py-2 border-t border-dashed border-border flex justify-between items-center">
        <span className={`text-[10px] ${calColor}`}>calibration: {calLabel ?? '—'}</span>
        {canGrade && (
          <button
            type="button" className="pbtn active"
            onClick={() => regrade.mutate()}
            disabled={regrading}
          >[{regrading ? 'regrading…' : 're-grade*'}]</button>
        )}
      </div>
      {error && <div className="px-4 pb-2 text-red text-[10px]">{error}</div>}
    </article>
  );
}
