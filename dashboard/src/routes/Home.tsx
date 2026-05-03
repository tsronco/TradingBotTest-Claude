import { useQuery } from '@tanstack/react-query';
import AccountCard from '../components/account/AccountCard';
import { api } from '../lib/api';
import { useAccount } from '../hooks/useAccount';
import { usePeriod, useGranularity, type Period } from '../hooks/usePeriod';
import { fmtUsd, fmtPct } from '../lib/format';

interface AcctResp { account: { equity: string; last_equity: string } }

function periodFlag(p: Period): string {
  return p === '1A' ? '1y' : p.toLowerCase();
}

export default function Home() {
  const [mode] = useAccount();
  const [period] = usePeriod();
  const [gran] = useGranularity();

  // Aggregate equity across both accounts (always pull both — filter is presentational only)
  const consQ = useQuery({
    queryKey: ['account', 'conservative'],
    queryFn: () => api<AcctResp>('/api/alpaca/account?mode=conservative'),
  });
  const aggQ = useQuery({
    queryKey: ['account', 'aggressive'],
    queryFn: () => api<AcctResp>('/api/alpaca/account?mode=aggressive'),
  });

  const consEq = consQ.data ? Number(consQ.data.account.equity) : 0;
  const aggEq = aggQ.data ? Number(aggQ.data.account.equity) : 0;
  const consLast = consQ.data ? Number(consQ.data.account.last_equity) : 0;
  const aggLast = aggQ.data ? Number(aggQ.data.account.last_equity) : 0;

  let total = 0, totalLast = 0;
  if (mode === 'conservative') { total = consEq; totalLast = consLast; }
  else if (mode === 'aggressive') { total = aggEq; totalLast = aggLast; }
  else { total = consEq + aggEq; totalLast = consLast + aggLast; }
  const dayChange = total - totalLast;
  const dayPct = totalLast ? (dayChange / totalLast) * 100 : 0;

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const isWeekend = today.getDay() === 0 || today.getDay() === 6;
  const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const cardCount = mode === 'both' ? 2 : 1;

  return (
    <div className="p-6 max-w-[1480px]">
      {/* prompt header */}
      <div className="flex items-baseline gap-2 mb-4 text-[12px] flex-wrap">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
        <span className="text-fg">portfolio</span>
        <span className="text-amber">--today</span>
        <span className="text-dim">
          --mode=<span className="text-fg">{mode}</span>{' '}
          --range=<span className="text-fg">{periodFlag(period)}</span>
          {period === '1D' && (
            <> --interval=<span className="text-fg">{gran}</span></>
          )}
        </span>
        <span className="caret" />
      </div>

      {/* title row */}
      <div className="flex flex-wrap items-end justify-between gap-y-3 gap-x-6 mb-5">
        <div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-hi text-[44px] font-bold leading-none tracking-tight">Today</h1>
            <span className="text-dim text-[12px]">// snapshot @ {today.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' })} ET</span>
          </div>
          <div className="mt-2 text-mid text-[12px]">
            <span className="text-dim">[</span>
            <span className="text-fg">{dateStr}</span>
            <span className="text-dim">]</span>
            {isWeekend && (
              <>
                <span className="text-dim mx-2">·</span>
                <span className="text-amber">{dayOfWeek}</span>
                <span className="text-dim"> — market closed; preview from previous session</span>
              </>
            )}
          </div>
        </div>

        {/* aggregate equity */}
        <div className="text-right">
          <div className="text-[10px] tracking-[0.3em] text-dim">{mode === 'both' ? 'TOTAL EQUITY' : 'EQUITY'}</div>
          <div className="text-hi text-[26px] font-bold tnum leading-none">{fmtUsd(total)}</div>
          <div className="text-[11px] mt-1 tnum">
            <span className={dayChange >= 0 ? 'text-hi' : 'text-red'}>
              {dayChange >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(dayChange), { sign: false }).replace('-$', '$')}
            </span>
            <span className="text-dim"> ({fmtPct(dayPct, { sign: true }).replace('-', '−')})</span>
          </div>
        </div>
      </div>

      {/* divider */}
      <div className="flex items-center gap-3 text-dim text-[11px] mb-5 select-none">
        <span className="whitespace-nowrap">━━━ accounts</span>
        <span className="text-mid">[{cardCount}]</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">$ pnl --range <span className="text-fg">{periodFlag(period)}</span></span>
      </div>

      {/* account cards */}
      <div id="cards" data-mode={mode} className="grid gap-5" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <AccountCard mode="conservative" label="Conservative" acctKey="CONS" />
        <AccountCard mode="aggressive" label="Aggressive" acctKey="AGG" />
      </div>

      {/* footer ribbon */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>

      {/* bottom prompt */}
      <div className="mt-4 text-[12px]">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}
