// Centralized account ↔ mode conversions so account changes are a one-place
// change. Mirrors the backend Mode/AccountId types.
//
// Two accounts in scope: manual (paper) + live (real money). The conservative,
// aggressive, and sm500/sm1000/sm2000 accounts were retired 2026-06-29.
// `Mode` covers both; `PaperAccountId` covers only the paper variant.

import type { AccountMode } from '../hooks/useAccount';

export type Mode = 'manual' | 'live';

export type PaperAccountId = 'manual_paper';

export type AnyAccountId = PaperAccountId | 'live';

export function modeToAccount(mode: Mode): AnyAccountId {
  if (mode === 'live') return 'live';
  return 'manual_paper';
}

export function accountToMode(account: AnyAccountId): Mode {
  if (account === 'live') return 'live';
  return 'manual';
}

export function isPaperAccount(account: AnyAccountId): account is PaperAccountId {
  return account === 'manual_paper';
}

export function isLiveAccount(account: AnyAccountId): account is 'live' {
  return account === 'live';
}

// AccountMode → Mode for components that take a "selected" mode and need to
// pick a single account when "both" is active. Used by lookup/option chain
// where we need ONE account to pull market data from; manual (paper) is the
// default so a runaway loop never burns live API quota.
export function selectModeFromAccountMode(am: AccountMode): Mode {
  if (am === 'live') return 'live';
  return 'manual';
}

export const ALL_MODES: Mode[] = ['manual', 'live'];

export const ALL_PAPER_ACCOUNTS: PaperAccountId[] = ['manual_paper'];

export const ALL_ACCOUNTS: AnyAccountId[] = [...ALL_PAPER_ACCOUNTS, 'live'];

/**
 * Resolve an AccountMode selection to the list of Mode values it represents.
 *   'both' → manual, live
 *   any single Mode → [that mode]
 */
export function accountsForSelection(sel: AccountMode): Mode[] {
  if (sel === 'both') return [...ALL_MODES];
  // single mode — sel is a Mode value here
  return [sel as Mode];
}
