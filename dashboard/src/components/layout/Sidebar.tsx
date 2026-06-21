import { NavLink } from 'react-router-dom';
import { useLogout } from '../../hooks/useAuth';
import { useAccount, type AccountMode } from '../../hooks/useAccount';
import { accountsForSelection } from '../../lib/account-utils';
import { useDisplayName } from '../../hooks/useDisplayName';
import { BUILD_VERSION } from '../../build-version';

// Top nav — daily trading + research, in usage order.
// Settings is grouped at the bottom with changelog and sign-out (account-actions cluster).
const navItems: { to: string; label: string; key: string; end?: boolean }[] = [
  { to: '/', label: 'home', key: '1', end: true },
  { to: '/positions', label: 'positions', key: '2' },
  { to: '/orders', label: 'orders', key: '3' },
  { to: '/trades', label: 'trades', key: '4' },
  { to: '/lookup/SPY', label: 'lookup', key: '5' },
  { to: '/watchlist', label: 'watchlist', key: '6' },
  { to: '/calendar', label: 'calendar', key: '7' },
  { to: '/rules', label: 'rules', key: '8' },
  { to: '/performance', label: 'performance', key: '9' },
];

const acctOpts: { value: AccountMode; label: string; key: string }[] = [
  { value: 'both',      label: 'all',         key: 'a' },
  // groups
  { value: 'small',    label: 'small',       key: 's' },
  { value: 'core',     label: 'core',        key: 'o' },
  { value: 'hands-on', label: 'hands-on',    key: 'h' },
  // single accounts — original 4
  { value: 'conservative', label: 'conservative', key: 'c' },
  { value: 'aggressive',   label: 'aggressive',   key: 'g' },
  { value: 'manual',       label: 'manual',       key: 'm' },
  { value: 'live',         label: 'live $',       key: 'l' },
  // single accounts — small
  { value: 'sm500',  label: '$500',   key: 'f' },
  { value: 'sm1000', label: '$1,000', key: 'k' },
  { value: 'sm2000', label: '$2,000', key: 'd' },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const logout = useLogout();
  const [mode, setMode] = useAccount();
  const { upper: nameUpper } = useDisplayName();

  return (
    <aside className="term-sidebar border-r border-border bg-panel/40 min-h-[calc(100vh-28px)] flex flex-col">
      {/* brand */}
      <div className="p-4 border-b border-border">
        <div className="text-dim text-[10px] tracking-[0.3em]">/// SYS</div>
        <div className="mt-2 leading-none">
          <div className="text-hi text-[20px] font-bold tracking-[0.18em]">{nameUpper}_DASH</div>
          <div className="text-mid text-[10px] tracking-[0.45em] mt-1">T R A D I N G</div>
        </div>
        <div className="mt-3 text-[10px] text-dim flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-hi pulse rounded-sm" />
          <span>v{BUILD_VERSION} · paper</span>
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
            onClick={onNavigate}
            className={({ isActive }) =>
              `navrow max-md:py-2.5 flex items-center gap-2 px-4 py-1.5 border-l-2 ${
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
          <span className="ml-auto text-hi tnum">{accountsForSelection(mode).length}/7 ●</span>
        </div>
        <div className="py-1 text-[11px]">
          {acctOpts.map((o) => {
            const isActive = mode === o.value;
            const isManual = o.value === 'manual';
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => { setMode(o.value); onNavigate?.(); }}
                className={`acct-btn max-md:py-2 px-3 py-1 flex items-center gap-2 ${isActive ? 'active' : 'text-fg'}`}
              >
                <span className={isActive ? 'text-hi' : 'text-dim'}>{isActive ? '▸' : '·'}</span>
                <span>{o.label}</span>
                {isManual && (
                  <span
                    className="text-hi text-[9px]"
                    title="auto-open spreads enabled 2026-05-22 (shortcut $10k validation of SM auto-spread engine)"
                  >
                    ⚙
                  </span>
                )}
                <span className="ml-auto text-dim text-[10px]">[{o.key}]</span>
              </button>
            );
          })}
        </div>
        {accountsForSelection(mode).includes('manual') && (
          <div className="px-3 py-1.5 border-t border-border text-[9px] tracking-wide text-dim leading-snug">
            <span className="text-hi">⚙ manual</span> · auto-open spreads on since 2026-05-22 (shortcut $10k validation)
          </div>
        )}
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

      {/* account-actions cluster — settings · changelog · sign-out grouped together at the bottom */}
      <div className="border-t border-border">
        <div className="px-4 py-1.5 text-[10px] tracking-[0.3em] text-dim">ACCOUNT</div>
        <NavLink
          to="/settings"
          end={false}
          onClick={onNavigate}
          className={({ isActive }) =>
            `navrow max-md:py-2.5 flex items-center gap-2 px-4 py-1.5 border-l-2 text-[12px] ${
              isActive ? 'active border-hi' : 'border-transparent text-fg'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span className={isActive ? 'text-hi' : 'text-dim'}>{isActive ? '▸' : '·'}</span>
              <span className={isActive ? 'text-hi' : ''}>settings</span>
            </>
          )}
        </NavLink>

        <NavLink
          to="/changelog"
          onClick={onNavigate}
          className={({ isActive }) =>
            `navrow text-left px-4 py-1.5 flex items-center gap-2 text-[11px] ${
              isActive ? 'text-hi' : 'text-dim'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span className={isActive ? 'text-hi' : 'text-dim'}>{isActive ? '▸' : '·'}</span>
              <span>changelog</span>
            </>
          )}
        </NavLink>

        <button
          type="button"
          onClick={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = '/login') })}
          className="navrow text-left px-4 py-2.5 border-t border-border text-fg flex items-center gap-2 w-full"
        >
          <span className="text-red">⏻</span>
          <span>sign_out</span>
          <span className="ml-auto text-dim text-[10px]">^D</span>
        </button>
      </div>
    </aside>
  );
}
