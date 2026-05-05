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

interface Props {
  contractSymbol: string;
  action: 'open' | 'close';
  account: 'conservative_paper' | 'aggressive_paper' | 'live';
  setAccount: (a: 'conservative_paper' | 'aggressive_paper' | 'live') => void;
  onReview: (p: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any }) => void;
}

export function OptionOrderForm({ contractSymbol, action, account, setAccount, onReview }: Props) {
  const parsed = parseOptionSymbol(contractSymbol);
  if (!parsed) return <div className="text-red">invalid contract symbol.</div>;

  const sideOptions: OptionSide[] = action === 'open' ? ['BTO', 'STO'] : ['BTC', 'STC'];
  const [side, setSide] = useState<OptionSide>(sideOptions[1]); // default STO/STC for wheel use
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState<number | ''>('');
  const [tif, setTif] = useState<Tif>('day');
  const [grade, setGrade] = useState<GradeLetter | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = account === 'aggressive_paper' ? 'aggressive' : 'conservative' as 'aggressive' | 'conservative';
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
          <button type="button" className={`pbtn ${account === 'conservative_paper' ? 'active' : ''}`} onClick={() => setAccount('conservative_paper')}>
            [conservative_paper{account === 'conservative_paper' ? '*' : ''}]
          </button>
          <button type="button" className={`pbtn ${account === 'aggressive_paper' ? 'active' : ''}`} onClick={() => setAccount('aggressive_paper')}>
            [aggressive_paper{account === 'aggressive_paper' ? '*' : ''}]
          </button>
          <button
            type="button"
            className="pbtn opacity-40 cursor-not-allowed"
            disabled
            title="live trading not enabled yet"
          >
            [live (disabled)]
          </button>
        </div>
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
        <div className="flex justify-between items-center py-1 gap-3">
          <span className="text-mid text-[12px]">contracts</span>
          <input type="number" step={1} min={1} value={qty}
                 onChange={(e) => setQty(Number(e.target.value))}
                 className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-28 text-right" />
        </div>
        {orderType === 'limit' && (
          <div className="flex justify-between items-center py-1 gap-3">
            <span className="text-mid text-[12px]">limit price</span>
            <input type="number" step={0.01} value={limitPrice}
                   onChange={(e) => setLimitPrice(e.target.value === '' ? '' : Number(e.target.value))}
                   className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-28 text-right" />
          </div>
        )}
        <div className="flex justify-between items-center py-1 gap-3">
          <span className="text-mid text-[12px]">tif</span>
          <div className="flex gap-1">
            {(['day', 'gtc'] as Tif[]).map((t) => (
              <button key={t} type="button" className={`pbtn ${tif === t ? 'active' : ''}`} onClick={() => setTif(t)}>
                [{t}{tif === t ? '*' : ''}]
              </button>
            ))}
          </div>
        </div>
      </div>

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

      <div className="pt-3 border-t border-dashed border-border flex justify-between items-center">
        <span className="text-mid text-[12px]">bid {fmtUsd(bid)} · ask {fmtUsd(ask)}</span>
        <div className="flex gap-2">
          <a href="/orders" className="pbtn">[cancel]</a>
          <button type="button" className="pbtn active" disabled={previewing} onClick={review}>
            [{previewing ? 'previewing…' : 'review*'}]
          </button>
        </div>
      </div>
      {error && <div className="text-red text-[10px]">{error}</div>}
    </div>
  );
}

function OptionPositionLine({ contractSymbol, mode, bid, ask }: { contractSymbol: string; mode: 'conservative' | 'aggressive'; bid: number; ask: number }) {
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
