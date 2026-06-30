// dashboard/src/components/order/StockOrderForm.tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import { fmtUsd } from '../../lib/format';
import type { GradeLetter, RuleWarning, StockSide, OrderType, Tif } from '../../lib/trade-types';
import { AccountBpIndicator } from './AccountBpIndicator';
import PayoffChart from './PayoffChart';
import FillHint from './FillHint';
import CashSummary from './CashSummary';
import type { Leg } from '../../lib/payoff';
import { accountToMode, type Mode } from '../../lib/account-utils';

type StockAccount = 'manual_paper' | 'live';

interface Props {
  symbol: string;
  account: StockAccount;
  setAccount: (a: StockAccount) => void;
  onReview: (preview: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any }) => void;
}

export function StockOrderForm({ symbol, account, setAccount, onReview }: Props) {
  const [side, setSide] = useState<StockSide>('buy');
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [qty, setQty] = useState(10);
  const [limitPrice, setLimitPrice] = useState<number | ''>('');
  const [stopPrice, setStopPrice] = useState<number | ''>('');
  const [trailPct, setTrailPct] = useState<number | ''>('');
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
    queryKey: ['quote', symbol, mode],
    queryFn: () => api<{ snapshot: any }>(`/api/alpaca/quote?symbol=${symbol}&mode=${mode}`),
    refetchInterval: 5_000,
  });
  const lq = quote?.snapshot?.[symbol]?.latestQuote ?? quote?.snapshot?.snapshots?.[symbol]?.latestQuote;
  const last = lq?.lp ?? lq?.ap ?? 0;
  const ask = lq?.ap ?? 0;
  const bid = lq?.bp ?? 0;

  // Default the limit price once the quote arrives.
  useEffect(() => {
    if (orderType === 'limit' && limitPrice === '' && last) setLimitPrice(Number(last.toFixed(2)));
  }, [last, orderType, limitPrice]);

  // Live exposure for the BP indicator. Buys draw on BP (qty × limit/last);
  // sells close existing exposure, no new BP draw. Sell-short would draw a
  // margin requirement, but the bot doesn't short stocks so it's a 0 here.
  const liveExposure = useMemo(() => {
    if (side !== 'buy') return 0;
    const px = limitPrice === '' ? last : Number(limitPrice);
    return (px || 0) * qty;
  }, [side, qty, limitPrice, last]);

  const draft = useMemo(() => ({
    account,
    asset_class: 'stock' as const,
    symbol,
    side,
    qty,
    order_type: orderType,
    limit_price: limitPrice === '' ? null : Number(limitPrice),
    stop_price: stopPrice === '' ? null : Number(stopPrice),
    trail_pct: trailPct === '' ? null : Number(trailPct),
    tif,
    entry_grade: grade ?? '',
    entry_reasoning: reasoning,
    tags,
  }), [account, symbol, side, qty, orderType, limitPrice, stopPrice, trailPct, tif, grade, reasoning, tags]);

  async function review() {
    setPreviewing(true); setError(null);
    try {
      const res = await api<{ exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; validation_errors: string[] }>(
        '/api/trades/preview',
        { method: 'POST', body: JSON.stringify(draft) }
      );
      if (res.validation_errors?.length) {
        setError(`fix: ${res.validation_errors.join(', ')}`);
        return;
      }
      onReview({ ...res, draft });
    } catch (e: any) {
      setError(e.message ?? 'preview failed.');
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* page header with live quote */}
      <div className="mb-4">
        <h1 className="text-[18px] font-bold text-hi">Order — {symbol}</h1>
        <div className="text-mid text-[10px] mb-2">// stock · {account}</div>
        <div className="flex justify-between flex-wrap gap-2 pb-2 border-b border-dashed border-border text-[12px]">
          <span className="text-mid">
            {last
              ? <>{`last `}<span className="text-fg">{fmtUsd(last)}</span>{` · bid `}{fmtUsd(bid)}{` · ask `}{fmtUsd(ask)}</>
              : <span className="text-dim">loading quote…</span>}
          </span>
          <PositionLine symbol={symbol} mode={mode} />
        </div>
      </div>

      {/* account selector */}
      <Section label="━━━ account ─────────">
        <div className="flex gap-1 flex-wrap">
          <button type="button" className={`pbtn max-md:min-h-[44px] ${account === 'manual_paper' ? 'active' : ''}`} onClick={() => setAccount('manual_paper')}>
            [manual_paper{account === 'manual_paper' ? '*' : ''}]
          </button>
          <button
            type="button"
            className={`pbtn max-md:min-h-[44px] ${account === 'live' ? 'active' : ''} text-red`}
            onClick={() => setAccount('live')}
            title="LIVE — real money. Orders above per-account threshold require TOTP."
          >
            [live ${account === 'live' ? '*' : ''}]
          </button>
        </div>
        <AccountBpIndicator mode={mode} assetClass="stock" exposure={liveExposure} />
      </Section>

      <Section label="━━━ side ──────────────">
        <div className="flex gap-1">
          {(['buy', 'sell', 'sell_short'] as StockSide[]).map((s) => (
            <button key={s} type="button" className={`pbtn max-md:min-h-[44px] ${side === s ? 'active' : ''}`} onClick={() => setSide(s)}>
              [{s}{side === s ? '*' : ''}]
            </button>
          ))}
        </div>
      </Section>

      <Section label="━━━ type ──────────────">
        <div className="flex gap-1 flex-wrap">
          {(['limit', 'market', 'stop', 'stop_limit', 'trailing'] as OrderType[]).map((t) => (
            <button key={t} type="button" className={`pbtn max-md:min-h-[44px] ${orderType === t ? 'active' : ''}`} onClick={() => setOrderType(t)}>
              [{t}{orderType === t ? '*' : ''}]
            </button>
          ))}
        </div>
      </Section>

      <Section label="━━━ size & price ──────">
        <Row label="qty">
          <NumInput value={qty} onChange={(n) => setQty(n === '' ? 0 : n)} />
        </Row>
        {(orderType === 'limit' || orderType === 'stop_limit') && (
          <>
            {bid > 0 && ask > 0 && (
              <FillHint
                side={side === 'buy' ? 'buy' : 'sell'}
                bid={bid}
                ask={ask}
                last={last || undefined}
                onPick={(p) => setLimitPrice(p)}
              />
            )}
            <Row label="limit price"><NumInput value={limitPrice} onChange={setLimitPrice} step={0.01} /></Row>
          </>
        )}
        {(orderType === 'stop' || orderType === 'stop_limit') && (
          <Row label="stop price"><NumInput value={stopPrice} onChange={setStopPrice} step={0.01} /></Row>
        )}
        {orderType === 'trailing' && (
          <Row label="trail %"><NumInput value={trailPct} onChange={setTrailPct} step={0.1} /></Row>
        )}
        <Row label="tif">
          <div className="flex gap-1">
            {(['day', 'gtc'] as Tif[]).map((t) => (
              <button key={t} type="button" className={`pbtn max-md:min-h-[44px] ${tif === t ? 'active' : ''}`} onClick={() => setTif(t)}>
                [{t}{tif === t ? '*' : ''}]
              </button>
            ))}
          </div>
        </Row>
      </Section>

      {/* payoff chart — buy/sell_short only; sell (closing) shows a note */}
      {side === 'sell' ? (
        <div className="text-dim text-[11px] italic">payoff diagram n/a for a position-closing sell</div>
      ) : (() => {
        const px = limitPrice !== '' ? Number(limitPrice) : (ask + bid) / 2 || last || 0;
        const q = qty || 0;
        if (!px || !q) return null;
        const leg: Leg = { kind: 'stock', dir: side === 'buy' ? 'long' : 'short', entry: px, shares: q };
        const liveLast = last || (ask + bid) / 2 || px;
        return <PayoffChart legs={[leg]} currentPrice={liveLast} />;
      })()}

      <Section label="━━━ entry grade ───────">
        <GradePicker value={grade} onChange={setGrade} />
      </Section>

      <Section label="━━━ reasoning (required) ──">
        <textarea
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          rows={3}
          className="w-full bg-panel-2 border border-border px-2 py-1 text-fg text-[12px]"
          placeholder="why are you taking this trade?"
        />
      </Section>

      <Section label="━━━ tags ──────────────">
        <TagPicker value={tags} onChange={setTags} />
      </Section>

      {(() => {
        const px = limitPrice !== '' ? Number(limitPrice) : (ask + bid) / 2 || last || 0;
        const notional = (px || 0) * (qty || 0);
        if (notional <= 0) return null;
        // Buy → cash leaves (debit), cash account locks the notional as collateral.
        // Sell (closing) → cash enters (credit), no new collateral.
        const direction = side === 'buy' ? 'debit' : 'credit';
        const collateral = side === 'buy' ? notional : 0;
        return <CashSummary direction={direction} amount={notional} collateral={collateral} />;
      })()}

      <div className="pt-3 border-t border-dashed border-border flex justify-between items-center">
        <span className="text-mid text-[12px]">
          last <span className="text-fg">{fmtUsd(last)}</span> · bid {fmtUsd(bid)} · ask {fmtUsd(ask)}
        </span>
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-dim text-[10px] tracking-[0.25em] mb-2">{label}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 md:flex-row md:justify-between md:items-center py-1 md:gap-3">
      <span className="text-mid text-[12px]">{label}</span>
      <span>{children}</span>
    </div>
  );
}
function NumInput({ value, onChange, step = 1 }: { value: number | ''; onChange: (n: number | '') => void; step?: number }) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-full md:w-28 text-right max-md:min-h-[44px]"
    />
  );
}

function PositionLine({ symbol, mode }: { symbol: string; mode: Mode }) {
  const { data } = useQuery({
    queryKey: ['positions', mode],
    queryFn: () => api<{ positions: Array<{ symbol: string; qty: string; avg_entry_price: string }> }>(`/api/alpaca/positions?mode=${mode}`),
    staleTime: 30_000,
  });
  const pos = data?.positions.find((p) => p.symbol === symbol);
  if (!pos) return <span className="text-mid">you hold: <span className="text-dim">— no position</span></span>;
  return <span className="text-mid">you hold: <span className="text-hi">{Number(pos.qty)} sh @ {fmtUsd(Number(pos.avg_entry_price))}</span></span>;
}
