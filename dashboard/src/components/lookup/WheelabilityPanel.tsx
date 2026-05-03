import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { scoreWheelability } from '../../lib/wheelability';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useAccount } from '../../hooks/useAccount';

export default function WheelabilityPanel({ symbol }: { symbol: string }) {
  const [accountMode] = useAccount();
  const mode = accountMode === 'aggressive' ? 'aggressive' : 'conservative';

  const chainQ = useQuery({ queryKey: ['chain', symbol], queryFn: () => api<any>(`/api/alpaca/chain?symbol=${symbol}`) });
  const quoteQ = useQuery({ queryKey: ['quote', symbol], queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`) });
  const acctQ = useQuery({ queryKey: ['account', mode], queryFn: () => api<any>(`/api/alpaca/account?mode=${mode}`) });

  if (chainQ.isLoading || quoteQ.isLoading || acctQ.isLoading) {
    return <div className="text-muted text-xs">Computing…</div>;
  }
  if (!chainQ.data || !quoteQ.data || !acctQ.data) {
    return <div className="text-muted text-xs">Insufficient data.</div>;
  }
  const snap = quoteQ.data.snapshot?.[symbol] ?? quoteQ.data.snapshot;
  const stockPrice = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  if (!stockPrice) return <div className="text-muted text-xs">No price data.</div>;

  const result = scoreWheelability({
    stockPrice,
    buyingPower: Number(acctQ.data.account.buying_power),
    contracts: chainQ.data.contracts.map((c: any) => ({ ...c, symbol: c.symbol })),
    snapshots: chainQ.data.snapshots,
  });

  return (
    <div>
      {result.reason === 'computed' ? (
        <>
          <div className="text-3xl font-bold text-accent">{result.score} / 100</div>
          <div className="text-xs text-text mt-2 leading-relaxed">
            Best put: <b>{fmtUsd(result.bestStrike!)} · {result.bestExpiration}</b><br />
            Yield: {fmtPct(result.yieldPct ?? 0)} · Spread: {fmtUsd(result.spread ?? 0)} · BP fit {result.bpFit ? '✓' : '✗'}<br />
            Annualized: ~{fmtPct(result.annualizedPct ?? 0)}
          </div>
        </>
      ) : result.reason === 'no_quotes' ? (
        <>
          <div className="text-3xl font-bold text-muted">— / 100</div>
          <div className="text-xs text-muted mt-2 leading-relaxed">
            Live option quotes unavailable. Markets are closed (or quote feed is down) — wheelability score will populate during regular hours.
          </div>
        </>
      ) : (
        <>
          <div className="text-3xl font-bold text-muted">— / 100</div>
          <div className="text-xs text-muted mt-2 leading-relaxed">
            No put expirations in the 7–35 DTE window for {symbol}.
          </div>
        </>
      )}
    </div>
  );
}
