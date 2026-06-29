import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import EquityChart, { formatHoverDate } from '../EquityChart';
import { usePeriod, useGranularity, alpacaPeriod, alpacaTimeframe, type Period, type Granularity } from '../../hooks/usePeriod';

const PERIODS: { value: Period; label: string }[] = [
  { value: '1D', label: '1D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '1A', label: '1Y' },
];

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
];

interface HistoryResp {
  history?: {
    timestamp?: number[];
    equity?: number[];
    profit_loss?: number[];
    profit_loss_pct?: number[];
    base_value?: number;
  };
}

interface CardProps {
  mode: 'manual' | 'live';
  label: string;
  /** acctKey — used for the data-acct-key attribute that drives the filter CSS. */
  acctKey: 'CONS' | 'AGG' | 'MAN' | 'LIVE' | 'SM500' | 'SM1K' | 'SM2K';
}

const STYLE_BY_KEY: Record<CardProps['acctKey'], {
  color: string; tag: string; tagText: string; flavor: string;
  textClass: string; bgClass: string;
}> = {
  CONS:  { color: '#22ff88', tag: 'ACCT::CONS', tagText: 'CONSERVATIVE', flavor: 'Conservative · wheel + trail',         textClass: 'text-hi',    bgClass: 'bg-hi' },
  AGG:   { color: '#ffb454', tag: 'ACCT::AGG ', tagText: 'AGGRESSIVE',   flavor: 'Aggressive · wheel + crypto',           textClass: 'text-amber', bgClass: 'bg-amber' },
  MAN:   { color: '#22ddff', tag: 'ACCT::MAN ', tagText: 'MANUAL',       flavor: 'Manual · user-driven, bot-managed',     textClass: 'text-cyan',  bgClass: 'bg-cyan' },
  LIVE:  { color: '#ef4444', tag: 'ACCT::LIVE', tagText: 'LIVE $',       flavor: 'LIVE · real money, user-driven',        textClass: 'text-red',   bgClass: 'bg-red' },
  SM500: { color: '#aaaaaa', tag: 'ACCT::SM5 ', tagText: '$500',          flavor: 'SM $500 · auto-spread, user-managed',   textClass: 'text-mid',   bgClass: 'bg-mid' },
  SM1K:  { color: '#aaaaaa', tag: 'ACCT::SM1K', tagText: '$1,000',        flavor: 'SM $1K · auto-spread, user-managed',    textClass: 'text-mid',   bgClass: 'bg-mid' },
  SM2K:  { color: '#aaaaaa', tag: 'ACCT::SM2K', tagText: '$2,000',        flavor: 'SM $2K · auto-spread, user-managed',    textClass: 'text-mid',   bgClass: 'bg-mid' },
};

export default function AccountCard({ mode, label, acctKey }: CardProps) {
  const [period] = usePeriod();
  const [gran] = useGranularity();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const style = STYLE_BY_KEY[acctKey];
  const { color, tag: acctTag, tagText, flavor } = style;

  const { data: acctData, isLoading: acctLoading, error: acctError } = useQuery({
    queryKey: ['account', mode],
    queryFn: () => api<{ account: Record<string, string> }>(`/api/alpaca/account?mode=${mode}`),
  });

  const histQ = useQuery({
    queryKey: ['equity-history', mode, period, gran],
    queryFn: () => {
      const p = alpacaPeriod(period);
      const tf = alpacaTimeframe(period, gran);
      return api<HistoryResp>(`/api/alpaca/equity-history?mode=${mode}&period=${p}&timeframe=${tf}`);
    },
    staleTime: 60_000,
  });

  if (acctLoading) {
    return (
      <article data-acct-key={acctKey} className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-dim text-[12px]">
        loading {label}…
      </article>
    );
  }
  if (acctError || !acctData) {
    return (
      <article data-acct-key={acctKey} className="relative border border-red bg-panel/60 rounded-sm min-w-0 mt-3 p-5 text-red text-[12px]">
        failed to load {label}
      </article>
    );
  }

  const a = acctData.account;
  const equity = Number(a.equity);
  const lastEquity = Number(a.last_equity);
  const dayChange = equity - lastEquity;
  const dayChangePct = lastEquity ? (dayChange / lastEquity) * 100 : 0;

  // History-derived series. Alpaca's hourly portfolio-history occasionally
  // returns single bad bars from intraday option mark-to-market glitches that
  // then propagate through subsequent bars (e.g. $200k value stuck for a week
  // when the account is really at $100k). For each contiguous run of bars
  // outside [0.5×, 1.5×] live equity, linearly interpolate between the last
  // good value before the run and the next good value after (or live equity
  // if the run extends to the end). Daily resolution rarely trips this;
  // hourly does. Result: chart's right edge always matches the live headline.
  const rawValues = histQ.data?.history?.equity ?? [];
  const timestamps = histQ.data?.history?.timestamp ?? [];
  const SANITY_HIGH = equity * 1.5;
  const SANITY_LOW = equity * 0.5;
  const isCorrupt = (v: number) => v > SANITY_HIGH || (v > 0 && v < SANITY_LOW);
  let smoothed = 0;
  const equityValues = (() => {
    const out = [...rawValues];
    let i = 0;
    while (i < out.length) {
      if (!isCorrupt(out[i])) { i++; continue; }
      let j = i;
      while (j < out.length && isCorrupt(out[j])) j++;
      const before = i > 0 && !isCorrupt(out[i - 1]) ? out[i - 1] : equity;
      const after = j < out.length && !isCorrupt(out[j]) ? out[j] : equity;
      const runLen = j - i;
      for (let k = 0; k < runLen; k++) {
        const t = (k + 1) / (runLen + 1);
        out[i + k] = before + (after - before) * t;
      }
      smoothed += runLen;
      i = j;
    }
    // Pin the very last point to the live equity so the chart's right edge
    // always matches the headline number even if the final bar(s) were corrupt.
    if (out.length > 0) out[out.length - 1] = equity;
    return out;
  })();
  // Alpaca pads pre-account-creation history with leading 0s. Trim them so
  // the chart starts at the account's first real bar rather than rising from
  // $0 (which would visually dominate the chart).
  const firstNonZero = equityValues.findIndex((v) => v > 0);
  const trimmedValues = firstNonZero >= 0 ? equityValues.slice(firstNonZero) : equityValues;
  const trimmedTimestamps = firstNonZero >= 0 ? timestamps.slice(firstNonZero) : timestamps;

  const periodStart = trimmedValues.length > 0 ? trimmedValues[0] : null;
  const periodChange = periodStart != null ? equity - periodStart : null;
  const periodChangePct = periodStart != null && periodStart > 0 ? ((equity - periodStart) / periodStart) * 100 : null;

  // Hover-aware display values (read from trimmed arrays so hover indices
  // line up with what's actually drawn on the chart). Hover delta is
  // bar-over-bar (this point - previous point), so e.g. hovering at May 1 on
  // a daily chart reads "Apr 29 → Apr 30" change, not period-start cumulative.
  const isHovering = hoverIdx != null && hoverIdx >= 0 && hoverIdx < trimmedValues.length;
  const displayEquity = isHovering ? trimmedValues[hoverIdx] : equity;
  const prevValue = isHovering && hoverIdx > 0 ? trimmedValues[hoverIdx - 1] : null;
  const displayDelta = isHovering
    ? (prevValue != null ? trimmedValues[hoverIdx] - prevValue : 0)
    : dayChange;
  const displayPct = isHovering
    ? (prevValue != null && prevValue > 0
        ? ((trimmedValues[hoverIdx] - prevValue) / prevValue) * 100
        : 0)
    : dayChangePct;
  const displayLabel = isHovering ? formatHoverDate(trimmedTimestamps, hoverIdx, period) : 'today';

  const arrow = displayDelta >= 0 ? '▲' : '▼';
  const sign = displayDelta >= 0 ? 'text-hi' : 'text-red';
  const colorAccent = style.textClass;

  return (
    <article data-acct-key={acctKey} className="relative border border-border bg-panel/60 rounded-sm min-w-0 mt-3" style={{ overflow: 'visible' }}>
      {/* ASCII corner ornament */}
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em] flex items-center gap-2 z-10">
        <span className="text-dim">┌──</span>
        <span className={colorAccent}>{tagText}</span>
        <span className="text-dim">──┐</span>
      </div>

      {/* card head */}
      <header className="px-5 pt-5 pb-3 flex flex-wrap items-start gap-4 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10px] tracking-[0.25em] text-dim">
            <span className={`w-2 h-2 pulse rounded-sm ${style.bgClass}`} />
            <span>{acctTag}</span>
            <span className="text-dim">·</span>
            <span className="text-mid">paper</span>
            <span className="text-dim">·</span>
            <span className="text-mid">{a.account_number || '—'}</span>
          </div>
          <div className="mt-1 text-fg text-[12px]">{flavor}</div>

          <div className="mt-3 flex items-baseline gap-3">
            <span className={`${colorAccent} text-[34px] font-bold tnum leading-none`}>{fmtUsd(displayEquity)}</span>
            <span className="text-[10px] tracking-[0.25em] text-dim">EQUITY</span>
          </div>

          <div className="mt-1.5 text-[12px] tnum">
            <span className="text-dim">{displayLabel}</span>{' '}
            <span className={sign}>{arrow}</span>{' '}
            <span className={sign}>{fmtUsd(displayDelta, { sign: false }).replace('-$', '−$')}</span>{' '}
            <span className="text-dim">(</span>
            <span className={sign}>{fmtPct(displayPct, { sign: true }).replace('-', '−')}</span>
            <span className="text-dim">)</span>
          </div>
        </div>

        {/* mini ascii sparkline + last px */}
        <MiniSparkline values={trimmedValues} colorClass={colorAccent} />
      </header>

      {/* period selector */}
      <div className="period-row px-5 pt-1 pb-2 flex items-center gap-1.5 text-[11px]">
        <span className="text-dim mr-1">period ::</span>
        {PERIODS.map((p) => (
          <PeriodButton key={p.value} value={p.value} label={p.label} />
        ))}
      </div>

      {/* granularity sub-selector — only for 1D */}
      {period === '1D' && (
        <div className="period-row px-5 pl-9 pt-0 pb-2 flex items-center gap-1.5 text-[11px]">
          <span className="text-dim mr-1">interval ::</span>
          {GRANULARITIES.map((g) => (
            <GranularityButton key={g.value} value={g.value} label={g.label} />
          ))}
        </div>
      )}

      {/* chart */}
      <div className="mx-5 mb-3 relative min-w-0">
        {histQ.isLoading ? (
          <div className="h-[180px] flex items-center justify-center text-dim text-[11px]">loading history…</div>
        ) : trimmedValues.length < 2 ? (
          <div className="h-[180px] flex items-center justify-center text-dim text-[11px]">no history available</div>
        ) : (
          <EquityChart
            values={trimmedValues}
            timestamps={trimmedTimestamps}
            period={period}
            granularity={gran}
            color={color}
            onHover={setHoverIdx}
          />
        )}
        <div className="px-2 pb-1 pt-1 flex items-center justify-between text-[10px] text-dim tnum">
          <span>{trimmedTimestamps.length > 0 ? formatHoverDate(trimmedTimestamps, 0, period).toLowerCase() : '—'}</span>
          <span className="text-mid">▌▌ <span>{periodLabel(period)}</span> ▐▐</span>
          <span>{trimmedTimestamps.length > 0 ? formatHoverDate(trimmedTimestamps, trimmedTimestamps.length - 1, period).toLowerCase() : '—'}</span>
        </div>
        {smoothed > 0 && (
          <div className="px-2 pb-1 text-[10px] text-dim flex items-center gap-1">
            <span className="text-amber">▼</span>
            <span>{smoothed} bar{smoothed === 1 ? '' : 's'} smoothed (Alpaca hourly mark-to-market anomaly suppressed)</span>
          </div>
        )}
      </div>

      {/* period change line */}
      <div className="px-5 pb-3 text-[12px] tnum flex items-center gap-2 flex-wrap">
        <span className="text-dim">[period]</span>
        {periodChange != null ? (
          <>
            <span className={periodChange >= 0 ? 'text-hi' : 'text-red'}>{periodChange >= 0 ? '▲' : '▼'}</span>
            <span className={`${periodChange >= 0 ? 'text-hi' : 'text-red'} font-bold`}>
              {fmtUsd(Math.abs(periodChange), { sign: false }).replace('-$', '$')}
            </span>
            <span className="text-dim">(</span>
            <span className={periodChange >= 0 ? 'text-hi' : 'text-red'}>
              {fmtPct(periodChangePct ?? 0, { sign: true }).replace('-', '−')}
            </span>
            <span className="text-dim">)</span>
          </>
        ) : (
          <span className="text-dim">—</span>
        )}
        <span className="ml-auto text-dim text-[10px]">via /api/equity-history</span>
      </div>

      {/* metrics divider */}
      <div className="px-5 text-dim select-none text-[10px] tnum metrics-rule">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span>├</span>
          <span className="flex-1 border-t border-dashed border-border min-w-0" />
          <span className="px-1 tracking-[0.25em]">METRICS</span>
          <span className="flex-1 border-t border-dashed border-border min-w-0" />
          <span>┤</span>
        </div>
      </div>

      {/* metrics grid — Options BP gets equal billing because the wheel only
          ever draws from it, and it's the number that actually gates new put
          sales (the regular Buying Power figure includes margin leverage that
          doesn't apply to short option collateral, so it overstates capacity). */}
      <div className="px-5 py-3 grid gap-3 text-[12px]" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
        <Metric label="Buying power" value={Number(a.buying_power)} />
        <Metric label="Options BP" value={Number(a.options_buying_power ?? a.buying_power)} />
        <Metric label="Cash" value={Number(a.cash)} />
        <Metric label="Long mkt value" value={Number(a.long_market_value)} />
        <Metric label="Short mkt value" value={Number(a.short_market_value)} />
      </div>

      {/* footer status */}
      <footer className="px-5 py-2 border-t border-border flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-dim min-w-0">
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-hi pulse" /> live</span>
        <span><span className="text-mid">strat</span> {acctKey === 'AGG' ? 'wheel·trail·crypto' : acctKey === 'MAN' ? 'manual·bot-mgr' : (acctKey === 'SM500' || acctKey === 'SM1K' || acctKey === 'SM2K') ? 'auto-spread·bot-mgr' : 'wheel·trail'}</span>
        <span className="ml-auto">updated {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' })} ET</span>
      </footer>
    </article>
  );
}

function periodLabel(p: Period): string {
  return p === '1A' ? '1Y' : p;
}

function PeriodButton({ value, label }: { value: Period; label: string }) {
  const [period, setPeriod] = usePeriod();
  const isActive = period === value;
  return (
    <button type="button" onClick={() => setPeriod(value)} className={`pbtn ${isActive ? 'active' : ''}`}>
      [{label}{isActive ? '*' : ''}]
    </button>
  );
}

function GranularityButton({ value, label }: { value: Granularity; label: string }) {
  const [gran, setGran] = useGranularity();
  const isActive = gran === value;
  return (
    <button type="button" onClick={() => setGran(value)} className={`pbtn ${isActive ? 'active' : ''}`}>
      [{label}{isActive ? '*' : ''}]
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-[0.2em] text-dim uppercase truncate">{label}</div>
      <div className="text-fg tnum mt-0.5">{fmtUsd(value)}</div>
    </div>
  );
}

function MiniSparkline({ values, colorClass }: { values: number[]; colorClass: string }) {
  if (values.length < 2) {
    return (
      <div className="text-right shrink-0">
        <div className="text-[10px] tracking-[0.25em] text-dim">▔▔ TICK</div>
        <div className={`${colorClass} text-[18px] tnum leading-none`}>—</div>
      </div>
    );
  }
  // Build a unicode block sparkline from ~16 sample points across the series.
  const blocks = '▁▂▃▄▅▆▇█';
  const samples = 16;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const out: string[] = [];
  for (let i = 0; i < samples; i++) {
    const idx = Math.floor((i / (samples - 1)) * (values.length - 1));
    const t = (values[idx] - min) / range;
    out.push(blocks[Math.min(blocks.length - 1, Math.floor(t * blocks.length))]);
  }
  const last = values[values.length - 1];
  return (
    <div className="text-right shrink-0">
      <div className="text-[10px] tracking-[0.25em] text-dim">▔▔ TICK</div>
      <div className={`${colorClass} text-[18px] tnum leading-none`}>{out.join('')}</div>
      <div className="text-[10px] text-mid mt-0.5">last <span className="text-fg tnum">{Math.round(last).toLocaleString()}</span></div>
    </div>
  );
}
