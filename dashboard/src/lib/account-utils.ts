// Centralized account ↔ mode conversions so adding a new account is a
// one-place change. Mirrors the backend Mode/AccountId types.
//
// Four accounts in scope: three paper (conservative, aggressive, manual) +
// one live (real money). `Mode` covers all four; `PaperAccountId` covers
// only the three paper variants for the assignment cron's safety subset.

import type { AccountMode } from '../hooks/useAccount';

export type Mode = 'conservative' | 'aggressive' | 'manual' | 'live';
export type PaperAccountId = 'conservative_paper' | 'aggressive_paper' | 'manual_paper';
export type AnyAccountId = PaperAccountId | 'live';

export function modeToAccount(mode: Mode): AnyAccountId {
  if (mode === 'live') return 'live';
  return `${mode}_paper` as PaperAccountId;
}

export function accountToMode(account: AnyAccountId): Mode {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  if (account === 'live') return 'live';
  return 'conservative';
}

export function isPaperAccount(account: AnyAccountId): account is PaperAccountId {
  return account === 'conservative_paper' || account === 'aggressive_paper' || account === 'manual_paper';
}

export function isLiveAccount(account: AnyAccountId): account is 'live' {
  return account === 'live';
}

// AccountMode → Mode for components that take a "selected" mode and need to
// pick a single account when "both" is active. Used by lookup/option chain
// where we need ONE account to pull market data from; conservative is the
// default since it's the original setup. (Live is intentionally NOT the
// default when 'both' — keep market-data calls on a paper account so a
// runaway loop never burns live API quota.)
export function selectModeFromAccountMode(am: AccountMode): Mode {
  if (am === 'aggressive' || am === 'manual' || am === 'live') return am;
  return 'conservative';
}

export const ALL_MODES: Mode[] = ['conservative', 'aggressive', 'manual', 'live'];
export const ALL_PAPER_ACCOUNTS: PaperAccountId[] = ['conservative_paper', 'aggressive_paper', 'manual_paper'];
export const ALL_ACCOUNTS: AnyAccountId[] = [...ALL_PAPER_ACCOUNTS, 'live'];
