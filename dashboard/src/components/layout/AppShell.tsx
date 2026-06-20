import { Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Sidebar from './Sidebar';
import WatchlistTicker from './WatchlistTicker';
import { useDisplayName } from '../../hooks/useDisplayName';
import { useMarketClock } from '../../hooks/useMarketClock';
import { computeMarketStatus } from '../../lib/market-status';

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function fmtEtClock(now: Date): string {
  // Format as HH:MM:SS in America/New_York.
  return now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' ET';
}

const TMUX_WINDOWS: { idx: number; label: string; match: (path: string) => boolean }[] = [
  { idx: 1, label: 'home',      match: (p) => p === '/' },
  { idx: 2, label: 'positions', match: (p) => p.startsWith('/positions') },
  { idx: 3, label: 'orders',    match: (p) => p.startsWith('/orders') },
  { idx: 4, label: 'trades',    match: (p) => p.startsWith('/trades') || p.startsWith('/trade/') },
  { idx: 5, label: 'lookup',    match: (p) => p.startsWith('/lookup') },
];

export default function AppShell() {
  const now = useNow();
  const clock = fmtEtClock(now);
  const { data: alpacaClock } = useMarketClock();
  const market = computeMarketStatus(now, alpacaClock);
  const location = useLocation();
  const { handle } = useDisplayName();
  const activeIdx = TMUX_WINDOWS.find((w) => w.match(location.pathname))?.idx ?? 1;

  const [drawerOpen, setDrawerOpen] = useState(false);

  // close on route change
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // close on Escape; lock body scroll while open
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <div className="crt vignette dotgrid relative min-h-screen">
      {/* tmux-style top bar */}
      <div className="above-crt sticky top-0 z-30 border-b border-border bg-panel/70 backdrop-blur-[1px]">
        <div className="flex items-stretch h-7 px-3 gap-3 text-[11px]">
          <button
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((o) => !o)}
            className="md:hidden flex items-center px-1 -ml-1 text-mid hover:text-hi"
          >
            <span className="text-[14px] leading-none">{drawerOpen ? '✕' : '≡'}</span>
          </button>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red/70" />
            <span className="w-2 h-2 rounded-full bg-amber/70" />
            <span className="w-2 h-2 rounded-full bg-hi/80 pulse" />
          </div>
          <div className="flex items-center text-dim">
            <span className="text-mid">tmux</span>
            <span className="px-1 text-dim">·</span>
            <span className="text-fg">{handle}@dash</span>
            <span className="text-dim hidden sm:inline">:</span>
            <span className="text-cyan hidden sm:inline">~/portfolio</span>
            <span className="text-dim ml-1 hidden md:inline">
              [
              {TMUX_WINDOWS.map((w, i) => {
                const active = w.idx === activeIdx;
                return (
                  <span key={w.idx}>
                    {i > 0 && ' '}
                    <span className={active ? 'text-hi' : 'text-dim'}>
                      {w.idx}:{w.label}{active ? '*' : ''}
                    </span>
                  </span>
                );
              })}
              ]
            </span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-3 sm:gap-4 text-mid">
            <span className="hidden lg:inline"><span className="text-dim">NET</span> <span className="text-hi">●</span> 42ms</span>
            <span className="hidden lg:inline"><span className="text-dim">API</span> <span className="text-hi">OK</span></span>
            <span className="hidden md:inline"><span className="text-dim">BUILD</span> 0.4.2</span>
            <span className="text-dim tnum">{market.etDateLabel}</span>
            <span
              className="flex items-center gap-1 tnum"
              title={`${market.etDayLabel} · ${market.reason}`}
              aria-label={`Market ${market.isOpen ? 'open' : 'closed'} — ${market.reason}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${market.isOpen ? 'bg-hi pulse' : 'bg-red/70'}`} />
              <span className={market.isOpen ? 'text-hi' : 'text-red'}>{market.label}</span>
            </span>
            <span className="text-fg tnum">{clock}</span>
          </div>
        </div>
      </div>

      <div className="above-crt grid shell-grid" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
        {drawerOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/60 z-40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={`term-sidebar-wrap z-50 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[264px] max-md:transition-transform max-md:duration-200 ${
            drawerOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
          }`}
        >
          <Sidebar onNavigate={() => setDrawerOpen(false)} />
        </div>
        <main className="relative min-w-0 overflow-hidden">
          <WatchlistTicker />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
