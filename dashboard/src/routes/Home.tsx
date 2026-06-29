import { useQuery } from '@tanstack/react-query';
import AccountCard from '../components/account/AccountCard';
import { api } from '../lib/api';
import { useAccount } from '../hooks/useAccount';
import { usePeriod, useGranularity, type Period } from '../hooks/usePeriod';
import { fmtUsd, fmtPct } from '../lib/format';
import { accountsForSelection, ALL_MODES } from '../lib/account-utils';
import type { Mode } from '../lib/account-utils';
import { useDisplayName } from '../hooks/useDisplayName';

interface AcctResp { account: { equity: string; last_equity: string } }

function periodFlag(p: Period): string {
  return p === '1A' ? '1y' : p.toLowerCase();
}

type HomeAcctKey = 'MAN' | 'LIVE';

const HOME_MODE_TO_CARD: Record<Mode, { acctKey: HomeAcctKey; label: string }> = {
  manual: { acctKey: 'MAN',  label: 'Manual' },
  live:   { acctKey: 'LIVE', label: 'Live $' },
};

export default function Home() {
  const [mode] = useAccount();
  const [period] = usePeriod();
  const { handle } = useDisplayName();
  const [gran] = useGranularity();

  // Aggregate equity across both accounts (always pull all — filter is presentational only)
  const manQ = useQuery({
    queryKey: ['account', 'manual'],
    queryFn: () => api<AcctResp>('/api/alpaca/account?mode=manual'),
  });
  const liveQ = useQuery({
    queryKey: ['account', 'live'],
    queryFn: () => api<AcctResp>('/api/alpaca/account?mode=live'),
  });

  const equityMap: Record<Mode, number> = {
    manual: manQ.data ? Number(manQ.data.account.equity) : 0,
    live:   liveQ.data ? Number(liveQ.data.account.equity) : 0,
  };
  const lastMap: Record<Mode, number> = {
    manual: manQ.data ? Number(manQ.data.account.last_equity) : 0,
    live:   liveQ.data ? Number(liveQ.data.account.last_equity) : 0,
  };

  const selectedModes = accountsForSelection(mode);
  const total = selectedModes.reduce((s, m2) => s + equityMap[m2], 0);
  const totalLast = selectedModes.reduce((s, m2) => s + lastMap[m2], 0);
  const dayChange = total - totalLast;
  const dayPct = totalLast ? (dayChange / totalLast) * 100 : 0;

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const isWeekend = today.getDay() === 0 || today.getDay() === 6;
  const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const cardCount = selectedModes.length;

  return (
    <div className="p-3 md:p-6 max-w-[1480px]">
      {/* prompt header */}
      <div className="flex items-baseline gap-2 mb-4 text-[12px] flex-wrap">
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>
        <span className="text-fg">portfolio</span>
        <span className="text-amber">--today</span>
        <span className="text-dim">
          --mode=<span className="text-fg">{cardCount === ALL_MODES.length ? 'all' : mode}</span>{' '}
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
            <h1 className="text-hi text-[28px] md:text-[44px] font-bold leading-none tracking-tight">Today</h1>
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
          <div className="text-[10px] tracking-[0.3em] text-dim">{cardCount > 1 ? 'TOTAL EQUITY' : 'EQUITY'}</div>
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
      <div id="cards" data-mode={mode} className="grid gap-5" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {selectedModes.map((m2) => {
          const { acctKey, label } = HOME_MODE_TO_CARD[m2];
          return <AccountCard key={m2} mode={m2} label={label} acctKey={acctKey} />;
        })}
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
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}
