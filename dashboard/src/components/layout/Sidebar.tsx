import { NavLink } from 'react-router-dom';
import { useLogout } from '../../hooks/useAuth';
import { useAccount, type AccountMode } from '../../hooks/useAccount';

const navItems: { to: string; label: string; key: string; end?: boolean }[] = [
  { to: '/', label: 'home', key: '1', end: true },
  { to: '/positions', label: 'positions', key: '2' },
  { to: '/orders', label: 'orders', key: '3' },
  { to: '/lookup/SPY', label: 'lookup', key: '4' },
  { to: '/settings', label: 'settings', key: '5' },
  { to: '/trades', label: 'trades', key: '6' },
];

const acctOpts: { value: AccountMode; label: string; key: string }[] = [
  { value: 'both', label: 'all', key: 'a' },
  { value: 'conservative', label: 'conservative', key: 'c' },
  { value: 'aggressive', label: 'aggressive', key: 'g' },
  { value: 'manual', label: 'manual', key: 'm' },
];

export default function Sidebar() {
  const logout = useLogout();
  const [mode, setMode] = useAccount();

  return (
    <aside className="term-sidebar border-r border-border bg-panel/40 min-h-[calc(100vh-28px)] flex flex-col">
      {/* brand */}
      <div className="p-4 border-b border-border">
        <div className="text-dim text-[10px] tracking-[0.3em]">/// SYS</div>
        <div className="mt-2 leading-none">
          <div className="text-hi text-[20px] font-bold tracking-[0.18em]">TIM_DASH</div>
          <div className="text-mid text-[10px] tracking-[0.45em] mt-1">T R A D I N G</div>
        </div>
        <div className="mt-3 text-[10px] text-dim flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-hi pulse rounded-sm" />
          <span>v0.4.2 · paper</span>
        </div>
      </div>

      {/* nav */}
      <nav className="py-3 text-[12px]">
        <div className="px-4 pb-2 text-[10px] tracking-[0.3em] text-dim">NAV</div>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `navrow flex items-center gap-2 px-4 py-1.5 border-l-2 ${
                isActive ? 'active border-hi' : 'border-transparent text-fg'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className={isActive ? 'text-hi' : 'text-dim'}>{isActive ? '▸' : '·'}</span>
                <span className={isActive ? 'text-hi' : ''}>{item.label}</span>
                <span className="ml-auto text-dim text-[10px]">[{item.key}]</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* accounts mini-filter panel */}
      <div className="mx-3 mt-2 mb-3 border border-border rounded-sm">
        <div className="px-3 py-1.5 text-[10px] tracking-[0.25em] text-dim border-b border-border flex items-center gap-2">
          <span>ACCOUNTS</span>
          <span className="ml-auto text-hi tnum">{mode === 'both' ? '3/3' : '1/3'} ●</span>
        </div>
        <div className="py-1 text-[11px]">
          {acctOpts.map((o) => {
            const isActive = mode === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setMode(o.value)}
                className={`acct-btn px-3 py-1 flex items-center gap-2 ${isActive ? 'active' : 'text-fg'}`}
              >
                <span className={isActive ? 'text-hi' : 'text-dim'}>{isActive ? '▸' : '·'}</span>
                <span>{o.label}</span>
                <span className="ml-auto text-dim text-[10px]">[{o.key}]</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ascii art block */}
      <div className="mx-3 mb-3 px-3 py-2 border border-border rounded-sm text-dim text-[10px] leading-tight">
        <pre className="whitespace-pre m-0">{`  ┌──────────────┐
  │ ▁▂▃▄▅▆▇█▇▆▅  │
  │ wheel · csp  │
  │ ▒▒▒▒▒▒░░░░░  │
  └──────────────┘`}</pre>
      </div>

      <div className="flex-1" />

      {/* sign out */}
      <button
        type="button"
        onClick={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = '/login') })}
        className="navrow text-left px-4 py-2.5 border-t border-border text-fg flex items-center gap-2"
      >
        <span className="text-red">⏻</span>
        <span>sign_out</span>
        <span className="ml-auto text-dim text-[10px]">^D</span>
      </button>
    </aside>
  );
}
