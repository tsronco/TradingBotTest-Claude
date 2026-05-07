// Centralized account ↔ mode conversions so adding a new paper account is a
// one-place change. Mirrors the backend Mode/AccountId types.

import type { AccountMode } from '../hooks/useAccount';

export type Mode = 'conservative' | 'aggressive' | 'manual';
export type PaperAccountId = 'conservative_paper' | 'aggressive_paper' | 'manual_paper';
export type AnyAccountId = PaperAccountId | 'live';

export function modeToAccount(mode: Mode): PaperAccountId {
  return `${mode}_paper` as PaperAccountId;
}

export function accountToMode(account: AnyAccountId): Mode {
  if (account === 'aggressive_paper') return 'aggressive';
  if (account === 'manual_paper') return 'manual';
  return 'conservative'; // includes 'live' (no live mode yet, fall back)
}

export function isPaperAccount(account: AnyAccountId): account is PaperAccountId {
  return account === 'conservative_paper' || account === 'aggressive_paper' || account === 'manual_paper';
}

// AccountMode → Mode for components that take a "selected" mode and need to
// pick a single account when "both" is active. Used by lookup/option chain
// where we need ONE account to pull market data from; conservative is the
// default since it's the original setup.
export function selectModeFromAccountMode(am: AccountMode): Mode {
  if (am === 'aggressive' || am === 'manual') return am;
  return 'conservative';
}

export const ALL_MODES: Mode[] = ['conservative', 'aggressive', 'manual'];
export const ALL_PAPER_ACCOUNTS: PaperAccountId[] = ['conservative_paper', 'aggressive_paper', 'manual_paper'];
