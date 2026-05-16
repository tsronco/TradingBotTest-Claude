import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import MonthGrid from '../components/calendar/MonthGrid';
import DayDrawer from '../components/calendar/DayDrawer';
import { ALL_ACCOUNTS } from '../lib/account-utils';

interface DayBucket {
  realized_pnl: number;
  trade_count: number;
  closed_trade_ids: string[];
  open_options_expiring: Array<{ trade_id: string; symbol: string; option_type: 'put' | 'call'; strike: number }>;
}

const ACCOUNTS = ['', ...ALL_ACCOUNTS] as const;
const ASSET_CLASSES = ['', 'stock', 'option'] as const;

export default function Calendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [account, setAccount] = useState<string>('');
  const [symbolFilter, setSymbolFilter] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [assetClass, setAssetClass] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const params = new URLSearchParams({ action: 'calendar', month: monthStr });
  if (account) params.set('account', account);
  if (symbolFilter) params.set('symbol', symbolFilter.toUpperCase());
  if (tag) params.set('tag', tag);
  if (assetClass) params.set('asset_class', assetClass);

  const q = useQuery({
    queryKey: ['calendar', monthStr, account, symbolFilter, tag, assetClass],
    queryFn: () => api<{ days: Record<string, DayBucket>; month_total: number }>(`/api/trades/calendar?${params}`),
  });

  function prevMonth() {
    if (month === 1) { setYear((y) => y - 1); setMonth(12); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setYear((y) => y + 1); setMonth(1); }
    else setMonth((m) => m + 1);
  }

  const inputCls = 'bg-panel-2 border border-border focus:border-cyan rounded-sm px-2 py-1 text-fg text-[11px] outline-none';
  const selected = selectedDate ? q.data?.days[selectedDate] : null;

  return (
    <div className="p-3 md:p-6 max-w-6xl">
      <div className="text-mid text-[12px] mb-4">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/calendar</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">show {monthStr}</span>
      </div>
      <div className="flex justify-between items-center mb-3">
        <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi">Calendar</h1>
        <div className="flex items-center gap-2 text-[11px]">
          <button type="button" onClick={prevMonth} className="pbtn">[‹]</button>
          <span className="font-mono text-fg w-20 text-center">{monthStr}</span>
          <button type="button" onClick={nextMonth} className="pbtn">[›]</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-4 text-[11px]">
        <label className="flex items-center gap-1 text-dim">
          <span className="uppercase tracking-[0.15em]">account</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)} className={inputCls}>
            {ACCOUNTS.map((a) => <option key={a || 'all'} value={a}>{a || 'all'}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-dim">
          <span className="uppercase tracking-[0.15em]">symbol</span>
          <input value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())} className={`${inputCls} w-20`} />
        </label>
        <label className="flex items-center gap-1 text-dim">
          <span className="uppercase tracking-[0.15em]">tag</span>
          <input value={tag} onChange={(e) => setTag(e.target.value)} className={`${inputCls} w-24`} />
        </label>
        <label className="flex items-center gap-1 text-dim">
          <span className="uppercase tracking-[0.15em]">class</span>
          <select value={assetClass} onChange={(e) => setAssetClass(e.target.value)} className={inputCls}>
            {ASSET_CLASSES.map((a) => <option key={a || 'all'} value={a}>{a || 'all'}</option>)}
          </select>
        </label>
      </div>

      {q.isLoading
        ? <div className="text-dim text-[11px]">loading…</div>
        : q.data && (
            <MonthGrid
              year={year} month={month}
              days={q.data.days}
              monthTotal={q.data.month_total}
              onDayClick={setSelectedDate}
            />
          )
      }

      <DayDrawer
        date={selectedDate}
        closedTradeIds={selected?.closed_trade_ids ?? []}
        expiring={selected?.open_options_expiring ?? []}
        onClose={() => setSelectedDate(null)}
      />
    </div>
  );
}
