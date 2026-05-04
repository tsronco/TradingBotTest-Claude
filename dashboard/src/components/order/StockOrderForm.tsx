// dashboard/src/components/order/StockOrderForm.tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { GradePicker } from './GradePicker';
import { TagPicker } from './TagPicker';
import { fmtUsd } from '../../lib/format';
import type { GradeLetter, RuleWarning, StockSide, OrderType, Tif } from '../../lib/trade-types';

interface Props {
  symbol: string;
  account: 'conservative_paper' | 'aggressive_paper';
  onReview: (preview: { exposure: number; requires_totp: boolean; rule_warnings: RuleWarning[]; draft: any }) => void;
}

export function StockOrderForm({ symbol, account, onReview }: Props) {
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

  const mode = account === 'aggressive_paper' ? 'aggressive' : 'conservative';
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
      <Section label="━━━ side ──────────────">
        <div className="flex gap-1">
          {(['buy', 'sell', 'sell_short'] as StockSide[]).map((s) => (
            <button key={s} type="button" className={`pbtn ${side === s ? 'active' : ''}`} onClick={() => setSide(s)}>
              [{s}{side === s ? '*' : ''}]
            </button>
          ))}
        </div>
      </Section>

      <Section label="━━━ type ──────────────">
        <div className="flex gap-1 flex-wrap">
          {(['limit', 'market', 'stop', 'stop_limit', 'trailing'] as OrderType[]).map((t) => (
            <button key={t} type="button" className={`pbtn ${orderType === t ? 'active' : ''}`} onClick={() => setOrderType(t)}>
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
          <Row label="limit price"><NumInput value={limitPrice} onChange={setLimitPrice} step={0.01} /></Row>
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
              <button key={t} type="button" className={`pbtn ${tif === t ? 'active' : ''}`} onClick={() => setTif(t)}>
                [{t}{tif === t ? '*' : ''}]
              </button>
            ))}
          </div>
        </Row>
      </Section>

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

      <div className="pt-3 border-t border-dashed border-border flex justify-between items-center">
        <span className="text-mid text-[12px]">
          last <span className="text-fg">{fmtUsd(last)}</span> · bid {fmtUsd(bid)} · ask {fmtUsd(ask)}
        </span>
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
    <div className="flex justify-between items-center py-1 gap-3">
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
      className="bg-panel-2 border border-border px-2 py-0.5 text-fg text-[12px] tnum w-28 text-right"
    />
  );
}
