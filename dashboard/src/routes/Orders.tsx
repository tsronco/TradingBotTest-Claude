import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd, fmtNum } from '../lib/format';
import AccountSelector from '../components/account/AccountSelector';
import { useAccount } from '../hooks/useAccount';

interface Order {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: string | null;
}

function OrdersTable({ mode, status, label }: { mode: 'conservative' | 'aggressive'; status: 'open' | 'closed'; label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', mode, status],
    queryFn: () => api<{ orders: Order[] }>(`/api/alpaca/orders?mode=${mode}&status=${status}`),
  });
  if (isLoading) return <div className="text-muted text-sm">Loading {label}…</div>;
  if (error) return <div className="text-red text-sm">Failed to load {label}</div>;
  const orders = data?.orders ?? [];

  return (
    <div className="bg-panel border border-border rounded-xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="text-muted text-[10px] uppercase tracking-wider">{label}</div>
        <div className="text-muted text-xs">{orders.length} orders</div>
      </div>
      {orders.length === 0 ? (
        <div className="p-6 text-muted text-sm">None.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted uppercase tracking-wider text-[10px]">
            <tr>
              <th className="text-left px-4 py-2">Submitted</th>
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-left px-4 py-2">Side</th>
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-right px-4 py-2">Qty</th>
              <th className="text-right px-4 py-2">Filled</th>
              <th className="text-right px-4 py-2">Price</th>
              <th className="text-left px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-border">
                <td className="px-4 py-2 text-muted">{new Date(o.submitted_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-text">{o.symbol}</td>
                <td className="px-4 py-2">{o.side}</td>
                <td className="px-4 py-2">{o.type}</td>
                <td className="px-4 py-2 text-right">{fmtNum(Number(o.qty))}</td>
                <td className="px-4 py-2 text-right">{fmtNum(Number(o.filled_qty))}</td>
                <td className="px-4 py-2 text-right">
                  {o.filled_avg_price
                    ? fmtUsd(Number(o.filled_avg_price))
                    : o.limit_price
                    ? `lim ${fmtUsd(Number(o.limit_price))}`
                    : o.stop_price
                    ? `stp ${fmtUsd(Number(o.stop_price))}`
                    : '—'}
                </td>
                <td className="px-4 py-2 text-muted">{o.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Orders() {
  const [mode] = useAccount();
  const sides = mode === 'both' ? ['conservative', 'aggressive'] : [mode];
  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Orders</h1>
        <AccountSelector />
      </div>
      <h2 className="text-text-strong font-semibold mb-3">Open</h2>
      {sides.map((m) => <OrdersTable key={`open-${m}`} mode={m as any} status="open" label={m} />)}
      <h2 className="text-text-strong font-semibold mb-3 mt-6">Filled today</h2>
      {sides.map((m) => <OrdersTable key={`closed-${m}`} mode={m as any} status="closed" label={m} />)}
    </div>
  );
}
