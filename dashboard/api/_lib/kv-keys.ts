// Two accounts since the 2026-06-29 sunset: manual (paper) + live (real money).
export const BOT_STATE_KEYS = [
  'bot:state:manual',
  'bot:state:live',
  'bot:strategy:manual',
  'bot:strategy:live',
  'bot:rules:manual',
  'bot:rules:live',
] as const;

export type BotStateKey = (typeof BOT_STATE_KEYS)[number];

export function isAllowedBotStateKey(key: string): key is BotStateKey {
  return (BOT_STATE_KEYS as readonly string[]).includes(key);
}

export function lastUpdateKey(key: BotStateKey): string {
  return `bot:last-update:${key}`;
}

const DASHBOARD_KEY_PATTERNS: RegExp[] = [
  /^trade:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
  /^trades:idem:.+$/,
  /^grade:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
  /^assignment-child:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
  /^trades:index:open$/,
  /^trades:index:assignments-pending$/,
  /^trades:index:\d{4}-\d{2}$/,
  /^trades:counter:\d{4}-\d{2}-\d{2}$/,
  /^tags:list$/,
  /^config:totp_thresholds$/,
  /^auth:backup_codes_hashed$/,
  /^auth:used-backup-codes$/,
  /^watchlist$/,
  /^rules:(manual|patterns|cheatsheets|goals|tendencies|proposals)$/,
  /^config:display_name$/,
  /^import:cursor:(manual_paper|live)$/,
];

export function isAllowedDashboardKey(key: string): boolean {
  return DASHBOARD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export const KV_KEYS = {
  watchlist: 'watchlist',
  totpThresholds: 'config:totp_thresholds',
  displayName: 'config:display_name',
  sessionPrefix: 'session:',
  tagsList: 'tags:list',
  backupCodesHashed: 'auth:backup_codes_hashed',
  tradesIndexOpen: 'trades:index:open',
  // Rotating cursor (integer index) so the grade-open-trades sweep covers the
  // whole open index over successive ticks instead of always restarting at 0.
  tradesSweepCursor: 'trades:cursor:sweep',
  // Queue of closed-but-not-yet-AI-graded trade ids. A close is cheap (Alpaca
  // reads + KV writes); the AI hindsight grade is expensive (Sonnet call), so
  // closes beyond the per-tick grade budget land here and are drained on later
  // ticks. Stored as a JSON string array (low-traffic — not the open index).
  tradesIndexNeedsGrade: 'trades:index:needs_grade',
} as const;

export function tradeKey(id: string): string {
  return `trade:${id}`;
}

export function gradeKey(id: string): string {
  return `grade:${id}`;
}

export function tradesIndexMonthKey(yyyymm: string): string {
  return `trades:index:${yyyymm}`;
}

export function tradesCounterKey(yyyymmdd: string): string {
  return `trades:counter:${yyyymmdd}`;
}

export type Mode = 'manual' | 'live';

export function botRulesKey(mode: Mode): BotStateKey {
  return `bot:rules:${mode}` as BotStateKey;
}

export type RulesResource =
  | 'manual'
  | 'patterns'
  | 'cheatsheets'
  | 'goals'
  | 'tendencies'
  | 'proposals';

export function rulesKey(resource: RulesResource): string {
  return `rules:${resource}`;
}

export function assignmentsPendingKey(): string {
  return 'trades:index:assignments-pending';
}

export function assignmentChildKey(parentTradeId: string): string {
  return `assignment-child:${parentTradeId}`;
}

export function importCursorKey(account: string): string {
  return `import:cursor:${account}`;
}

// D4 — Month-index helpers: atomic rpush/lrange with lazy migration.
//
// The per-month trade index (trades:index:YYYY-MM) was previously a
// JSON-array stored as a Redis string via get/set.  Concurrent writers
// (browser tab + cron) could both read before either wrote, losing one
// appended id permanently.
//
// Fix: store the index as a Redis LIST, using atomic rpush() for appends and
// lrange() for reads.  Legacy string keys (JSON-array format) are migrated
// in-place on first touch: read the JSON array via get(), delete the string
// key, rpush all ids back as a proper list, then proceed normally.
//
// Migration detection uses a try-lrange-catch-WRONGTYPE approach rather than
// type() so that it degrades gracefully in test mocks that expose get/set/rpush
// but not type().  The WRONGTYPE error message is Redis's standard signal that
// the key holds a string — catching it is equivalent to type()==='string'.
//
// Concurrent-append safety:
//   - Once migrated, every append is a single atomic rpush — no read-modify-write.
//   - If two callers both see a legacy string key and both try to migrate
//     simultaneously (only possible across separate Lambda invocations, not
//     within a single Node process), the second del+rpush runs after the first
//     and overwrites with the same ids — then the second caller's own rpush
//     appends the new id.  No ids are lost.

import { kv } from './kv.js';

function isWrongTypeError(e: unknown): boolean {
  return e instanceof Error && e.message.includes('WRONGTYPE');
}

async function migrateStringToList(key: string): Promise<string[]> {
  // Key currently holds a JSON-array string (legacy format).
  // Read it, delete the string key, re-write as a list.
  //
  // Accepted one-time risk: if two Lambda invocations both catch WRONGTYPE on
  // the same legacy key and both reach this point concurrently, the del→rpush
  // sequence runs twice — pushing the same ids twice into the list. This is a
  // non-zero-probability but extremely rare event (same month key, same 100ms
  // cold-start window). The ids themselves (trade:T-… records) are never lost —
  // they exist independently in KV. readMonthIndex dedups on every read, so
  // the duplicate list entries are transparently collapsed for all callers.
  const raw = await kv().get<unknown>(key);
  const ids: string[] = Array.isArray(raw) ? (raw as string[]) : [];
  // Dedup before rpush so a single migration call never introduces duplicates
  // (defensive belt-and-suspenders; the race scenario is handled by read-dedup).
  const uniqueIds = [...new Set(ids)];
  await kv().del(key);
  if (uniqueIds.length > 0) {
    await kv().rpush(key, ...uniqueIds);
  }
  return uniqueIds;
}

/**
 * Read all ids in a month's trade index.  Handles:
 *   - missing key → returns []
 *   - list key    → lrange(0, -1) (fast path for all new and migrated keys)
 *   - legacy string key → migrate to list in place, return ids (one-time cost)
 */
export async function readMonthIndex(month: string): Promise<string[]> {
  const key = tradesIndexMonthKey(month);
  try {
    const ids = (await kv().lrange<string>(key, 0, -1)) ?? [];
    // Dedup preserving first-occurrence order. Belt-and-suspenders against the
    // concurrent-migration race (two readers both run migrateStringToList on the
    // same legacy key, pushing ids twice). Trade records themselves survive in
    // trade:T-… and are always the source of truth; the index is just a lookup
    // list, so collapsing duplicates here is safe and correct.
    return [...new Set(ids)];
  } catch (e) {
    if (isWrongTypeError(e)) {
      // Legacy JSON-array string key — migrate and return.
      return migrateStringToList(key);
    }
    throw e;
  }
}

/**
 * Append a single trade id to a month's trade index atomically.  Handles:
 *   - missing key        → rpush creates a new list
 *   - existing list key  → rpush appends atomically (no read-modify-write)
 *   - legacy string key  → migrate to list first, then rpush
 */
export async function appendMonthIndex(month: string, id: string): Promise<void> {
  const key = tradesIndexMonthKey(month);
  try {
    await kv().rpush(key, id);
  } catch (e) {
    if (isWrongTypeError(e)) {
      // Legacy string key — migrate, then append.
      await migrateStringToList(key);
      await kv().rpush(key, id);
    } else {
      throw e;
    }
  }
}

// D2 — KV idempotency index for cross-request order dedup.
//
// Maps a caller-supplied idempotency_key → trade id. Written with nx:true
// (set-if-not-exists) immediately after allocateTradeId() and before the
// Alpaca call, so a concurrent or sequential retry with the same key either:
//   • wins the claim (gets 'OK') → proceeds normally, or
//   • loses the claim (gets null) → reads the winning request's trade id
//     from KV and returns that existing trade record without calling Alpaca.
//
// TTL is 7 days (604800 s). Retries happen within seconds to minutes; a
// week-long window is generous and keeps the index from growing unbounded.
//
// NOTE: the `dash-<id>` fallback (for callers with no key) is NOT retry-
// idempotent — it derives from a newly-allocated id on every request. Only a
// stable caller-supplied key qualifies for cross-request dedup.
export const IDEM_INDEX_TTL_SECONDS = 7 * 24 * 3600; // 604800 s

export function idemKey(idempotencyKey: string): string {
  return `trades:idem:${idempotencyKey}`;
}
