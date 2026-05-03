import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../lib/format';
import AccountSelector from '../components/account/AccountSelector';
import { useAccount } from '../hooks/useAccount';

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

function PositionsTable({ mode, label }: { mode: 'conservative' | 'aggressive'; label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['positions', mode],
    queryFn: () => api<{ positions: Position[] }>(`/api/alpaca/positions?mode=${mode}`),
  });

  if (isLoading) return <div className="text-muted text-sm">Loading {label}…</div>;
  if (error) return <div className="text-red text-sm">Failed to load {label}</div>;
  const positions = data?.positions ?? [];

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
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const pl = Number(p.unrealized_pl);
              const plpc = Number(p.unrealized_plpc) * 100;
              const klass = pl >= 0 ? 'text-green' : 'text-red';
              return (
                <tr key={p.symbol} className="border-t border-border">
                  <td className="px-4 py-2 text-text">{p.symbol}{p.asset_class === 'us_option' ? ' 📑' : ''}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(Number(p.qty))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.avg_entry_price))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.current_price))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.market_value))}</td>
                  <td className={`px-4 py-2 text-right ${klass}`}>
                    {fmtUsd(pl, { sign: true })} ({fmtPct(plpc, { sign: true })})
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
    <div className="p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Positions</h1>
        <AccountSelector />
      </div>
      {showCons && <PositionsTable mode="conservative" label="Conservative" />}
      {showAgg && <PositionsTable mode="aggressive" label="Aggressive" />}
    </div>
  );
}
