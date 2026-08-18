import { useEffect, useState } from 'react';

// Three accounts: manual (paper) + live (real money) + agent (the autonomous
// Claude-driven paper account, added 2026-08-18), plus 'both' — the "all" chip —
// for the side-by-side view. ('both' predates the third account; the token is
// kept so existing localStorage selections keep working.)
export type AccountMode = 'manual' | 'live' | 'agent' | 'both';

const VALID_MODES: readonly AccountMode[] = ['manual', 'live', 'agent', 'both'];
const KEY = 'dash:selectedAccount';
const CHANGE_EVENT = 'dash:account-mode-change';

function readMode(): AccountMode {
  if (typeof window === 'undefined') return 'both';
  const stored = localStorage.getItem(KEY) as AccountMode | null;
  // Guard against a stale selection left over from a retired account
  // (conservative/aggressive/sm*) — those would otherwise resolve to an
  // unknown mode and blank every account-aware page.
  return stored && VALID_MODES.includes(stored) ? stored : 'both';
}

/**
 * Selected-account state shared across every consumer in the page.
 * Each useAccount() instance has its own React state, but they all stay
 * in sync via a custom event on `window`. Cross-tab sync via 'storage' too.
 */
export function useAccount(): [AccountMode, (m: AccountMode) => void] {
  const [mode, setMode] = useState<AccountMode>(readMode);

  useEffect(() => {
    const handler = () => setMode(readMode());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const set = (m: AccountMode) => {
    localStorage.setItem(KEY, m);
    setMode(m); // local update for snappy UX; event below syncs other consumers
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  };

  return [mode, set];
}
