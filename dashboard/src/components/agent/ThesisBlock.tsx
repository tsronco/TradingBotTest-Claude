// The agent's entry thesis, rendered the same way everywhere it appears
// (the /agent page and the trade detail panel).
//
// Extracted because it was duplicated in both places and drifted into a
// readability bug in both at once: the field "tone" was being applied to the
// prose as well as the label, so `rejected alternatives` rendered its whole
// body in --color-dim (#3d6650) against a near-black background.
//
// The rule this file exists to hold: **tone colors the LABEL, never the body.**
// Body prose is always --color-fg. A field can be de-emphasized through its
// label, but the text itself still has to be readable — reading it is the
// entire point of the panel.

import type { AgentThesis } from '../../lib/agent-state';

/** Label tint. Ordered loosely by urgency; `muted` is for supporting detail. */
export type FieldTone = 'default' | 'muted' | 'warn' | 'danger';

const LABEL_TONE: Record<FieldTone, string> = {
  // --color-mid is the dimmest tint that stays legible at 10px on this bg.
  // --color-dim is reserved for chrome (rules, separators), not for text.
  default: 'text-mid',
  muted: 'text-mid/70',
  warn: 'text-amber',
  danger: 'text-red',
};

export function ThesisField({ label, value, tone = 'default' }: {
  label: string;
  value?: string | null;
  tone?: FieldTone;
}) {
  if (!value) return null;
  return (
    <div>
      <span className={`${LABEL_TONE[tone]} text-[10px] tracking-[0.2em] uppercase`}>{label} </span>
      {/* Always full-contrast — see the note at the top of this file. */}
      <span className="text-fg">{value}</span>
    </div>
  );
}

/** The five thesis fields, in the order the agent is asked for them. */
export function ThesisBlock({ thesis }: { thesis: AgentThesis | null | undefined }) {
  if (!thesis) {
    return <div className="text-mid text-[11px]">no thesis recorded for this entry.</div>;
  }
  return (
    <div className="flex flex-col gap-2 text-[11px] leading-relaxed">
      <ThesisField label="thesis" value={thesis.thesis} />
      <ThesisField label="getting paid" value={thesis.getting_paid} />
      <ThesisField label="key risk" value={thesis.key_risk} tone="warn" />
      <ThesisField label="invalidation" value={thesis.invalidation} tone="danger" />
      <ThesisField label="rejected alternatives" value={thesis.rejected} tone="muted" />
    </div>
  );
}
