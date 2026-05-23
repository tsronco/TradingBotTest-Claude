import type { ManualRule, Trigger } from '../../lib/rules-types';

interface Props {
  rule: ManualRule;
  onEdit?: (rule: ManualRule) => void;
  onDelete?: (id: string) => void;
}

function summarizeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'symbol_in':                return `symbol ∈ {${t.symbols.join(', ')}}`;
    case 'symbol_not_in':            return `symbol ∉ {${t.symbols.join(', ')}}`;
    case 'side':                     return `side = ${t.value}`;
    case 'asset_class':              return `asset = ${t.value}`;
    case 'option_type':              return `option = ${t.value}`;
    case 'option_dte_lt':            return `DTE < ${t.value}`;
    case 'option_dte_gt':            return `DTE > ${t.value}`;
    case 'open_position_count_gt':   return `open positions > ${t.value}`;
    case 'earnings_within_days':     return `earnings ≤ ${t.value} days`;
    case 'strike_below_cost_basis':  return `strike < cost basis`;
    case 'tag_present':              return `tag = "${t.tag}"`;
    case 'max_risk_per_spread':      return `max risk per spread ≤ $${t.max_dollars}`;
    case 'recent_loss_within_minutes': return `last loss within ${t.minutes} min`;
    case 'tag_in':                   return `tag ∈ {${t.tags.join(', ')}}`;
    case 'dte_at_entry_between':     return `DTE at entry ∈ [${t.min}, ${t.max}]`;
  }
}

export default function RuleCard({ rule, onEdit, onDelete }: Props) {
  const sevColor =
    rule.severity === 'block'
      ? 'border-red/40 bg-red/5'
      : 'border-amber/40 bg-amber/5';
  const sevLabelColor =
    rule.severity === 'block' ? 'text-red' : 'text-amber';
  return (
    <div className={`border ${sevColor} p-3 space-y-2 rounded-sm`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] uppercase tracking-[0.2em] ${sevLabelColor} font-semibold`}>
          {rule.severity}
        </span>
        <span className="text-fg text-[12px] font-medium">{rule.title}</span>
        {rule.source === 'tendency' && (
          <span className="text-[9px] text-cyan ml-auto uppercase tracking-wider">from tendency</span>
        )}
      </div>
      {rule.triggers.length > 0 && (
        <div className="text-[10px] text-mid">
          {rule.triggers.map(summarizeTrigger).join(' AND ')}
        </div>
      )}
      <p className="text-[11px] text-fg/85 whitespace-pre-wrap">{rule.body}</p>
      {(onEdit || onDelete) && (
        <div className="flex gap-3 text-[10px]">
          {onEdit  && <button onClick={() => onEdit(rule)}     className="text-cyan hover:underline">[edit]</button>}
          {onDelete && <button onClick={() => onDelete(rule.id)} className="text-red  hover:underline">[delete]</button>}
        </div>
      )}
    </div>
  );
}
