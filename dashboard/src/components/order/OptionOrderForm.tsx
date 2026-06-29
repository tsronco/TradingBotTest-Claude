// dashboard/src/components/order/OptionOrderForm.tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import { fmtUsd } from '../../lib/format';
import { parseOptionSymbol } from '../../lib/option-symbol';
import type { GradeLetter, OptionSide, OrderType, Tif, RuleWarning } from '../../lib/trade-types';
import { GREEK_DEFS } from '../GreekLabel';
import { AccountBpIndicator } from './AccountBpIndicator';
import PayoffChart from './PayoffChart';
import FillHint from './FillHint';
import CashSummary from './CashSummary';
import type { Leg } from '../../lib/payoff';
import { accountToMode, type Mode } from '../../lib/account-utils';

type OptionAccount = 'manual_paper' | 'live';

interface Props {
  contractSymbol: string;
  action: 'open' | 'close';
  account: OptionAccount;
  setAccount: (a: OptionAccount) => void;
  onReview: (p: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any }) => void;
  /** Pre-select side when arriving from a chain price click (bid→STO, ask→BTO). */
  initialSide?: OptionSide | null;
  /** Pre-fill limit price when arriving from a chain price click. */
  initialPrice?: number | null;
}

export function OptionOrderForm({ contractSymbol, action, account, setAccount, onReview, initialSide, initialPrice }: Props) {
  const parsed = parseOptionSymbol(contractSymbol);
  if (!parsed) return <div className="text-red">invalid contract symbol.</div>;

  const sideOptions: OptionSide[] = action === 'open' ? ['BTO', 'STO'] : ['BTC', 'STC'];
  const defaultSide: OptionSide = initialSide && sideOptions.includes(initialSide) ? initialSide : sideOptions[1];
  const [side, setSide] = useState<OptionSide>(defaultSide); // default STO/STC for wheel use; overridable from chain click
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState<number | ''>(
    initialPrice != null && Number.isFinite(initialPrice) && initialPrice > 0 ? Number(initialPrice.toFixed(2)) : ''
  );
  const [tif, setTif] = useState<Tif>('day');
  const [grade, setGrade] = useState<GradeLetter | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single source of truth — mirrors api/_lib/rule-check.ts accountToMode().
  // Quotes/BP/positions must hit the SELECTED account (incl. live), not the wrong account.
  const mode: Mode = accountToMode(account);
  const { data: quote } = useQuery({
    queryKey: ['option-quote', contractSymbol, mode],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${contractSymbol}&mode=${mode}&kind=option`),
    refetchInterval: 5_000,
  });
  const greeks = quote?.snapshot?.snapshots?.[contractSymbol]?.greeks;
  const lq = quote?.snapshot?.snapshots?.[contractSymbol]?.latestQuote;
  const ask = lq?.ap ?? 0;
  const bid = lq?.bp ?? 0;
  useEffect(() => {
    if (orderType === 'limit' && limitPrice === '' && (ask || bid)) {
      setLimitPrice(Number(((ask + bid) / 2 || ask || bid).toFixed(2)));
    }
  }, [ask, bid, orderType, limitPrice]);

  // Live exposure preview for the BP indicator. For short opens, the
  // collateral is strike × 100 × qty (cash-secured puts / cash-secured calls).
  // For long opens, cost is premium × 100 × qty. Closes don't draw new BP.
  const liveExposure = useMemo(() => {
    if (side === 'STC' || side === 'BTC') return 0;
    if (side === 'STO') return parsed.strike * 100 * qty;
    if (side === 'BTO') {
      const px = limitPrice === '' ? (ask || bid) : Number(limitPrice);
      return (px || 0) * 100 * qty;
    }
    return 0;
  }, [side, parsed.strike, qty, limitPrice, ask, bid]);

  const draft = useMemo(() => ({
    account,
    asset_class: 'option' as const,
    symbol: parsed.underlying,
    contract_symbol: contractSymbol,
    strike: parsed.strike,
    expiration: parsed.expiration,
    contract_type: parsed.type,
    side,
    qty,
    order_type: orderType,
    limit_price: limitPrice === '' ? null : Number(limitPrice),
    tif,
    entry_grade: grade ?? '',
    entry_reasoning: reasoning,
    tags,
  }), [account, contractSymbol, parsed, side, qty, orderType, limitPrice, tif, grade, reasoning, tags]);

  async function review() {
    setPreviewing(true); setError(null);
    try {
      const res = await api<{ exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; validation_errors: string[] }>(
        '/api/trades/preview',
        { method: 'POST', body: JSON.stringify(draft) }
      );
      if (res.validation_errors?.length) { setError(`fix: ${res.validation_errors.join(', ')}`); return; }
      onReview({ ...res, draft });
    } catch (e: any) {
      setError(e.message ?? 'preview failed.');
    } finally { setPreviewing(false); }
  }

  return (
    <div className="space-y-5">
      {/* page header with live quote */}
      <div className="mb-4">
        <h1 className="text-[18px] font-bold text-hi">
          {action === 'close' ? 'Close' : 'Order'} — {parsed.underlying}{' '}
          <span className={parsed.type === 'put' ? 'text-red' : 'text-cyan'}>{parsed.type.toUpperCase()}</span>{' '}
          ${parsed.strike} {parsed.expiration}
        </h1>
        <div className="text-mid text-[10px] mb-2">
          // option · {action === 'close' ? 'closing existing position' : 'opening'} · {account}
        </div>
        <div className="flex justify-between flex-wrap gap-2 pb-2 border-b border-dashed border-border text-[12px]">
          <span className="text-mid">
            {(ask || bid)
              ? <>{`bid `}<span className="text-fg">{fmtUsd(bid)}</span>{` · ask `}<span className="text-fg">{fmtUsd(ask)}</span></>
              : <span className="text-dim">loading quote…</span>}
          </span>
          <span className="text-mid"><OptionPositionLine contractSymbol={contractSymbol} mode={mode} bid={bid} ask={ask} /></span>
        </div>
      </div>

      {/* account selector */}
      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ account ─────────</div>
        <div className="flex gap-1 flex-wrap">
          <button type="button" className={`pbtn ${account === 'manual_paper' ? 'active' : ''}`} onClick={() => setAccount('manual_paper')}>
            [manual_paper{account === 'manual_paper' ? '*' : ''}]
          </button>
          <button
            type="button"
            className={`pbtn ${account === 'live' ? 'active' : ''} text-red`}
            onClick={() => setAccount('live')}
            title="LIVE — real money. Orders above per-account threshold require TOTP."
          >
            [live ${account === 'live' ? '*' : ''}]
          </button>
        </div>
        <AccountBpIndicator mode={mode} assetClass="option" exposure={liveExposure} />
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ greeks (auto-snapshot at submit) ──</div>
        <div className="text-[10px] tnum flex gap-3 flex-wrap">
          <span title={GREEK_DEFS.delta.tooltip} className="cursor-help">
            <span className="text-mid">Δ</span> <span className="text-cyan">{greeks?.delta?.toFixed(2) ?? '—'}</span>
            <span className="text-dim/70 text-[8px] ml-1">delta</span>
          </span>
          <span title={GREEK_DEFS.gamma.tooltip} className="cursor-help">
            <span className="text-mid">Γ</span> <span className="text-fg">{greeks?.gamma?.toFixed(3) ?? '—'}</span>
            <span className="text-dim/70 text-[8px] ml-1">gamma</span>
          </span>
          <span title={GREEK_DEFS.theta.tooltip} className="cursor-help">
            <span className="text-mid">Θ</span> <span className="text-red">{greeks?.theta?.toFixed(2) ?? '—'}</span>
            <span className="text-dim/70 text-[8px] ml-1">theta</span>
          </span>
          <span title={GREEK_DEFS.vega.tooltip} className="cursor-help">
            <span className="text-mid">ν</span> <span className="text-fg">{greeks?.vega?.toFixed(2) ?? '—'}</span>
            <span className="text-dim/70 text-[8px] ml-1">vega</span>
          </span>
          <span title={GREEK_DEFS.iv.tooltip} className="cursor-help">
            <span className="text-mid">IV</span> <span className="text-fg">{greeks?.implied_volatility ? (greeks.implied_volatility * 100).toFixed(0) + '%' : '—'}</span>
          </span>
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ side ──────────────</div>
        <div className="flex gap-1">
          {sideOptions.map((s) => (
            <button key={s} type="button" className={`pbtn ${side === s ? 'active' : ''}`} onClick={() => setSide(s)}>
              [{s}{side === s ? '*' : ''}]
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ type ──────────────</div>
        <div className="flex gap-1">
          {(['limit', 'market'] as OrderType[]).map((t) => (
            <button key={t} type="button" className={`pbtn ${orderType === t ? 'active' : ''}`} onClick={() => setOrderType(t)}>
              [{t}{orderType === t ? '*' : ''}]
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ size & price ──────</div>
        <div className="flex flex-col gap-1 md:flex-row md:justify-between md:items-center py-1 md:gap-3">
          <span className="text-mid text-[12px]">contracts</span>
          <input type="number" step={1} min={1} value={qty}
                 onChange={(e) => setQty(Number(e.target.value))}
                 className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-full md:w-28 text-right max-md:min-h-[44px]" />
        </div>
        {orderType === 'limit' && (
          <>
            {bid > 0 && ask > 0 && (
              <FillHint
                side={(side === 'STO' || side === 'STC') ? 'sell' : 'buy'}
                bid={bid}
                ask={ask}
                onPick={(p) => setLimitPrice(p)}
              />
            )}
            <div className="flex flex-col gap-1 md:flex-row md:justify-between md:items-center py-1 md:gap-3">
              <span className="text-mid text-[12px]">limit price</span>
              <input type="number" step={0.01} value={limitPrice}
                     onChange={(e) => setLimitPrice(e.target.value === '' ? '' : Number(e.target.value))}
                     className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-full md:w-28 text-right max-md:min-h-[44px]" />
            </div>
          </>
        )}
        <div className="flex flex-col gap-1 md:flex-row md:justify-between md:items-center py-1 md:gap-3">
          <span className="text-mid text-[12px]">tif</span>
          <div className="flex gap-1">
            {(['day', 'gtc'] as Tif[]).map((t) => (
              <button key={t} type="button" className={`pbtn max-md:min-h-[44px] ${tif === t ? 'active' : ''}`} onClick={() => setTif(t)}>
                [{t}{tif === t ? '*' : ''}]
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* payoff chart */}
      {(() => {
        const px = limitPrice !== '' ? Number(limitPrice) : (ask + bid) / 2 || 0;
        const q = qty || 0;
        if (!px || !q) return null;
        // STO / STC = short; BTO / BTC = long
        const dir: 'long' | 'short' = (side === 'STO' || side === 'STC') ? 'short' : 'long';
        const leg: Leg = {
          kind: 'option',
          dir,
          type: parsed.type,
          strike: parsed.strike,
          premium: px,
          contracts: q,
        };
        const liveMid = (ask + bid) / 2 || ask || bid || parsed.strike;
        return <PayoffChart legs={[leg]} currentPrice={liveMid} />;
      })()}

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ entry grade ───────</div>
        <GradePicker value={grade} onChange={setGrade} />
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ reasoning (required) ──</div>
        <textarea value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={3}
                  className="w-full bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
                  placeholder="why are you taking this trade?" />
      </div>

      <div>
        <div className="text-dim text-[10px] tracking-[0.25em] mb-2">━━━ tags ──────────────</div>
        <TagPicker value={tags} onChange={setTags} />
      </div>

      {(() => {
        const px = limitPrice !== '' ? Number(limitPrice) : (ask + bid) / 2 || 0;
        const q = qty || 0;
        if (!px || !q) return null;
        const premium = px * 100 * q;
        // BTO/BTC = cash leaves (debit). STO/STC = cash enters (credit).
        const isDebit = side === 'BTO' || side === 'BTC';
        const direction: 'debit' | 'credit' = isDebit ? 'debit' : 'credit';
        // Collateral: STO short put/call → strike × 100 × qty (matches existing
        // exposure calc; user covers from cash for CSP, or holds shares for CC
        // but the form can't tell so we show the cash equivalent). Long opens
        // and any close → no new collateral.
        const collateral = side === 'STO' ? parsed.strike * 100 * q : 0;
        return <CashSummary direction={direction} amount={premium} collateral={collateral} />;
      })()}

      <div className="pt-3 border-t border-dashed border-border flex justify-between items-center">
        <span className="text-mid text-[12px]">bid {fmtUsd(bid)} · ask {fmtUsd(ask)}</span>
        <div className="flex gap-2">
          <a href="/orders" className="pbtn max-md:min-h-[44px]">[cancel]</a>
          <button type="button" className="pbtn max-md:min-h-[44px] active" disabled={previewing} onClick={review}>
            [{previewing ? 'previewing…' : 'review*'}]
          </button>
        </div>
      </div>
      {error && <div className="text-red text-[10px]">{error}</div>}
    </div>
  );
}

function OptionPositionLine({ contractSymbol, mode, bid, ask }: { contractSymbol: string; mode: Mode; bid: number; ask: number }) {
  const { data } = useQuery({
    queryKey: ['positions', mode],
    queryFn: () => api<{ positions: Array<{ symbol: string; qty: string; avg_entry_price: string }> }>(`/api/alpaca/positions?mode=${mode}`),
    staleTime: 30_000,
  });
  const pos = data?.positions.find((p) => p.symbol === contractSymbol);
  if (!pos) return <span className="text-dim">— no position</span>;
  const qty = Number(pos.qty);
  const entry = Number(pos.avg_entry_price);
  const mid = (bid + ask) / 2 || ask || bid;
  const isShort = qty < 0;
  const profitPct = isShort && entry > 0 ? ((entry - mid) / entry) * 100 : null;
  const profitColor = profitPct === null ? '' : profitPct >= 0 ? 'text-cyan' : 'text-red';
  return (
    <span>
      you hold: <span className="text-hi">{qty} @ {fmtUsd(entry)}</span>
      {profitPct !== null && (
        <span className={`ml-1 ${profitColor}`}>({profitPct >= 0 ? '+' : ''}{profitPct.toFixed(1)}%)</span>
      )}
    </span>
  );
}
