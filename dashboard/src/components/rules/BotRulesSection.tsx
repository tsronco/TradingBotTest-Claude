import type { BotRulesPayload } from '../../lib/rules-types';

interface Props {
  manual: BotRulesPayload | null;
  live: BotRulesPayload | null;
}

function ModeColumn({ payload, label }: { payload: BotRulesPayload | null; label: string }) {
  if (!payload) {
    return (
      <div className="space-y-2 text-[11px]">
        <div className="text-cyan uppercase tracking-[0.2em] text-[10px] font-semibold">{label}</div>
        <div className="text-dim text-[10px]">no data — bot hasn't pushed yet</div>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-[11px]">
      <div className="text-cyan uppercase tracking-[0.2em] text-[10px] font-semibold">{label}</div>
      <div>
        <div className="text-fg font-medium">Wheel</div>
        <ul className="ml-3 mt-1 space-y-0.5 text-fg/85">
          {payload.wheel.symbols.length > 0 && (
            <li>Symbols: <span className="text-mid">{payload.wheel.symbols.join(', ')}</span></li>
          )}
          {payload.wheel.priority_tier && (
            <li>Priority: <span className="text-mid">{payload.wheel.priority_tier.join(', ')}</span></li>
          )}
          {payload.wheel.fallback_tier && (
            <li>Fallback: <span className="text-mid">{payload.wheel.fallback_tier.join(', ')}</span></li>
          )}
          <li>OTM %: <span className="tnum">{(payload.wheel.otm_pct * 100).toFixed(0)}%</span></li>
          <li>DTE: <span className="tnum">{payload.wheel.dte_min}-{payload.wheel.dte_max}</span></li>
          <li>Close at: <span className="tnum">{(payload.wheel.close_at_profit_pct * 100).toFixed(0)}%</span></li>
        </ul>
      </div>
      <div>
        <div className="text-fg font-medium">Strategy ({payload.strategy.underlying})</div>
        <ul className="ml-3 mt-1 space-y-0.5 text-fg/85">
          <li>Initial qty: <span className="tnum">{payload.strategy.initial_qty}</span></li>
          <li>Stop: <span className="tnum">-{(payload.strategy.stop_loss_pct * 100).toFixed(0)}%</span></li>
          <li>Trail activate: <span className="tnum">+{(payload.strategy.trail_activate_pct * 100).toFixed(0)}%</span></li>
          <li>Trail floor: <span className="tnum">-{(payload.strategy.trail_floor_pct * 100).toFixed(0)}%</span></li>
          {payload.strategy.ladders.map((l, i) => (
            <li key={i}>Ladder {i + 1}: <span className="tnum">-{(l.trigger_pct * 100).toFixed(0)}% → +{l.qty} sh</span></li>
          ))}
        </ul>
      </div>
      {payload.congress && (
        <div>
          <div className="text-fg font-medium">Congress copy</div>
          <ul className="ml-3 mt-1 space-y-0.5 text-fg/85">
            <li>Politicians: <span className="text-mid">{payload.congress.politicians.map(p => p.name).join(', ')}</span></li>
            <li>Sizing tiers: <span className="tnum">{payload.congress.sizing_tiers.length}</span></li>
          </ul>
        </div>
      )}
      {payload.flags && Object.keys(payload.flags).length > 0 && (
        <div>
          <div className="text-fg font-medium">Flags</div>
          <ul className="ml-3 mt-1 space-y-0.5 text-amber">
            {Object.entries(payload.flags).filter(([, v]) => v).map(([k]) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-[9px] text-dim">pushed: {payload.pushed_at}</div>
    </div>
  );
}

export default function BotRulesSection({ manual, live }: Props) {
  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ModeColumn payload={manual} label="Manual" />
        <ModeColumn payload={live} label="Live $" />
      </div>
      <div className="mt-3 text-[9px] text-dim">edit in <code className="text-fg">config.py</code> on the bot repo</div>
    </div>
  );
}
