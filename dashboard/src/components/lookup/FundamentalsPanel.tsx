import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';

interface FundResp {
  error?: string;
  detail?: string;
  warnings?: string[];
  fundamentals: {
    market_cap?: number | null;
    pe_ratio?: number | null;
    sector?: string | null;
    fifty_two_week_low?: number | null;
    fifty_two_week_high?: number | null;
  };
}

function fmtMarketCap(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

export default function FundamentalsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['fundamentals', symbol],
    queryFn: () => api<FundResp>(`/api/fundamentals-proxy?symbol=${symbol}`),
  });
  if (isLoading) return <div className="text-dim text-[11px]">loading fundamentals…</div>;
  if (data?.error) {
    return (
      <div className="text-dim text-[11px] leading-relaxed">
        fundamentals temporarily unavailable{data.detail ? ` — ${data.detail}` : '.'}
      </div>
    );
  }
  const f = data?.fundamentals ?? {};
  const partial = (data?.warnings?.length ?? 0) > 0;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-y-1 text-[11px] tnum">
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">market cap</dt>
        <dd className="text-fg text-right">{fmtMarketCap(f.market_cap)}</dd>
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">P/E</dt>
        <dd className="text-fg text-right">{f.pe_ratio?.toFixed(1) ?? <span className="text-dim">—</span>}</dd>
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">sector</dt>
        <dd className="text-fg text-right text-[11px] tracking-normal">{f.sector ?? <span className="text-dim">—</span>}</dd>
        <dt className="text-dim tracking-[0.15em] uppercase text-[10px]">52w range</dt>
        <dd className="text-fg text-right">
          {f.fifty_two_week_low && f.fifty_two_week_high
            ? <>{fmtUsd(f.fifty_two_week_low)} <span className="text-dim">—</span> {fmtUsd(f.fifty_two_week_high)}</>
            : <span className="text-dim">—</span>}
        </dd>
      </dl>
      {partial && (
        <div className="text-dim text-[10px] mt-2 italic">data may be partial</div>
      )}
    </div>
  );
}
