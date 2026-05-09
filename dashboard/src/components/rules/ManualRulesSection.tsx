import { useNavigate } from 'react-router-dom';
import { useManualRules, useDeleteRule } from '../../hooks/useRules';
import type { ManualRule } from '../../lib/rules-types';
import RuleCard from './RuleCard';

export default function ManualRulesSection() {
  const { data, isLoading } = useManualRules();
  const del = useDeleteRule('manual');
  const nav = useNavigate();
  const rules = data?.rules ?? [];

  function handleDelete(id: string) {
    if (!confirm('Delete this rule?')) return;
    del.mutate(id);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-mid text-[11px]">
          {rules.length} rule{rules.length === 1 ? '' : 's'}
        </div>
        <button
          onClick={() => nav('/rules/edit?section=manual')}
          className="text-cyan text-[11px] hover:underline"
        >
          [+ add rule]
        </button>
      </div>
      {isLoading ? <div className="text-dim text-[11px]">loading…</div> :
        rules.length === 0 ? <div className="text-dim text-[11px]">no manual rules yet</div> :
        <div className="space-y-2">
          {rules.map((r: ManualRule) => (
            <RuleCard
              key={r.id}
              rule={r}
              onEdit={(rule) => nav(`/rules/edit?section=manual&id=${rule.id}`)}
              onDelete={handleDelete}
            />
          ))}
        </div>
      }
    </div>
  );
}
