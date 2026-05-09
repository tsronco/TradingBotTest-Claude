import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';
import type { Trade } from '../../lib/trade-types';

interface Props {
  date: string | null;
  account?: string;
  closedTradeIds: string[];
  expiring: Array<{ trade_id: string; symbol: string; option_type: 'put' | 'call'; strike: number }>;
  onClose: () => void;
}

export default function DayDrawer({ date, closedTradeIds, expiring, onClose }: Props) {
  if (!date) return null;

  return (
    <div className="fixed top-0 right-0 h-full w-96 max-w-full bg-panel border-l border-border z-30 overflow-y-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-hi text-[14px] font-bold tracking-wider">{date}</h2>
        <button onClick={onClose} className="text-dim hover:text-fg text-[14px]">[×]</button>
      </div>

      {expiring.length > 0 && (
        <div className="mb-4">
          <div className="text-[10px] text-cyan uppercase tracking-[0.2em] mb-2">expiring</div>
          <ul className="space-y-1 text-[11px]">
            {expiring.map((e) => (
              <li key={e.trade_id} className="border border-border bg-panel-2/30 rounded-sm px-2 py-1.5">
                <Link to={`/trade/${e.trade_id}`} className="text-cyan hover:underline font-mono">{e.trade_id}</Link>
                <div className="text-mid text-[10px] mt-0.5">
                  {e.symbol} {e.option_type.toUpperCase()} ${e.strike}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="text-[10px] text-dim uppercase tracking-[0.2em] mb-2">
          closed trades ({closedTradeIds.length})
        </div>
        {closedTradeIds.length === 0
          ? <div className="text-dim text-[11px]">none</div>
          : <ul className="space-y-2">
              {closedTradeIds.map((id) => <ClosedTradeRow key={id} id={id} />)}
            </ul>
        }
      </div>
    </div>
  );
}

function ClosedTradeRow({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['trade', id],
    queryFn: () => api<{ trade: Trade }>(`/api/trades/get?id=${id}`),
  });
  if (q.isLoading) return <li className="text-dim text-[11px]">loading…</li>;
  if (!q.data) return <li className="text-dim text-[11px]">{id} (not found)</li>;
  const t = q.data.trade;
  const pnl = t.realized_pnl ?? 0;
  return (
    <li className="border border-border bg-panel-2/30 rounded-sm px-2 py-1.5 text-[11px]">
      <Link to={`/trade/${id}`} className="text-cyan hover:underline font-mono">{id}</Link>
      <div className="text-mid text-[10px] mt-0.5">
        {t.symbol} · {t.asset_class}{t.contract_type ? `/${t.contract_type}` : ''} · {t.account}
      </div>
      <div className={`text-[11px] tnum mt-0.5 ${pnl >= 0 ? 'text-hi' : 'text-red'}`}>
        {pnl >= 0 ? '+' : '-'}{fmtUsd(Math.abs(pnl))}
      </div>
    </li>
  );
}
