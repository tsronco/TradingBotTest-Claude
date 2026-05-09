// dashboard/api/_lib/assignment-spawn.ts
//
// Helpers for the STO put assignment auto-spawn flow:
//
//   detect → enqueueAssignmentPending(entry)
//   drain  → entries = await drainAssignments()
//             for each: build follow-on stock trade, write it,
//             then removeAssignment(entry) to remove from inbox
//
// The inbox is an atomic Redis list (rpush/lrange/lrem), keyed at
// `trades:index:assignments-pending`. Atomic ops avoid the read-modify-write
// race that would happen with a JSON-stored array under concurrent cron ticks.

import { kv } from './kv.js';
import { assignmentsPendingKey } from './kv-keys.js';
import type { AssignmentEntry } from './rules-types.js';
import type { Trade, GradeRecord } from './trade-types.js';
import { allocateTradeId, currentMonth } from './trade-ids.js';

/** Append an assignment entry to the inbox. */
export async function enqueueAssignmentPending(entry: AssignmentEntry): Promise<void> {
  await kv().rpush(assignmentsPendingKey(), JSON.stringify(entry));
}

/** Read all pending entries (does not remove them; call removeAssignment per entry after spawn). */
export async function drainAssignments(): Promise<AssignmentEntry[]> {
  const raw = (await kv().lrange(assignmentsPendingKey(), 0, -1)) as string[] | null;
  if (!raw || raw.length === 0) return [];
  return raw.map((s) => JSON.parse(s) as AssignmentEntry);
}

/** Remove a specific entry from the inbox after its follow-on trade has been spawned. */
export async function removeAssignment(entry: AssignmentEntry): Promise<void> {
  await kv().lrem(assignmentsPendingKey(), 1, JSON.stringify(entry));
}

/**
 * Build an in-memory follow-on stock trade for a put that got assigned.
 * The caller is responsible for writing it to KV + the indexes.
 *
 * Inherits tags + grade from the parent put (since the assignment isn't a
 * separate decision the user made — it's the mechanical consequence of the
 * put already in the journal). Sets `source: 'assignment'`, `parent_id`,
 * and `ai_grade_inherited: true` if the parent had an AI grade.
 */
export async function buildAssignmentTrade(
  parent: Trade,
  entry: AssignmentEntry,
  parentGrade: GradeRecord | null,
): Promise<Trade> {
  const id = await allocateTradeId();
  const inheritedAiGrade = parentGrade?.hindsight?.letter ?? null;
  return {
    id,
    account: parent.account,
    asset_class: 'stock',
    symbol: entry.underlying,
    side: 'buy',
    qty: entry.qty,
    order_type: 'market',
    limit_price: null,
    stop_price: null,
    trail_pct: null,
    tif: 'day',
    contract_symbol: null,
    strike: null,
    expiration: null,
    contract_type: null,
    greeks_at_entry: null,
    alpaca_order_id: '',                  // synthetic — no Alpaca order placed
    alpaca_close_order_id: null,
    submitted_at: entry.detected_at,
    filled_at: entry.detected_at,
    filled_avg_price: entry.strike,
    closed_at: null,
    closed_avg_price: null,
    realized_pnl: null,
    closed_by: null,
    tags: parent.tags,
    entry_grade: parent.entry_grade,
    entry_reasoning: `Assigned from ${parent.contract_symbol ?? `${parent.symbol} ${parent.contract_type ?? ''} $${parent.strike ?? entry.strike}`}`,
    journal: '',
    exposure_at_submit: entry.qty * entry.strike,
    rule_warnings_at_entry: [],
    schema: 1,
    parent_id: parent.id,
    source: 'assignment',
    ai_grade_inherited: inheritedAiGrade != null,
  };
}

export { currentMonth };
