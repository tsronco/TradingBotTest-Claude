import { TRIGGER_TYPES, type Trigger, type TriggerType } from '../../lib/rules-types';

interface Props {
  triggers: Trigger[];
  onChange: (next: Trigger[]) => void;
}

const DEFAULTS: Record<TriggerType, Trigger> = {
  symbol_in:                { type: 'symbol_in', symbols: [] },
  symbol_not_in:            { type: 'symbol_not_in', symbols: [] },
  side:                     { type: 'side', value: 'sell' },
  asset_class:              { type: 'asset_class', value: 'option' },
  option_type:              { type: 'option_type', value: 'put' },
  option_dte_lt:            { type: 'option_dte_lt', value: 7 },
  option_dte_gt:            { type: 'option_dte_gt', value: 30 },
  open_position_count_gt:   { type: 'open_position_count_gt', value: 3 },
  earnings_within_days:     { type: 'earnings_within_days', value: 7 },
  strike_below_cost_basis:  { type: 'strike_below_cost_basis' },
  tag_present:              { type: 'tag_present', tag: '' },
  max_risk_per_spread:      { type: 'max_risk_per_spread', max_dollars: 500 },
};

export default function TriggerBuilder({ triggers, onChange }: Props) {
  function update(i: number, next: Trigger) {
    onChange(triggers.map((t, idx) => (idx === i ? next : t)));
  }
  function remove(i: number) {
    onChange(triggers.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...triggers, { ...DEFAULTS.symbol_in }]);
  }

  return (
    <div className="space-y-2">
      {triggers.length > 0 && (
        <div className="text-[10px] text-dim tracking-[0.15em] uppercase">all triggers must match (AND)</div>
      )}
      {triggers.map((t, i) => (
        <div key={i} className="flex items-center gap-2 flex-wrap">
          <select
            value={t.type}
            onChange={(e) => update(i, { ...DEFAULTS[e.target.value as TriggerType] })}
            aria-label="trigger type"
            className="bg-panel-2 border border-border focus:border-cyan rounded-sm px-2 py-1 text-fg text-[11px] outline-none"
          >
            {TRIGGER_TYPES.map((tt) => <option key={tt} value={tt}>{tt}</option>)}
          </select>
          <TriggerValueInput trigger={t} onChange={(next) => update(i, next)} />
          <button
            onClick={() => remove(i)}
            type="button"
            aria-label="remove trigger"
            className="text-red text-[11px] hover:underline ml-auto"
          >
            [×]
          </button>
        </div>
      ))}
      <button
        onClick={add}
        type="button"
        className="text-cyan text-[11px] hover:underline"
      >
        [+ add trigger]
      </button>
    </div>
  );
}

const inputCls = 'bg-panel-2 border border-border focus:border-cyan rounded-sm px-2 py-1 text-fg text-[11px] tnum outline-none';

function TriggerValueInput({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  switch (trigger.type) {
    case 'symbol_in':
    case 'symbol_not_in':
      return (
        <input
          type="text"
          placeholder="TSLA, F, NVDA"
          aria-label="symbols"
          value={trigger.symbols.join(', ')}
          onChange={(e) => onChange({
            ...trigger,
            symbols: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
          })}
          className={`${inputCls} flex-1 min-w-[10rem]`}
        />
      );
    case 'side':
      return (
        <select
          value={trigger.value}
          aria-label="side"
          onChange={(e) => onChange({ ...trigger, value: e.target.value as 'buy' | 'sell' })}
          className={inputCls}
        >
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
      );
    case 'asset_class':
      return (
        <select
          value={trigger.value}
          aria-label="asset class"
          onChange={(e) => onChange({ ...trigger, value: e.target.value as 'stock' | 'option' })}
          className={inputCls}
        >
          <option value="stock">stock</option>
          <option value="option">option</option>
        </select>
      );
    case 'option_type':
      return (
        <select
          value={trigger.value}
          aria-label="option type"
          onChange={(e) => onChange({ ...trigger, value: e.target.value as 'put' | 'call' })}
          className={inputCls}
        >
          <option value="put">put</option>
          <option value="call">call</option>
        </select>
      );
    case 'option_dte_lt':
    case 'option_dte_gt':
    case 'open_position_count_gt':
    case 'earnings_within_days':
      return (
        <input
          type="number"
          min={0}
          max={365}
          aria-label="value"
          value={trigger.value}
          onChange={(e) => onChange({ ...trigger, value: parseInt(e.target.value || '0', 10) })}
          className={`${inputCls} w-20`}
        />
      );
    case 'strike_below_cost_basis':
      return <span className="text-[10px] text-dim">(no params)</span>;
    case 'tag_present':
      return (
        <input
          type="text"
          aria-label="tag"
          placeholder="tag-name"
          value={trigger.tag}
          onChange={(e) => onChange({ ...trigger, tag: e.target.value })}
          className={inputCls}
        />
      );
    case 'max_risk_per_spread':
      return (
        <input
          type="number"
          min={0}
          step={50}
          aria-label="max dollars per spread"
          value={trigger.max_dollars}
          onChange={(e) => onChange({ ...trigger, max_dollars: parseInt(e.target.value || '0', 10) })}
          className={`${inputCls} w-24`}
        />
      );
  }
}
