import type { RuleWarning } from '../../lib/trade-types';

interface Props {
  blocks: RuleWarning[];
  reasonByRule: Record<string, string>;
  onReasonChange: (ruleId: string, value: string) => void;
}

const MIN_REASON_LEN = 20;
const MAX_REASON_LEN = 500;

export default function BlockOverrideFields({ blocks, reasonByRule, onReasonChange }: Props) {
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-3 mt-3 border border-red/40 bg-red/5 p-3 rounded-sm">
      <div className="text-red text-[10px] tracking-[0.25em] uppercase">
        ━━━ override required ({blocks.length} block{blocks.length === 1 ? '' : 's'}) ━━━
      </div>
      {blocks.map((b) => {
        const reason = reasonByRule[b.rule] ?? '';
        const trimmed = reason.trim();
        const remaining = Math.max(0, MIN_REASON_LEN - trimmed.length);
        return (
          <div key={b.rule}>
            <div className="text-red text-[11px] mb-1">{b.message}</div>
            <textarea
              value={reason}
              onChange={(e) => onReasonChange(b.rule, e.target.value)}
              maxLength={MAX_REASON_LEN}
              rows={2}
              placeholder="why is this trade the exception? (≥ 20 chars)"
              className="w-full bg-panel-2 border border-border focus:border-red px-2 py-1 text-fg text-[11px] placeholder:text-dim resize-y outline-none"
            />
            <div className="text-[9px] text-dim mt-1">
              {remaining > 0
                ? `${remaining} more chars`
                : `${trimmed.length}/${MAX_REASON_LEN}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}
