// dashboard/src/components/order/SpreadOrderForm.tsx
//
// Put-credit-spread order form. Two-leg ticket against /api/alpaca/chain.
// Adapts the real chain response shape (contracts with `strike_price: string`,
// `expiration_date`, and bid/ask sourced from `snapshots[symbol].latestQuote`)
// rather than the plan's idealized fixture shape.
import { useEffect, useMemo, useState } from 'react';
import type { AccountId, GradeLetter, RuleWarning } from '../../lib/trade-types';
import { GRADE_LETTERS } from '../../lib/trade-types';

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
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [expiration, setExpiration] = useState<string>('');
  const [shortStrike, setShortStrike] = useState<number | null>(null);
  const [longStrike, setLongStrike] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [limitCredit, setLimitCredit] = useState<number>(0);
  const [grade, setGrade] = useState<GradeLetter>('B');
  const [reasoning, setReasoning] = useState('');
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
          entry_grade: grade,
          entry_reasoning: reasoning,
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
      <div>
        <label htmlFor="account" className="text-mid">Account</label>
        <select
          id="account"
          value={account}
          onChange={(e) => setAccount(e.target.value as AccountId)}
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg"
        >
          <option value="manual_paper">manual_paper</option>
          <option
            value="live"
            disabled
            title="spread_management: False on live — enable in a future plan"
          >
            live (disabled)
          </option>
        </select>
      </div>

      <div>
        <label htmlFor="expiration" className="text-mid">Expiration</label>
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
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg"
        >
          <option value="">pick…</option>
          {expirations.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="short-strike" className="text-mid">Short Strike</label>
        <select
          id="short-strike"
          value={shortStrike ?? ''}
          onChange={(e) => {
            setShortStrike(e.target.value ? Number(e.target.value) : null);
            setLongStrike(null);
            setLimitCredit(0);
          }}
          disabled={!expiration}
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg"
        >
          <option value="">pick…</option>
          {strikesAtExpiry.map((c) => (
            <option key={c.strike} value={c.strike}>
              ${c.strike.toFixed(2)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="long-strike" className="text-mid">Long Strike</label>
        <select
          id="long-strike"
          value={longStrike ?? ''}
          onChange={(e) => {
            setLongStrike(e.target.value ? Number(e.target.value) : null);
            setLimitCredit(0);
          }}
          disabled={shortStrike == null}
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg"
        >
          <option value="">pick…</option>
          {longStrikeOptions.map((c) => (
            <option key={c.strike} value={c.strike}>
              ${c.strike.toFixed(2)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="qty" className="text-mid">Qty (spreads)</label>
        <input
          id="qty"
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg w-20"
        />
      </div>

      <div>
        <label htmlFor="limit-credit" className="text-mid">Limit Credit ($)</label>
        <input
          id="limit-credit"
          type="number"
          step={0.01}
          value={limitCredit}
          onChange={(e) => setLimitCredit(Number(e.target.value))}
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg w-24"
        />
      </div>

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

      <div>
        <label htmlFor="grade" className="text-mid">Entry Grade</label>
        <select
          id="grade"
          value={grade}
          onChange={(e) => setGrade(e.target.value as GradeLetter)}
          className="ml-2 bg-panel-2 border border-border px-2 py-1 text-fg"
        >
          {GRADE_LETTERS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="reasoning" className="text-mid block">Reasoning</label>
        <textarea
          id="reasoning"
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          rows={3}
          className="w-full mt-1 bg-panel-2 border border-border px-2 py-1 text-fg"
        />
      </div>

      <button
        onClick={handleReview}
        disabled={submitting}
        className="border border-border px-3 py-1 text-fg hover:bg-mid/10"
      >
        {submitting ? 'reviewing…' : 'Review'}
      </button>
    </div>
  );
}
