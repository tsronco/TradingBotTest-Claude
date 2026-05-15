// dashboard/src/components/order/SpreadOrderForm.tsx
//
// Put-credit-spread order form. Two-leg ticket against /api/alpaca/chain.
// Adapts the real chain response shape (contracts with `strike_price: string`,
// `expiration_date`, and bid/ask sourced from `snapshots[symbol].latestQuote`)
// rather than the plan's idealized fixture shape.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AccountId, GradeLetter, RuleWarning } from '../../lib/trade-types';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import PayoffChart from './PayoffChart';
import FillHint from './FillHint';
import type { Leg } from '../../lib/payoff';

interface ChainContractRaw {
  symbol: string;
  strike_price: string;
  expiration_date: string;
  type: 'put' | 'call';
}

interface ChainSnapshot {
  latestQuote?: { bp?: number; ap?: number };
}

interface ChainResponse {
  contracts: ChainContractRaw[];
  snapshots?: Record<string, ChainSnapshot>;
}

interface NormalizedContract {
  symbol: string;
  strike: number;
  expiration: string;
  type: 'put' | 'call';
  bid: number;
  ask: number;
}

interface PreviewResult {
  exposure: number;
  requires_totp: boolean;
  rule_warnings: RuleWarning[];
  draft: any;
}

interface Props {
  symbol: string;
  account: AccountId;
  setAccount: (a: AccountId) => void;
  onReview: (preview: PreviewResult) => void;
}

export function SpreadOrderForm({ symbol, setAccount, onReview }: Props) {
  // Spreads are only bot-managed on manual_paper; coerce any incoming account to manual_paper.
  const effectiveAccount: AccountId = 'manual_paper';

  // Spot price for the underlying (used by PayoffChart)
  const { data: spotData } = useQuery({
    queryKey: ['quote', symbol, 'manual'],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${symbol}&mode=manual`),
    staleTime: 10_000,
  });
  const spotSnap = spotData?.snapshot?.[symbol];
  const spotPrice: number =
    spotSnap?.latestTrade?.p ?? spotSnap?.dailyBar?.c ?? 0;

  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [expiration, setExpiration] = useState<string>('');
  const [shortStrike, setShortStrike] = useState<number | null>(null);
  const [longStrike, setLongStrike] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [limitCredit, setLimitCredit] = useState<number>(0);
  const [grade, setGrade] = useState<GradeLetter | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial chain fetch — no expiration param, so we get all contracts (no snapshots).
  // When the user picks an expiration we re-fetch with `&expiration=...` to pull
  // snapshots (bid/ask) for that slice.
  useEffect(() => {
    fetch(`/api/alpaca/chain?symbol=${symbol}`)
      .then((r) => r.json() as Promise<ChainResponse>)
      .then(setChain)
      .catch((e) => setErr(String(e)));
  }, [symbol]);

  useEffect(() => {
    if (!expiration) return;
    fetch(`/api/alpaca/chain?symbol=${symbol}&expiration=${expiration}`)
      .then((r) => r.json() as Promise<ChainResponse>)
      .then(setChain)
      .catch((e) => setErr(String(e)));
  }, [symbol, expiration]);

  // Derive the expiration dropdown from contracts (sorted ascending, puts only).
  const expirations = useMemo(() => {
    const set = new Set<string>();
    for (const c of chain?.contracts ?? []) {
      if (c.type === 'put') set.add(c.expiration_date);
    }
    return Array.from(set).sort();
  }, [chain]);

  // Normalize the put contracts at the selected expiration, sorted high→low.
  const strikesAtExpiry: NormalizedContract[] = useMemo(() => {
    const snapshots = chain?.snapshots ?? {};
    return (chain?.contracts ?? [])
      .filter((c) => c.expiration_date === expiration && c.type === 'put')
      .map((c) => {
        const snap = snapshots[c.symbol];
        return {
          symbol: c.symbol,
          strike: Number(c.strike_price),
          expiration: c.expiration_date,
          type: c.type,
          bid: snap?.latestQuote?.bp ?? 0,
          ask: snap?.latestQuote?.ap ?? 0,
        };
      })
      .sort((a, b) => b.strike - a.strike);
  }, [chain, expiration]);

  const longStrikeOptions = useMemo(
    () => strikesAtExpiry.filter((c) => shortStrike == null || c.strike < shortStrike),
    [strikesAtExpiry, shortStrike]
  );

  const shortContract = strikesAtExpiry.find((c) => c.strike === shortStrike) ?? null;
  const longContract = strikesAtExpiry.find((c) => c.strike === longStrike) ?? null;

  const shortMid = shortContract ? (shortContract.bid + shortContract.ask) / 2 : 0;
  const longMid = longContract ? (longContract.bid + longContract.ask) / 2 : 0;
  const liveCredit = shortMid - longMid;
  const width =
    shortContract && longContract
      ? Math.abs(shortContract.strike - longContract.strike)
      : 0;
  const maxLoss = width - liveCredit;

  useEffect(() => {
    if (shortContract && longContract && limitCredit === 0) {
      setLimitCredit(Number(liveCredit.toFixed(2)));
    }
  }, [shortContract, longContract, liveCredit, limitCredit]);

  async function handleReview() {
    if (!shortContract || !longContract || !reasoning.trim()) {
      setErr('Pick both strikes and write reasoning before reviewing.');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch('/api/trades/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'spread',
          account: effectiveAccount,
          symbol,
          spread_type: 'put_credit',
          short_leg: {
            occ: shortContract.symbol,
            strike: shortContract.strike,
            entry_premium: shortMid,
          },
          long_leg: {
            occ: longContract.symbol,
            strike: longContract.strike,
            entry_premium: longMid,
          },
          expiration,
          qty,
          limit_price: -limitCredit,
          entry_grade: grade ?? '',
          entry_reasoning: reasoning,
          tags,
        }),
      });
      const data = (await res.json()) as PreviewResult;
      onReview(data);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (err) return <div className="text-red text-[12px]">error: {err}</div>;
  if (!chain) return <div className="text-mid text-[12px]">loading chain…</div>;

  return (
    <div className="space-y-4 text-[12px]">
      {/* account selector — spread management is ONLY on manual paper; cons/agg/live disabled */}
      <div className="flex flex-col gap-1">
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ account ─────────</div>
        <div className="flex gap-1 flex-wrap">
          <button
            type="button"
            disabled
            className="pbtn max-md:min-h-[44px] opacity-40"
            title="Spreads are bot-managed on manual paper only"
          >
            [conservative_paper]
          </button>
          <button
            type="button"
            disabled
            className="pbtn max-md:min-h-[44px] opacity-40"
            title="Spreads are bot-managed on manual paper only"
          >
            [aggressive_paper]
          </button>
          <button
            type="button"
            className={`pbtn max-md:min-h-[44px] ${effectiveAccount === 'manual_paper' ? 'active' : ''}`}
            onClick={() => setAccount('manual_paper')}
          >
            [manual_paper{effectiveAccount === 'manual_paper' ? '*' : ''}]
          </button>
          <button
            type="button"
            disabled
            className="pbtn max-md:min-h-[44px] text-red opacity-40"
            title="Spreads are bot-managed on manual paper only"
          >
            [live]
          </button>
        </div>
      </div>

      {/* data-driven list — intentionally a select, not chips (see order-form-upgrades spec) */}
      <div className="flex flex-col gap-1 md:flex-row md:items-center">
        <label htmlFor="expiration" className="text-dim text-[10px] tracking-[0.25em] mb-2 md:mb-0 md:mr-2">Expiration</label>
        <select
          id="expiration"
          value={expiration}
          onChange={(e) => {
            setExpiration(e.target.value);
            // Reset downstream selections when the expiration changes.
            setShortStrike(null);
            setLongStrike(null);
            setLimitCredit(0);
          }}
          className="bg-panel-2 border border-border px-2 py-1 text-fg w-full md:w-auto max-md:min-h-[44px]"
        >
          <option value="">pick…</option>
          {expirations.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:gap-4">
        <div className="flex flex-col gap-1 flex-1">
          <label htmlFor="short-strike" className="text-dim text-[10px] tracking-[0.25em] mb-2">Short Strike</label>
          <select
            id="short-strike"
            value={shortStrike ?? ''}
            onChange={(e) => {
              setShortStrike(e.target.value ? Number(e.target.value) : null);
              setLongStrike(null);
              setLimitCredit(0);
            }}
            disabled={!expiration}
            className="bg-panel-2 border border-border px-2 py-1 text-fg w-full max-md:min-h-[44px]"
          >
            <option value="">pick…</option>
            {strikesAtExpiry.map((c) => (
              <option key={c.strike} value={c.strike}>
                ${c.strike.toFixed(2)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 flex-1">
          <label htmlFor="long-strike" className="text-dim text-[10px] tracking-[0.25em] mb-2">Long Strike</label>
          <select
            id="long-strike"
            value={longStrike ?? ''}
            onChange={(e) => {
              setLongStrike(e.target.value ? Number(e.target.value) : null);
              setLimitCredit(0);
            }}
            disabled={shortStrike == null}
            className="bg-panel-2 border border-border px-2 py-1 text-fg w-full max-md:min-h-[44px]"
          >
            <option value="">pick…</option>
            {longStrikeOptions.map((c) => (
              <option key={c.strike} value={c.strike}>
                ${c.strike.toFixed(2)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1 md:flex-row md:items-center">
        <label htmlFor="qty" className="text-dim text-[10px] tracking-[0.25em] mb-2 md:mb-0 md:mr-2">Qty (spreads)</label>
        <input
          id="qty"
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
          className="bg-panel-2 border border-border px-2 py-1 text-fg w-full md:w-20 max-md:min-h-[44px]"
        />
      </div>

      {shortContract && longContract && (() => {
        const netBid = shortContract.bid - longContract.ask;
        const netAsk = shortContract.ask - longContract.bid;
        if (netBid > 0 && netAsk > 0 && netBid < netAsk) {
          return (
            <FillHint
              side="sell"
              bid={netBid}
              ask={netAsk}
              onPick={(p) => setLimitCredit(p)}
            />
          );
        }
        return null;
      })()}

      <div className="flex flex-col gap-1 md:flex-row md:items-center">
        <label htmlFor="limit-credit" className="text-dim text-[10px] tracking-[0.25em] mb-2 md:mb-0 md:mr-2">Limit Credit ($)</label>
        <input
          id="limit-credit"
          type="number"
          step={0.01}
          value={limitCredit}
          onChange={(e) => setLimitCredit(Number(e.target.value))}
          className="bg-panel-2 border border-border px-2 py-1 text-fg w-full md:w-24 max-md:min-h-[44px]"
        />
      </div>

      {/* payoff chart — rendered above the live-mid/max-loss text when both legs are selected */}
      {shortContract && longContract && qty > 0 && shortMid > 0 && spotPrice > 0 && (() => {
        const legs: Leg[] = [
          {
            kind: 'option',
            dir: 'short',
            type: 'put',
            strike: shortContract.strike,
            premium: shortMid,
            contracts: qty,
          },
          {
            kind: 'option',
            dir: 'long',
            type: 'put',
            strike: longContract.strike,
            premium: longMid,
            contracts: qty,
          },
        ];
        return <PayoffChart legs={legs} currentPrice={spotPrice} />;
      })()}

      {shortContract && longContract && (
        <div className="text-mid">
          <div>
            Live mid credit: ${liveCredit.toFixed(2)} ($
            {(liveCredit * 100 * qty).toFixed(2)})
          </div>
          <div>
            Max loss: ${maxLoss.toFixed(2)} (${(maxLoss * 100 * qty).toFixed(2)})
          </div>
          <div>Break-even: ${(shortContract.strike - liveCredit).toFixed(2)}</div>
        </div>
      )}

      {/* entry grade — pbtn chips via GradePicker, mirrors StockOrderForm */}
      <div className="flex flex-col gap-1">
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ entry grade ───────</div>
        <GradePicker value={grade} onChange={setGrade} />
      </div>

      <div>
        <label htmlFor="reasoning" className="text-dim text-[10px] tracking-[0.25em] mb-2 block">━━━ reasoning (required) ──</label>
        <textarea
          id="reasoning"
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          rows={3}
          className="w-full mt-1 bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
          placeholder="why are you taking this trade?"
        />
      </div>

      {/* tags — same TagPicker as StockOrderForm */}
      <div className="flex flex-col gap-1">
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ tags ──────────────</div>
        <TagPicker value={tags} onChange={setTags} />
      </div>

      <button
        onClick={handleReview}
        disabled={submitting}
        className="border border-border px-3 py-1 text-fg hover:bg-mid/10 w-full md:w-auto max-md:min-h-[44px]"
      >
        {submitting ? 'reviewing…' : 'Review'}
      </button>
    </div>
  );
}
