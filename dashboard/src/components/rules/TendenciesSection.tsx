import { Link } from 'react-router-dom';
import { useTendencies } from '../../hooks/useRules';
import type { Tendency } from '../../lib/rules-types';

export default function TendenciesSection() {
  const { data, isLoading } = useTendencies();
  if (isLoading) return <div className="text-dim text-[11px]">loading…</div>;
  const items = data?.tendencies ?? [];
  if (items.length === 0) return <div className="text-dim text-[11px]">no tendencies detected yet — sunday cron runs at 6 PM ET</div>;

  return (
    <ul className="space-y-3">
      {items.map((t: Tendency) => (
        <li key={t.id} className="border border-cyan/30 bg-cyan/5 p-3 rounded-sm text-[11px]">
          <div className="text-cyan text-[9px] uppercase tracking-[0.2em] mb-1">{t.matcher}</div>
          <div className="text-fg/90">{t.finding}</div>
          {t.evidence_trade_ids.length > 0 && (
            <details className="mt-2">
              <summary className="text-[10px] text-mid cursor-pointer">
                {t.evidence_trade_ids.length} evidence trade{t.evidence_trade_ids.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-1 ml-3 space-y-0.5 text-[10px]">
                {t.evidence_trade_ids.map((id) => (
                  <li key={id}>· <Link to={`/trade/${id}`} className="text-cyan hover:underline">{id}</Link></li>
                ))}
              </ul>
            </details>
          )}
          <div className="text-[9px] text-dim mt-1">detected: {t.detected_at}</div>
        </li>
      ))}
    </ul>
  );
}
