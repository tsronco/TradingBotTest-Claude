import { NavLink } from 'react-router-dom';
import { Home, Briefcase, FileText, Search, LogOut } from 'lucide-react';
import { useLogout } from '../../hooks/useAuth';

const navItems = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/positions', label: 'Positions', icon: Briefcase },
  { to: '/orders', label: 'Orders', icon: FileText },
];

export default function Sidebar() {
  const logout = useLogout();
  return (
    <aside className="w-48 bg-panel border-r border-border flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="text-text-strong font-bold">TIM DASH</div>
        <div className="text-muted text-[10px] uppercase tracking-wider">
          Trading
        </div>
      </div>

      <nav className="flex-1 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                isActive
                  ? 'bg-panel-2 text-text-strong'
                  : 'text-muted hover:text-text hover:bg-panel-2/50'
              }`
            }
          >
            <item.icon size={14} />
            {item.label}
          </NavLink>
        ))}

        <NavLink
          to="/lookup/SPY"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
              isActive
                ? 'bg-panel-2 text-text-strong'
                : 'text-muted hover:text-text hover:bg-panel-2/50'
            }`
          }
        >
          <Search size={14} />
          Lookup
        </NavLink>
      </nav>

      <div className="p-2 border-t border-border">
        <button
          type="button"
          onClick={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = '/login') })}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted hover:text-text hover:bg-panel-2/50"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
