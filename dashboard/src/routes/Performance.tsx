import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import EquityPanel from '../components/performance/EquityPanel';
import DrawdownPanel from '../components/performance/DrawdownPanel';
import CalibrationScatter from '../components/performance/CalibrationScatter';
import WinRateByTagBar from '../components/performance/WinRateByTagBar';
import PnLBySymbolTable from '../components/performance/PnLBySymbolTable';
import TimeHeatmap from '../components/performance/TimeHeatmap';
import { ALL_ACCOUNTS } from '../lib/account-utils';

const ACCOUNTS = ['', ...ALL_ACCOUNTS] as const;
const ASSET_CLASSES = ['', 'stock', 'option'] as const;
const DATE_RANGES = ['ALL', '1Y', '3M', '1M', '1W'] as const;

interface PerfData {
  cutoff: string;
  calibration: Array<{ trade_id: string; user_grade: number; ai_grade: number }>;
  win_rate_by_tag: Array<{ tag: string; trades: number; wins: number; total_pnl: number }>;
  pnl_by_symbol: Array<{ symbol: string; trades: number; wins: number; total_pnl: number; avg_grade: number }>;
  time_heatmap: Array<{ dow: number; hour: number; trades: number; win_rate: number }>;
}

export default function Performance() {
  const [account, setAccount] = useState('');
  const [tag, setTag] = useState('');
  const [assetClass, setAssetClass] = useState('');
  const [dateRange, setDateRange] = useState<typeof DATE_RANGES[number]>('ALL');

  const params = new URLSearchParams({ action: 'performance', date_range: dateRange });
  if (account) params.set('account', account);
  if (tag) params.set('tag', tag);
  if (assetClass) params.set('asset_class', assetClass);

  const q = useQuery({
    queryKey: ['performance', dateRange, account, tag, assetClass],
    queryFn: () => api<PerfData>(`/api/trades/performance?${params}`),
  });

  const inputCls = 'bg-panel-2 border border-border focus:border-cyan rounded-sm px-2 py-1 text-fg text-[11px] outline-none';

  return (
    <div className="p-3 md:p-6 max-w-6xl">
      <div className="text-mid text-[12px] mb-4">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/performance</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">stat --range={dateRange}</span>
      </div>
      <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi mt-2">Performance</h1>

      <div className="flex flex-wrap gap-2 mt-4 mb-4 text-[11px]">
        <label className="flex items-center gap-1 text-dim">
          <span className="uppercase tracking-[0.15em]">range</span>
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value as typeof DATE_RANGES[number])} className={inputCls}>
            {DATE_RANGES.map((r) => <option key={r} value={r}>{r === 'ALL' ? 'all' : r}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-dim">
          <span className="uppercase tracking-[0.15em]">account</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)} className={inputCls}>
            {ACCOUNTS.map((a) => <option key={a || 'all'} value={a}>{a || 'all'}</option>)}
          </select>
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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="Equity Curve"><EquityPanel dateRange={dateRange} account={account} /></Panel>
            <Panel title="Drawdown"><DrawdownPanel dateRange={dateRange} account={account} /></Panel>
            <Panel title="Grade Calibration"><CalibrationScatter data={q.data.calibration} /></Panel>
            <Panel title="Win Rate by Tag"><WinRateByTagBar data={q.data.win_rate_by_tag} /></Panel>
            <Panel title="P&L by Symbol" wide><PnLBySymbolTable data={q.data.pnl_by_symbol} /></Panel>
            <Panel title="Time-of-day Heatmap" wide><TimeHeatmap data={q.data.time_heatmap} /></Panel>
          </div>
        )
      }
    </div>
  );
}

function Panel({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`border border-border bg-panel/40 rounded-sm relative ${wide ? 'lg:col-span-2' : ''}`} style={{ overflow: 'visible' }}>
      <div className="absolute -top-2.5 left-3 px-2 bg-bg text-[10px] tracking-[0.25em]">
        <span className="text-dim">┌──</span>
        <span className="text-hi mx-1">{title.toUpperCase()}</span>
        <span className="text-dim">──┐</span>
      </div>
      <div className="p-4 pt-5">
        {children}
      </div>
    </section>
  );
}
