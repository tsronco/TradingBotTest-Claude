// The live account's read-only morning brief, produced once per trading day
// (9:40 ET) by live_brief.py and pushed to KV as `bot:live:brief`. This module
// mirrors the Python record shape and holds the pure helpers the Home card
// uses (staleness, labels) so they can be unit-tested without React.

export type BriefDirection = 'bullish' | 'bearish' | 'neutral';

export interface BriefIdea {
  symbol: string;
  structure: string;
  legs: string;
  direction: BriefDirection;
  why: string;
  getting_paid: string;
  max_loss_usd: number;
  capital_required_usd: number;
  invalidation: string;
  key_risk: string;
  fits_account: boolean;
  confidence: number; // 1–5
}

export interface BriefHeld {
  symbol: string;
  watch: string;
}

export interface LiveBriefRecord {
  date: string;          // YYYY-MM-DD, Eastern
  generated_at: string;  // ISO UTC
  model: string;
  account: {
    equity?: number | null;
    cash?: number | null;
    buying_power?: number | null;
    options_buying_power?: number | null;
  };
  market_read: string;
  ideas: BriefIdea[];
  held: BriefHeld[];
  no_trade_reason: string;
  refused: boolean;
  scan?: { universe_scanned?: number; focus?: string[]; focus_read?: string };
}

/** The document pushed to KV — today's brief plus run metadata. */
export interface LiveBriefState {
  last_brief?: LiveBriefRecord | null;
  _meta?: { last_run_at?: string; runs?: number };
}

/** Today's date in Eastern time as YYYY-MM-DD (the brief is stamped in ET). */
export function easternDateKey(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the key shape we need.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * A brief is stale when it is not from today (ET). Weekends and holidays
 * always show yesterday's brief as stale — that's correct: it was written for
 * a different session and its prices are gone.
 */
export function briefIsStale(brief: LiveBriefRecord | null | undefined, now: Date = new Date()): boolean {
  if (!brief?.date) return true;
  return brief.date !== easternDateKey(now);
}

/** "Wed Sep 10" from a YYYY-MM-DD key, without timezone drift. */
export function briefDateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "10:42 ET" from the brief's generated_at ISO timestamp; '' if unparseable. */
export function briefTimeLabel(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })} ET`;
}

/** Ideas the account can actually place right now, per the model's sizing. */
export function actionableIdeas(brief: LiveBriefRecord | null | undefined): BriefIdea[] {
  return (brief?.ideas ?? []).filter((i) => i.fits_account);
}
