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
