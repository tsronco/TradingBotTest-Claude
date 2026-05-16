// Centralized account ↔ mode conversions so adding a new account is a
// one-place change. Mirrors the backend Mode/AccountId types.
//
// Seven accounts in scope: three original paper (conservative, aggressive, manual)
// + one live (real money) + three small-account paper (sm500, sm1000, sm2000).
// `Mode` covers all seven; `PaperAccountId` covers only the paper variants.

import type { AccountMode } from '../hooks/useAccount';

export type Mode =
  | 'conservative' | 'aggressive' | 'manual' | 'live'
  | 'sm500' | 'sm1000' | 'sm2000';

export type PaperAccountId =
  | 'conservative_paper' | 'aggressive_paper' | 'manual_paper'
  | 'sm500_paper' | 'sm1000_paper' | 'sm2000_paper';

export type AnyAccountId = PaperAccountId | 'live';

export function modeToAccount(mode: Mode): AnyAccountId {
  if (mode === 'live') return 'live';
  if (mode === 'sm500') return 'sm500_paper';
  if (mode === 'sm1000') return 'sm1000_paper';
  if (mode === 'sm2000') return 'sm2000_paper';
  return `${mode}_paper` as PaperAccountId;
}

export function accountToMode(account: AnyAccountId): Mode {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  if (account === 'sm500_paper') return 'sm500';
  if (account === 'sm1000_paper') return 'sm1000';
  if (account === 'sm2000_paper') return 'sm2000';
  if (account === 'live') return 'live';
  return 'conservative';
}

export function isPaperAccount(account: AnyAccountId): account is PaperAccountId {
  return (
    account === 'conservative_paper' ||
    account === 'aggressive_paper' ||
    account === 'manual_paper' ||
    account === 'sm500_paper' ||
    account === 'sm1000_paper' ||
    account === 'sm2000_paper'
  );
}

export function isLiveAccount(account: AnyAccountId): account is 'live' {
  return account === 'live';
}

// AccountMode → Mode for components that take a "selected" mode and need to
// pick a single account when "both"/group is active. Used by lookup/option chain
// where we need ONE account to pull market data from; conservative is the
// default since it's the original setup. (Live is intentionally NOT the
// default when 'both' — keep market-data calls on a paper account so a
// runaway loop never burns live API quota.)
export function selectModeFromAccountMode(am: AccountMode): Mode {
  if (
    am === 'aggressive' || am === 'manual' || am === 'live' ||
    am === 'sm500' || am === 'sm1000' || am === 'sm2000'
  ) return am;
  return 'conservative';
}

export const ALL_MODES: Mode[] = [
  'conservative', 'aggressive', 'manual', 'live',
  'sm500', 'sm1000', 'sm2000',
];

export const ALL_PAPER_ACCOUNTS: PaperAccountId[] = [
  'conservative_paper', 'aggressive_paper', 'manual_paper',
  'sm500_paper', 'sm1000_paper', 'sm2000_paper',
];

export const ALL_ACCOUNTS: AnyAccountId[] = [...ALL_PAPER_ACCOUNTS, 'live'];

// Group definitions — used by accountsForSelection()
const GROUP_SMALL: Mode[] = ['sm500', 'sm1000', 'sm2000'];
const GROUP_CORE: Mode[] = ['conservative', 'aggressive'];
const GROUP_HANDS_ON: Mode[] = ['manual', 'live'];

/**
 * Resolve an AccountMode selection to the list of Mode values it represents.
 *   'all' / 'both' → all 7 modes
 *   'small'        → sm500, sm1000, sm2000
 *   'core'         → conservative, aggressive
 *   'hands-on'     → manual, live
 *   any single Mode → [that mode]
 */
export function accountsForSelection(sel: AccountMode): Mode[] {
  if (sel === 'both') return [...ALL_MODES];
  if (sel === 'small') return [...GROUP_SMALL];
  if (sel === 'core') return [...GROUP_CORE];
  if (sel === 'hands-on') return [...GROUP_HANDS_ON];
  // single mode — sel is a Mode value here
  return [sel as Mode];
}
