import { Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Sidebar from './Sidebar';

function useEtClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
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
  { idx: 4, label: 'lookup',    match: (p) => p.startsWith('/lookup') },
];

export default function AppShell() {
  const clock = useEtClock();
  const location = useLocation();
  const activeIdx = TMUX_WINDOWS.find((w) => w.match(location.pathname))?.idx ?? 1;

  return (
    <div className="crt vignette dotgrid relative min-h-screen">
      {/* tmux-style top bar */}
      <div className="above-crt border-b border-border bg-panel/70 backdrop-blur-[1px]">
        <div className="flex items-stretch h-7 px-3 gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red/70" />
            <span className="w-2 h-2 rounded-full bg-amber/70" />
            <span className="w-2 h-2 rounded-full bg-hi/80 pulse" />
          </div>
          <div className="flex items-center text-dim">
            <span className="text-mid">tmux</span>
            <span className="px-1 text-dim">·</span>
            <span className="text-fg">tim@dash</span>
            <span className="text-dim">:</span>
            <span className="text-cyan">~/portfolio</span>
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
          <div className="flex items-center gap-4 text-mid">
            <span className="hidden lg:inline"><span className="text-dim">NET</span> <span className="text-hi">●</span> 42ms</span>
            <span className="hidden lg:inline"><span className="text-dim">API</span> <span className="text-hi">OK</span></span>
            <span className="hidden md:inline"><span className="text-dim">BUILD</span> 0.4.2</span>
            <span className="text-fg tnum">{clock}</span>
          </div>
        </div>
      </div>

      <div className="above-crt grid shell-grid" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
        <Sidebar />
        <main className="relative min-w-0 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
