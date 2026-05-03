import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { scoreWheelability } from '../../lib/wheelability';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useAccount } from '../../hooks/useAccount';

interface ChainContract { symbol: string; underlying_symbol: string; expiration_date: string; strike_price: string; type: 'call' | 'put' }
interface ChainSnapshot { latestQuote?: { ap: number; bp: number }; impliedVolatility?: number }
interface ChainResp { contracts: ChainContract[]; snapshots: Record<string, ChainSnapshot> }
interface QuoteSnap { latestTrade?: { p: number }; dailyBar?: { c: number } }
interface QuoteResp { snapshot?: Record<string, QuoteSnap> | QuoteSnap }
interface AcctResp { account: { buying_power: string } }

function scoreColor(score: number): string {
  if (score >= 70) return 'text-hi';
  if (score >= 40) return 'text-amber';
  return 'text-red';
}

export default function WheelabilityPanel({ symbol }: { symbol: string }) {
  const [accountMode] = useAccount();
  const mode = accountMode === 'aggressive' ? 'aggressive' : 'conservative';

  const chainQ = useQuery({ queryKey: ['chain', symbol], queryFn: () => api<ChainResp>(`/api/alpaca/chain?symbol=${symbol}`) });
  const quoteQ = useQuery({ queryKey: ['quote', symbol], queryFn: () => api<QuoteResp>(`/api/alpaca/quote?symbol=${symbol}`) });
  const acctQ = useQuery({ queryKey: ['account', mode], queryFn: () => api<AcctResp>(`/api/alpaca/account?mode=${mode}`) });

  if (chainQ.isLoading || quoteQ.isLoading || acctQ.isLoading) {
    return <div className="text-dim text-[11px]">computing…</div>;
  }
  if (!chainQ.data || !quoteQ.data || !acctQ.data) {
    return <div className="text-dim text-[11px]">insufficient data.</div>;
  }
  const snap = (quoteQ.data.snapshot && typeof quoteQ.data.snapshot === 'object' && symbol in quoteQ.data.snapshot)
    ? (quoteQ.data.snapshot as Record<string, QuoteSnap>)[symbol]
    : (quoteQ.data.snapshot as QuoteSnap | undefined);
  const stockPrice = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  if (!stockPrice) return <div className="text-dim text-[11px]">no price data.</div>;

  const result = scoreWheelability({
    stockPrice,
    buyingPower: Number(acctQ.data.account.buying_power),
    contracts: chainQ.data.contracts,
    snapshots: chainQ.data.snapshots,
  });

  return (
    <div>
      {result.reason === 'computed' ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className={`text-[34px] font-bold tnum leading-none ${scoreColor(result.score)}`}>{result.score}</span>
            <span className="text-dim text-[14px] tnum">/ 100</span>
            <span className="text-dim text-[10px] tracking-[0.25em] uppercase ml-1">·  {mode}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-y-1 text-[11px] tnum">
            <span className="text-dim tracking-[0.15em] uppercase text-[10px]">best put</span>
            <span className="text-fg text-right">{fmtUsd(result.bestStrike!)} · {result.bestExpiration}</span>
            <span className="text-dim tracking-[0.15em] uppercase text-[10px]">yield</span>
            <span className="text-fg text-right">{fmtPct(result.yieldPct ?? 0)}</span>
            <span className="text-dim tracking-[0.15em] uppercase text-[10px]">spread</span>
            <span className="text-fg text-right">{fmtUsd(result.spread ?? 0)}</span>
            <span className="text-dim tracking-[0.15em] uppercase text-[10px]">BP fit</span>
            <span className={`text-right ${result.bpFit ? 'text-hi' : 'text-red'}`}>{result.bpFit ? '✓ yes' : '✗ no'}</span>
            <span className="text-dim tracking-[0.15em] uppercase text-[10px]">annualized</span>
            <span className="text-fg text-right">~{fmtPct(result.annualizedPct ?? 0)}</span>
          </div>
        </>
      ) : result.reason === 'no_quotes' ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-dim text-[34px] font-bold tnum leading-none">—</span>
            <span className="text-dim text-[14px] tnum">/ 100</span>
          </div>
          <div className="text-[11px] text-dim mt-2 leading-relaxed">
            live option quotes unavailable. markets are closed (or quote feed is down) — wheelability score will populate during regular hours.
          </div>
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-dim text-[34px] font-bold tnum leading-none">—</span>
            <span className="text-dim text-[14px] tnum">/ 100</span>
          </div>
          <div className="text-[11px] text-dim mt-2 leading-relaxed">
            no put expirations in the 7–35 DTE window for {symbol}.
          </div>
        </>
      )}
    </div>
  );
}
