import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';

const DEPOSIT_URL = 'https://app.alpaca.markets/brokerage/funding/deposit/ach';

interface Activity {
  id: string;
  activity_type: string; // 'CSD' (deposit) | 'CSW' (withdrawal)
  date?: string;
  net_amount?: string;
}

export default function FundingPanel({ mode }: { mode: 'manual' | 'live' }) {
  const { data } = useQuery({
    queryKey: ['activities', mode],
    queryFn: () => api<{ activities: Activity[] }>(`/api/alpaca/activities?mode=${mode}`),
    staleTime: 60_000,
  });

  const transfers = (data?.activities ?? []).filter(
    (a) => a.activity_type === 'CSD' || a.activity_type === 'CSW',
  );

  return (
    <div className="px-5 pb-3">
      <div className="text-[10px] tracking-[0.25em] text-dim mb-2">FUNDING</div>
      {transfers.length === 0 ? (
        <div className="text-[11px] text-dim">no deposits or withdrawals yet</div>
      ) : (
        <ul className="space-y-1">
          {transfers.slice(0, 5).map((a) => {
            const isDep = a.activity_type === 'CSD';
            const amt = Math.abs(Number(a.net_amount ?? 0));
            const dollars = fmtUsd(amt, { sign: false });
            return (
              <li key={a.id} className="flex items-center justify-between text-[11px] tnum">
                <span className="text-dim">{a.date ?? '—'}</span>
                <span className={isDep ? 'text-hi' : 'text-red'}>
                  {isDep ? '▲ deposit ' : '▼ withdrawal '}
                  {isDep ? '+' : '−'}{dollars}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <a
        href={DEPOSIT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-[11px] text-cyan hover:underline"
      >
        Deposit funds ↗
      </a>
    </div>
  );
}
