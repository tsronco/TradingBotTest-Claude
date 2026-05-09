// dashboard/src/components/trade/RuleViolationsPanel.tsx
//
// Display panel for `trade.rule_warnings_at_entry` on the /trade/:id page.
// Renders each violation with severity-coded styling. For block-severity
// violations, also shows the typed override reason. When the trade had no
// violations at entry, shows a quiet "no rule violations" stub so the user
// knows the absence was intentional (rather than a render bug).

import type { Trade, RuleWarning } from '../../lib/trade-types';

const SEVERITY_LABEL_CLASS: Record<RuleWarning['severity'], string> = {
  block: 'text-red',
  warn: 'text-amber',
  info: 'text-mid',
};

const SEVERITY_BORDER_CLASS: Record<RuleWarning['severity'], string> = {
  block: 'border-red/30 bg-red/5',
  warn: 'border-amber/30 bg-amber/5',
  info: 'border-border bg-panel-2/30',
};

export function RuleViolationsPanel({ trade }: { trade: Trade }) {
  const violations = trade.rule_warnings_at_entry ?? [];

  return (
    <article className="relative border border-border bg-panel/60 rounded-sm" style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className="text-hi">RULE VIOLATIONS AT ENTRY</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4">
        {violations.length === 0 ? (
          <div className="text-dim text-[11px]">— no rule violations for this trade —</div>
        ) : (
          <ul className="space-y-2">
            {violations.map((v, i) => (
              <li
                key={`${v.rule}-${i}`}
                className={`border ${SEVERITY_BORDER_CLASS[v.severity]} rounded-sm px-3 py-2 text-[11px]`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[9px] uppercase tracking-[0.2em] font-semibold ${SEVERITY_LABEL_CLASS[v.severity]}`}>
                    {v.severity}
                  </span>
                  <span className="text-fg">{v.message}</span>
                  <span className="ml-auto text-dim text-[9px] font-mono">{v.rule}</span>
                </div>
                {v.override_reason && (
                  <div className="mt-1.5 text-[10px] text-mid italic">
                    ↳ override: "{v.override_reason}"
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
