// Centralized account ↔ mode conversions so account changes are a one-place
// change. Mirrors the backend Mode/AccountId types.
//
// Three accounts in scope:
//   manual (paper)  — user opens by hand, bot manages
//   live            — real money, same operating model as manual
//   agent (paper)   — the autonomous Claude-driven account (agentic trading).
//                     Claude makes every decision; the harness only executes.
// The conservative, aggressive, and sm500/sm1000/sm2000 accounts were retired
// 2026-06-29.
//
// `Mode` covers all three; `PaperAccountId` covers the paper variants.

import type { AccountMode } from '../hooks/useAccount';

export type Mode = 'manual' | 'live' | 'agent';

/** Modes that run the wheel/strategy bot and therefore have a
 *  `bot:state:<mode>` / `bot:rules:<mode>` payload. The agent account runs a
 *  completely different engine (agent_trader.py) with its own state shape, so
 *  it is deliberately NOT a wheel mode. */
export type WheelMode = 'manual' | 'live';

export const WHEEL_MODES: WheelMode[] = ['manual', 'live'];

export function isWheelMode(mode: Mode): mode is WheelMode {
  return mode === 'manual' || mode === 'live';
}

export function isAgentMode(mode: Mode): mode is 'agent' {
  return mode === 'agent';
}

export type PaperAccountId = 'manual_paper' | 'agent_paper';

export type AnyAccountId = PaperAccountId | 'live';

export function modeToAccount(mode: Mode): AnyAccountId {
  if (mode === 'live') return 'live';
  if (mode === 'agent') return 'agent_paper';
  return 'manual_paper';
}

export function accountToMode(account: AnyAccountId): Mode {
  if (account === 'live') return 'live';
  if (account === 'agent_paper') return 'agent';
  return 'manual';
}

export function isPaperAccount(account: AnyAccountId): account is PaperAccountId {
  return account === 'manual_paper' || account === 'agent_paper';
}

export function isLiveAccount(account: AnyAccountId): account is 'live' {
  return account === 'live';
}

export function isAgentAccount(account: AnyAccountId): account is 'agent_paper' {
  return account === 'agent_paper';
}

// AccountMode → Mode for components that take a "selected" mode and need to
// pick a single account when "both" is active. Used by lookup/option chain
// where we need ONE account to pull market data from; manual (paper) is the
// default so a runaway loop never burns live API quota.
export function selectModeFromAccountMode(am: AccountMode): Mode {
  if (am === 'live') return 'live';
  if (am === 'agent') return 'agent';
  return 'manual';
}

export const ALL_MODES: Mode[] = ['manual', 'live', 'agent'];

export const ALL_PAPER_ACCOUNTS: PaperAccountId[] = ['manual_paper', 'agent_paper'];

export const ALL_ACCOUNTS: AnyAccountId[] = ['manual_paper', 'live', 'agent_paper'];

/**
 * Accounts an order form may hold in its draft state.
 *
 * `live` is included because the forms render it as a visibly-disabled chip
 * (real money is bot-only); `agent_paper` is not, because a hand-placed order
 * must never reach the autonomous account at all — see
 * TRADEABLE_PAPER_ACCOUNTS below.
 */
export type OrderAccountId = 'manual_paper' | 'live';

/**
 * Paper accounts a human may place an order into from the dashboard.
 *
 * `agent_paper` is excluded on purpose: the whole point of that account is to
 * measure Claude's unassisted decisions, so a hand-placed order would pollute
 * the record (and the agent's next cycle would see a position it has no thesis
 * for). The dashboard stays read-only on it — same posture as `live`, for a
 * different reason.
 */
export const TRADEABLE_PAPER_ACCOUNTS: Extract<OrderAccountId, PaperAccountId>[] = [
  'manual_paper',
];

export function isTradeableAccount(account: AnyAccountId): boolean {
  return (TRADEABLE_PAPER_ACCOUNTS as AnyAccountId[]).includes(account);
}



/** Human-facing label for an account id. */
export const ACCOUNT_LABEL: Record<AnyAccountId, string> = {
  manual_paper: 'manual (paper)',
  live: 'live (real money)',
  agent_paper: 'agent (autonomous paper)',
};

/**
 * Resolve an AccountMode selection to the list of Mode values it represents.
 *   'both' → manual, live, agent  (the "all" chip)
 *   any single Mode → [that mode]
 */
export function accountsForSelection(sel: AccountMode): Mode[] {
  if (sel === 'both') return [...ALL_MODES];
  // single mode — sel is a Mode value here
  return [sel as Mode];
}
