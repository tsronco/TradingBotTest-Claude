import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';

interface FundResp {
  error?: string;
  message?: string;
  fundamentals: {
    market_cap?: number | null;
    pe_ratio?: number | null;
    sector?: string | null;
    fifty_two_week_low?: number | null;
    fifty_two_week_high?: number | null;
  };
}

export default function FundamentalsPanel({ symbol }: { symbol: string }) {
  const { data } = useQuery({
    queryKey: ['fundamentals', symbol],
    queryFn: () => api<FundResp>(`/api/fundamentals?symbol=${symbol}`),
  });
  if (data?.error === 'finnhub_not_configured') {
    return (
      <div className="text-muted text-xs leading-relaxed">
        {data.message ?? 'Fundamentals unavailable — configure FINNHUB_API_KEY.'}
      </div>
    );
  }
  const f = data?.fundamentals ?? {};
  return (
    <dl className="grid grid-cols-2 gap-y-1 text-xs">
      <dt className="text-muted">Market cap</dt>
      <dd className="text-text text-right">{f.market_cap ? `$${(f.market_cap / 1e9).toFixed(1)}B` : '—'}</dd>
      <dt className="text-muted">P/E</dt>
      <dd className="text-text text-right">{f.pe_ratio?.toFixed(1) ?? '—'}</dd>
      <dt className="text-muted">Sector</dt>
      <dd className="text-text text-right">{f.sector ?? '—'}</dd>
      <dt className="text-muted">52w range</dt>
      <dd className="text-text text-right">
        {f.fifty_two_week_low && f.fifty_two_week_high ? `${fmtUsd(f.fifty_two_week_low)} — ${fmtUsd(f.fifty_two_week_high)}` : '—'}
      </dd>
    </dl>
  );
}
