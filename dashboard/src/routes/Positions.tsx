import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../lib/format';
import AccountSelector from '../components/account/AccountSelector';
import { useAccount } from '../hooks/useAccount';
import { useBotWheelState } from '../hooks/useBotState';
import { parseOptionSymbol, daysToExpiration } from '../lib/option-symbol';

interface Position {
  symbol: string;
  asset_class: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

const EARLY_CLOSE_THRESHOLD: Record<string, number> = {
  conservative: 50,
  aggressive: 60,
};

function PositionsTable({ mode, label }: { mode: 'conservative' | 'aggressive'; label: string }) {
  const positionsQ = useQuery({
    queryKey: ['positions', mode],
    queryFn: () => api<{ positions: Position[] }>(`/api/alpaca/positions?mode=${mode}`),
  });
  const wheelQ = useBotWheelState(mode);

  if (positionsQ.isLoading) return <div className="text-muted text-sm">Loading {label}…</div>;
  if (positionsQ.error) return <div className="text-red text-sm">Failed to load {label}</div>;
  const positions = positionsQ.data?.positions ?? [];
  const wheel = (wheelQ.data?.payload as Record<string, any>) ?? {};
  const closeThreshold = EARLY_CLOSE_THRESHOLD[mode];

  return (
    <div className="bg-panel border border-border rounded-xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="text-muted text-[10px] uppercase tracking-wider">{label}</div>
        <div className="text-muted text-xs">{positions.length} positions</div>
      </div>
      {positions.length === 0 ? (
        <div className="p-6 text-muted text-sm">No open positions.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted uppercase tracking-wider text-[10px]">
            <tr>
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-right px-4 py-2">Qty</th>
              <th className="text-right px-4 py-2">Avg cost</th>
              <th className="text-right px-4 py-2">Current</th>
              <th className="text-right px-4 py-2">Mkt value</th>
              <th className="text-right px-4 py-2">Unrealized P&L</th>
              <th className="text-right px-4 py-2">DTE</th>
              <th className="text-right px-4 py-2">Wheel close</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const pl = Number(p.unrealized_pl);
              const plpc = Number(p.unrealized_plpc) * 100;
              const klass = pl >= 0 ? 'text-green' : 'text-red';
              const isOption = p.asset_class === 'us_option';
              const parsed = isOption ? parseOptionSymbol(p.symbol) : null;
              const dte = parsed ? daysToExpiration(parsed.expiration) : null;

              // Find wheel-state row by underlying. Bot tracks one open contract per symbol.
              const wheelEntry = parsed ? wheel[parsed.underlying] : null;
              const isThisWheelContract =
                wheelEntry &&
                (wheelEntry.open_contract === p.symbol || wheelEntry.contract === p.symbol);

              // For SHORT options (qty < 0): profit% = (entry - current) / entry x 100
              let closeProgress: number | null = null;
              if (isThisWheelContract && Number(p.qty) < 0) {
                const entry = Number(wheelEntry.entry_premium ?? p.avg_entry_price);
                const current = Number(p.current_price);
                if (entry > 0) {
                  const profitPct = ((entry - current) / entry) * 100;
                  closeProgress = (profitPct / closeThreshold) * 100; // % of the way to threshold
                }
              }

              return (
                <tr key={p.symbol} className="border-t border-border">
                  <td className="px-4 py-2 text-text">
                    {p.symbol}{isOption ? ' 📑' : ''}
                  </td>
                  <td className="px-4 py-2 text-right">{fmtNum(Number(p.qty))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.avg_entry_price))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.current_price))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.market_value))}</td>
                  <td className={`px-4 py-2 text-right ${klass}`}>
                    {fmtUsd(pl, { sign: true })} ({fmtPct(plpc, { sign: true })})
                  </td>
                  <td className={`px-4 py-2 text-right ${dte != null && dte <= 7 ? 'text-accent' : 'text-text'}`}>
                    {dte == null ? '—' : `${dte}d`}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {closeProgress == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={closeProgress >= 100 ? 'text-green font-semibold' : closeProgress >= 75 ? 'text-accent' : 'text-text'}>
                        {Math.round(Math.max(0, Math.min(150, closeProgress)))}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Positions() {
  const [mode] = useAccount();
  const showCons = mode === 'both' || mode === 'conservative';
  const showAgg = mode === 'both' || mode === 'aggressive';

  return (
    <div className="p-6 max-w-7xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Positions</h1>
        <AccountSelector />
      </div>
      {showCons && <PositionsTable mode="conservative" label="Conservative" />}
      {showAgg && <PositionsTable mode="aggressive" label="Aggressive" />}
    </div>
  );
}
