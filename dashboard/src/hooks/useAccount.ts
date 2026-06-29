import { useEffect, useState } from 'react';

// Two accounts since the 2026-06-29 sunset: manual (paper) + live (real money),
// plus 'both' for the side-by-side view.
export type AccountMode = 'manual' | 'live' | 'both';
const KEY = 'dash:selectedAccount';
const CHANGE_EVENT = 'dash:account-mode-change';

function readMode(): AccountMode {
  if (typeof window === 'undefined') return 'both';
  return ((localStorage.getItem(KEY) as AccountMode) ?? 'both');
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
