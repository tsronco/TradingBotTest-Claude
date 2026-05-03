import { useEffect, useState } from 'react';

export type AccountMode = 'conservative' | 'aggressive' | 'both';
const KEY = 'dash:selectedAccount';

export function useAccount(): [AccountMode, (m: AccountMode) => void] {
  const [mode, setMode] = useState<AccountMode>(() => {
    if (typeof window === 'undefined') return 'both';
    return ((localStorage.getItem(KEY) as AccountMode) ?? 'both');
  });
  useEffect(() => { localStorage.setItem(KEY, mode); }, [mode]);
  return [mode, setMode];
}
