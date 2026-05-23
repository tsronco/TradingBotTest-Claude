// dashboard/src/components/order/SpreadOrderForm.tsx
//
// Vertical-spread order form. Generalized to all 4 vertical types:
//   put_credit  (Bullish): SELL higher-strike put, BUY lower-strike put → CREDIT
//   put_debit   (Bearish): BUY  higher-strike put, SELL lower-strike put → DEBIT
//   call_credit (Bearish): SELL lower-strike call, BUY  higher-strike call → CREDIT
//   call_debit  (Bullish): BUY  lower-strike call, SELL higher-strike call → DEBIT
//
// Naming convention preserved: `short_leg` = STO leg, `long_leg` = BTO leg.
// The form filters the chain to puts or calls based on spread_type and
// orders the strike dropdowns so the "short" leg always reflects the leg
// the user is selling.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AccountId, GradeLetter, RuleWarning, SpreadType } from '../../lib/trade-types';
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
  /** Which of the 4 vertical types to build. Defaults to put_credit (legacy). */
  spreadType?: SpreadType;
}

interface SpreadConfig {
  legType: 'put' | 'call';
  isCredit: boolean;
  /** Display title. */
  title: string;
  /** Short leg's position relative to the long leg ('above' or 'below'). */
  shortVsLong: 'above' | 'below';
  /** Direction label (bullish/bearish). */
  direction: 'Bullish' | 'Bearish';
  /** Label for the limit-price input. */
  limitLabel: string;
}

const SPREAD_CONFIG: Record<SpreadType, SpreadConfig> = {
  put_credit:  { legType: 'put',  isCredit: true,  title: 'Put Credit Spread',  shortVsLong: 'above', direction: 'Bullish', limitLabel: 'Limit Credit ($)' },
  put_debit:   { legType: 'put',  isCredit: false, title: 'Put Debit Spread',   shortVsLong: 'below', direction: 'Bearish', limitLabel: 'Limit Debit ($)'  },
  call_credit: { legType: 'call', isCredit: true,  title: 'Call Credit Spread', shortVsLong: 'below', direction: 'Bearish', limitLabel: 'Limit Credit ($)' },
  call_debit:  { legType: 'call', isCredit: false, title: 'Call Debit Spread',  shortVsLong: 'above', direction: 'Bullish', limitLabel: 'Limit Debit ($)'  },
};

export function SpreadOrderForm({ symbol, account, setAccount, onReview, spreadType = 'put_credit' }: Props) {
  const cfg = SPREAD_CONFIG[spreadType];
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
  const [allExpirations, setAllExpirations] = useState<string[]>([]);
  const [expiration, setExpiration] = useState<string>('');
  const [shortStrike, setShortStrike] = useState<number | null>(null);
  const [longStrike, setLongStrike] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [limitNet, setLimitNet] = useState<number>(0); // abs value (credit OR debit)
  const [grade, setGrade] = useState<GradeLetter | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial chain fetch — no expiration param, so we get all contracts.
  useEffect(() => {
    fetch(`/api/alpaca/chain?symbol=${symbol}`)
      .then((r) => r.json() as Promise<ChainResponse>)
      .then((c) => {
        setChain(c);
        const set = new Set<string>();
        for (const ct of c.contracts ?? []) {
          if (ct.type === cfg.legType) set.add(ct.expiration_date);
        }
        setAllExpirations(Array.from(set).sort());
      })
      .catch((e) => setErr(String(e)));
  }, [symbol, cfg.legType]);

  useEffect(() => {
    if (!expiration) return;
    fetch(`/api/alpaca/chain?symbol=${symbol}&expiration=${expiration}`)
      .then((r) => r.json() as Promise<ChainResponse>)
      .then(setChain)
      .catch((e) => setErr(String(e)));
  }, [symbol, expiration]);

  // Normalize the contracts at the selected expiration. Sort high→low for
  // puts (matches how short-above-long reads naturally on a price ladder),
  // and low→high for calls.
  const strikesAtExpiry: NormalizedContract[] = useMemo(() => {
    const snapshots = chain?.snapshots ?? {};
    const list = (chain?.contracts ?? [])
      .filter((c) => c.expiration_date === expiration && c.type === cfg.legType)
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
      });
    return cfg.legType === 'put'
      ? list.sort((a, b) => b.strike - a.strike)
      : list.sort((a, b) => a.strike - b.strike);
  }, [chain, expiration, cfg.legType]);

  // Long-strike options depend on where the long leg must sit relative to short.
  // shortVsLong='above': long < short  (e.g. put credit, call debit)
  // shortVsLong='below': long > short  (e.g. call credit, put debit)
  const longStrikeOptions = useMemo(() => {
    if (shortStrike == null) return strikesAtExpiry;
    return strikesAtExpiry.filter((c) =>
      cfg.shortVsLong === 'above' ? c.strike < shortStrike : c.strike > shortStrike
    );
  }, [strikesAtExpiry, shortStrike, cfg.shortVsLong]);

  const shortContract = strikesAtExpiry.find((c) => c.strike === shortStrike) ?? null;
  const longContract = strikesAtExpiry.find((c) => c.strike === longStrike) ?? null;

  const shortMid = shortContract ? (shortContract.bid + shortContract.ask) / 2 : 0;
  const longMid = longContract ? (longContract.bid + longContract.ask) / 2 : 0;
  // Live net = short_mid - long_mid. Positive value with the form's current
  // legs would be a credit; we always store/display absolute (`liveNet`)
  // alongside the credit/debit interpretation `cfg.isCredit`.
  const rawNet = shortMid - longMid;
  const liveNet = Math.abs(rawNet);
  const width =
    shortContract && longContract
      ? Math.abs(shortContract.strike - longContract.strike)
      : 0;
  const maxLoss = cfg.isCredit ? width - liveNet : liveNet;
  const maxProfit = cfg.isCredit ? liveNet : width - liveNet;
  const breakeven = (() => {
    if (!shortContract || !longContract) return null;
    // Credit: BE = short ± credit (direction depends on whether short above or below long)
    // Debit:  BE = bought-leg strike ± debit
    if (spreadType === 'put_credit') return shortContract.strike - liveNet;
    if (spreadType === 'call_credit') return shortContract.strike + liveNet;
    if (spreadType === 'put_debit') return longContract.strike - liveNet;
    return longContract.strike + liveNet; // call_debit
  })();

  useEffect(() => {
    if (shortContract && longContract && limitNet === 0) {
      setLimitNet(Number(liveNet.toFixed(2)));
    }
  }, [shortContract, longContract, liveNet, limitNet]);

  async function handleReview() {
    if (!shortContract || !longContract || !reasoning.trim()) {
      setErr('Pick both strikes and write reasoning before reviewing.');
      return;
    }
    if (cfg.isCredit && liveNet === 0) {
      setErr('Credit spread requires non-zero net credit between legs.');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      // Sign convention: negative limit_price = credit (you receive),
      // positive limit_price = debit (you pay). The API's spreadMath()
      // reads the sign to compute net_credit vs net_debit.
      const limit_price = cfg.isCredit ? -limitNet : limitNet;
      const res = await fetch('/api/trades/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'spread',
          account,
          symbol,
          spread_type: spreadType,
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
          limit_price,
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

  // Whether bot auto-manages spreads of this account+type. Only put_credit
  // on manual_paper today (`spread_management: True` in config.MODES['manual']).
  // Everything else is opened, tracked, and visible but NOT auto-closed.
  const botManaged = spreadType === 'put_credit' && account === 'manual_paper';

  if (err) return <div className="text-red text-[12px]">error: {err}</div>;
  if (!chain) return <div className="text-mid text-[12px]">loading chain…</div>;

  return (
    <div className="space-y-4 text-[12px]">
      {/* spread-type header */}
      <div className="border border-border rounded-sm p-3 bg-panel/40">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <span className="text-hi text-[14px] font-bold">{cfg.title}</span>
            <span className="text-dim mx-2">·</span>
            <span className={cfg.direction === 'Bullish' ? 'text-cyan' : 'text-red'}>{cfg.direction}</span>
          </div>
          <span className="text-dim text-[10px]">// {symbol} · {cfg.legType}s · short {cfg.shortVsLong} long</span>
        </div>
      </div>

      {/* bot-management banner */}
      {!botManaged && (
        <div className="border border-amber/40 rounded-sm p-2 bg-amber/5 text-amber text-[11px]">
          ⚠ Bot will track this {cfg.title.toLowerCase()} but won't auto-close. Manage it manually (close via dashboard or Alpaca).
        </div>
      )}

      {/* account selector — same 6 paper accounts as the legacy form */}
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

      {/* expiration */}
      <div className="flex flex-col gap-1 md:flex-row md:items-center">
        <label htmlFor="expiration" className="text-dim text-[10px] tracking-[0.25em] mb-2 md:mb-0 md:mr-2">Expiration</label>
        <select
          id="expiration"
          value={expiration}
          onChange={(e) => {
            setExpiration(e.target.value);
            setShortStrike(null);
            setLongStrike(null);
            setLimitNet(0);
          }}
          className="bg-panel-2 border border-border px-2 py-1 text-fg w-full md:w-auto max-md:min-h-[44px]"
        >
          <option value="">pick…</option>
          {allExpirations.map((e) => {
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
          <label htmlFor="short-strike" className="text-dim text-[10px] tracking-[0.25em] mb-2">Short Strike (sell)</label>
          <select
            id="short-strike"
            value={shortStrike ?? ''}
            onChange={(e) => {
              setShortStrike(e.target.value ? Number(e.target.value) : null);
              setLongStrike(null);
              setLimitNet(0);
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
          <label htmlFor="long-strike" className="text-dim text-[10px] tracking-[0.25em] mb-2">Long Strike (buy)</label>
          <select
            id="long-strike"
            value={longStrike ?? ''}
            onChange={(e) => {
              setLongStrike(e.target.value ? Number(e.target.value) : null);
              setLimitNet(0);
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

      {/* embedded options chain. Click bid → SHORT leg (sell at bid).
          Click ask → LONG leg (buy at ask). Locked to the spread's legType
          + selected expiration. */}
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
            sideLock={cfg.legType === 'put' ? 'puts' : 'calls'}
            expirationLock={expiration}
            highlights={[
              ...(shortStrike != null ? [{ strike: shortStrike, side: 'bid' as const, role: 'short' as const }] : []),
              ...(longStrike != null ? [{ strike: longStrike, side: 'ask' as const, role: 'long' as const }] : []),
            ]}
            onPriceClick={(info: ChainStrikeClick) => {
              const strike = Number(info.contract.strike_price);
              const isShortClick = info.side === 'bid' || info.side === 'row';
              const isLongClick = info.side === 'ask';
              if (isShortClick) {
                setShortStrike(strike);
                // Clear long if it would violate the short-vs-long ordering for this spread type.
                if (longStrike != null) {
                  const valid =
                    cfg.shortVsLong === 'above' ? longStrike < strike : longStrike > strike;
                  if (!valid) setLongStrike(null);
                }
                setLimitNet(0);
              } else if (isLongClick) {
                if (shortStrike != null) {
                  const valid =
                    cfg.shortVsLong === 'above' ? strike < shortStrike : strike > shortStrike;
                  if (!valid) {
                    // Promote to short if user clicked the "wrong" side of the ladder.
                    setShortStrike(strike);
                    setLongStrike(null);
                  } else {
                    setLongStrike(strike);
                  }
                } else {
                  setLongStrike(strike);
                }
                setLimitNet(0);
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

      {/* fill-hint chips — only render when both quotes are positive and ordered. */}
      {shortContract && longContract && (() => {
        // Net bid/ask for the SPREAD as a whole.
        // Sell-spread (credit): net_bid = short_bid - long_ask, net_ask = short_ask - long_bid
        // Buy-spread  (debit):  net_bid = long_bid - short_ask, net_ask = long_ask - short_bid
        const netBid = cfg.isCredit
          ? shortContract.bid - longContract.ask
          : longContract.bid - shortContract.ask;
        const netAsk = cfg.isCredit
          ? shortContract.ask - longContract.bid
          : longContract.ask - shortContract.bid;
        if (netBid > 0 && netAsk > 0 && netBid < netAsk) {
          return (
            <FillHint
              side={cfg.isCredit ? 'sell' : 'buy'}
              bid={netBid}
              ask={netAsk}
              onPick={(p) => setLimitNet(p)}
            />
          );
        }
        return null;
      })()}

      <div className="flex flex-col gap-1 md:flex-row md:items-center">
        <label htmlFor="limit-net" className="text-dim text-[10px] tracking-[0.25em] mb-2 md:mb-0 md:mr-2">{cfg.limitLabel}</label>
        <input
          id="limit-net"
          type="number"
          step={0.01}
          value={limitNet}
          onChange={(e) => setLimitNet(Number(e.target.value))}
          className="bg-panel-2 border border-border px-2 py-1 text-fg w-full md:w-24 max-md:min-h-[44px]"
        />
      </div>

      {/* payoff chart — rendered when both legs selected. */}
      {shortContract && longContract && qty > 0 && spotPrice > 0 && (
        <PayoffChart
          legs={[
            {
              kind: 'option',
              dir: 'short',
              type: cfg.legType,
              strike: shortContract.strike,
              premium: shortMid,
              contracts: qty,
            } as Leg,
            {
              kind: 'option',
              dir: 'long',
              type: cfg.legType,
              strike: longContract.strike,
              premium: longMid,
              contracts: qty,
            } as Leg,
          ]}
          currentPrice={spotPrice}
        />
      )}

      {shortContract && longContract && (
        <div className="text-mid">
          <div>
            Live mid {cfg.isCredit ? 'credit' : 'debit'}: ${liveNet.toFixed(2)} ($
            {(liveNet * 100 * qty).toFixed(2)})
          </div>
          <div>
            Max profit: ${maxProfit.toFixed(2)} (${(maxProfit * 100 * qty).toFixed(2)})
          </div>
          <div>
            Max loss: ${maxLoss.toFixed(2)} (${(maxLoss * 100 * qty).toFixed(2)})
          </div>
          {breakeven !== null && <div>Break-even: ${breakeven.toFixed(2)}</div>}
        </div>
      )}

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
