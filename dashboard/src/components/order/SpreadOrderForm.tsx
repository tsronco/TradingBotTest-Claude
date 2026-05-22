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
import { accountToMode, ALL_PAPER_ACCOUNTS, type Mode } from '../../lib/account-utils';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import PayoffChart from './PayoffChart';
import FillHint from './FillHint';
import type { Leg } from '../../lib/payoff';
import { daysToExpiration } from '../../lib/option-symbol';
import OptionsChain, { type ChainStrikeClick } from '../lookup/OptionsChain';

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

export function SpreadOrderForm({ symbol, account, setAccount, onReview }: Props) {
  // Derive mode from selected account via the single source of truth
  // (mirrors api/_lib/rule-check.ts accountToMode). The account prop can be
  // any AccountId incl. SM via the ?account= URL param on /order/new — a
  // hardcoded 4-branch chain silently routed SM quotes/preview to conservative.
  const mode: Mode = accountToMode(account);

  // Spot price for the underlying (used by PayoffChart)
  const { data: spotData } = useQuery({
    queryKey: ['quote', symbol, mode],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${symbol}&mode=${mode}`),
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
          account,
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
      {/* account selector — all 6 paper accounts (cons/agg/manual + sm500/sm1000/sm2000)
          enabled; live stays disabled (real-money/bot-only) */}
      <div className="flex flex-col gap-1">
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ account ─────────</div>
        <div className="flex gap-1 flex-wrap">
          {ALL_PAPER_ACCOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              className={`pbtn max-md:min-h-[44px] ${account === a ? 'active' : ''}`}
              onClick={() => setAccount(a)}
            >
              [{a}{account === a ? '*' : ''}]
            </button>
          ))}
          <button
            type="button"
            disabled
            className="pbtn max-md:min-h-[44px] text-red opacity-40"
            title="Live spreads are bot-managed only — not available for manual entry"
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
          {expirations.map((e) => {
            const dte = daysToExpiration(e);
            const dteLabel = dte < 0 ? 'expired' : `${dte} DTE`;
            return (
              <option key={e} value={e}>
                {e} ({dteLabel})
              </option>
            );
          })}
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

      {/* embedded options chain — premiums visible upfront. Click bid on a strike
          to set it as the SHORT leg (you sell at the bid); click ask to set it
          as the LONG leg (you buy at the ask). Locked to puts + the selected
          expiration. Dropdowns above still work as a fallback. */}
      {expiration && (
        <div className="border border-border rounded-sm p-3 bg-panel/40">
          <div className="text-dim text-[10px] tracking-[0.25em] mb-2 flex items-center justify-between gap-2 flex-wrap">
            <span>━━━ options chain — click bid (sell) → short · click ask (buy) → long ─</span>
            <span className="text-mid normal-case tracking-normal">
              short: <span className={shortStrike != null ? 'text-red' : 'text-dim'}>{shortStrike != null ? `$${shortStrike.toFixed(2)}` : 'pick'}</span>
              <span className="text-dim mx-1">·</span>
              long: <span className={longStrike != null ? 'text-cyan' : 'text-dim'}>{longStrike != null ? `$${longStrike.toFixed(2)}` : 'pick'}</span>
            </span>
          </div>
          <OptionsChain
            symbol={symbol}
            sideLock="puts"
            expirationLock={expiration}
            onPriceClick={(info: ChainStrikeClick) => {
              const strike = Number(info.contract.strike_price);
              if (info.side === 'bid' || info.side === 'row') {
                // Sell-side click → short leg. If this would put short ≤ long, clear long.
                setShortStrike(strike);
                if (longStrike != null && strike <= longStrike) setLongStrike(null);
                setLimitCredit(0);
              } else if (info.side === 'ask') {
                // Buy-side click → long leg. Must be strictly below short.
                if (shortStrike != null && strike >= shortStrike) {
                  // Promote to short instead — user clicked above the current short.
                  setShortStrike(strike);
                  if (longStrike != null && strike <= longStrike) setLongStrike(null);
                } else {
                  setLongStrike(strike);
                }
                setLimitCredit(0);
              }
            }}
          />
        </div>
      )}

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
