import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../../lib/api';
import { scoreWheelability } from '../../lib/wheelability';
import { fmtUsd, fmtPct } from '../../lib/format';

interface ChainContract { symbol: string; underlying_symbol: string; expiration_date: string; strike_price: string; type: 'call' | 'put' }
interface ChainSnapshot { latestQuote?: { ap: number; bp: number }; impliedVolatility?: number }
interface ChainResp { contracts: ChainContract[]; snapshots: Record<string, ChainSnapshot> }
interface QuoteSnap { latestTrade?: { p: number }; dailyBar?: { c: number } }
interface QuoteResp { snapshot?: Record<string, QuoteSnap> | QuoteSnap }
interface AcctResp { account: { buying_power: string; options_buying_power?: string } }

const WHEEL_TARGET_DTE = 21;

function scoreColor(score: number): string {
  if (score >= 70) return 'text-hi';
  if (score >= 40) return 'text-amber';
  return 'text-red';
}

export default function WheelabilityPanel({ symbol }: { symbol: string }) {
  // Both surviving accounts (manual + live) use the same ~10% OTM wheel band.
  const mode = 'manual' as const;

  // Same two-query pattern as OptionsChain. The expirations query (no snapshots,
  // shared cache key) populates the dropdown elsewhere; we use it here to pick
  // the expiration closest to 21 DTE (wheel target), then snapshot only that one.
  const expirationsQ = useQuery({
    queryKey: ['chain-expirations', symbol],
    queryFn: () => api<ChainResp>(`/api/alpaca/chain?symbol=${symbol}`),
  });
  const quoteQ = useQuery({ queryKey: ['quote', symbol], queryFn: () => api<QuoteResp>(`/api/alpaca/quote?symbol=${symbol}`) });
  const acctQ = useQuery({ queryKey: ['account', mode], queryFn: () => api<AcctResp>(`/api/alpaca/account?mode=${mode}`) });

  // Pick expiration nearest 21 DTE within the 7-35 window the wheel cares about.
  const targetExp = useMemo(() => {
    const exps = Array.from(new Set(expirationsQ.data?.contracts.map((c) => c.expiration_date) ?? []));
    const inRange = exps
      .map((e) => ({ e, dte: Math.round((+new Date(e) - Date.now()) / 86400000) }))
      .filter(({ dte }) => dte >= 7 && dte <= 35);
    if (inRange.length === 0) return null;
    inRange.sort((a, b) => Math.abs(a.dte - WHEEL_TARGET_DTE) - Math.abs(b.dte - WHEEL_TARGET_DTE));
    return inRange[0].e;
  }, [expirationsQ.data]);

  const snapshotsQ = useQuery({
    queryKey: ['chain-snapshots', symbol, targetExp],
    queryFn: () => api<ChainResp>(`/api/alpaca/chain?symbol=${symbol}&expiration=${targetExp}`),
    enabled: !!targetExp,
  });

  if (expirationsQ.isLoading || quoteQ.isLoading || acctQ.isLoading || snapshotsQ.isLoading) {
    return <div className="text-dim text-[11px]">computing…</div>;
  }
  if (!expirationsQ.data || !quoteQ.data || !acctQ.data) {
    return <div className="text-dim text-[11px]">insufficient data.</div>;
  }
  const snap = (quoteQ.data.snapshot && typeof quoteQ.data.snapshot === 'object' && symbol in quoteQ.data.snapshot)
    ? (quoteQ.data.snapshot as Record<string, QuoteSnap>)[symbol]
    : (quoteQ.data.snapshot as QuoteSnap | undefined);
  const stockPrice = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  if (!stockPrice) return <div className="text-dim text-[11px]">no price data.</div>;

  // Use options_buying_power, NOT buying_power — short puts can only draw
  // from the options BP pool, which is cash minus already-encumbered short
  // option collateral. The general buying_power field includes margin
  // leverage that doesn't apply to option collateral and overstates capacity.
  const result = scoreWheelability({
    stockPrice,
    optionsBuyingPower: Number(
      acctQ.data.account.options_buying_power ?? acctQ.data.account.buying_power,
    ),
    contracts: snapshotsQ.data?.contracts ?? [],
    snapshots: snapshotsQ.data?.snapshots ?? {},
    mode,
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
