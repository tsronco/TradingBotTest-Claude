import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpush = vi.fn().mockResolvedValue(1);
const lrange = vi.fn();
const lrem = vi.fn().mockResolvedValue(1);
vi.mock('../api/_lib/kv', () => ({
  kv: () => ({ rpush, lrange, lrem }),
}));

describe('assignment-spawn helpers', () => {
  beforeEach(() => { rpush.mockClear(); lrange.mockClear(); lrem.mockClear(); });

  it('enqueueAssignmentPending pushes the entry object (Upstash handles serialization)', async () => {
    const { enqueueAssignmentPending } = await import('../api/_lib/assignment-spawn');
    const entry = {
      parent_trade_id: 'T-2026-05-01-001',
      underlying: 'F',
      strike: 12,
      qty: 100,
      account: 'conservative_paper' as const,
      detected_at: '2026-05-07T13:00:00Z',
    };
    await enqueueAssignmentPending(entry);
    // Pre-fix this test asserted JSON.stringify(entry) — but Upstash auto-
    // serializes objects on write, so manually JSON.stringify-ing produced a
    // double-encoded value that exploded on read (drainAssignments tried to
    // JSON.parse an already-parsed object → "[object Object]" SyntaxError).
    // The contract is now: pass the raw object; the SDK handles JSON.
    expect(rpush).toHaveBeenCalledWith('trades:index:assignments-pending', entry);
  });

  it('enqueueAssignmentPending accepts all 3 paper accounts', async () => {
    const { enqueueAssignmentPending } = await import('../api/_lib/assignment-spawn');
    for (const account of ['conservative_paper', 'aggressive_paper', 'manual_paper'] as const) {
      await enqueueAssignmentPending({
        parent_trade_id: `T-${account}-001`, underlying: 'F', strike: 12, qty: 100,
        account, detected_at: '2026-05-07T13:00:00Z',
      });
    }
    expect(rpush).toHaveBeenCalledTimes(3);
  });

  it('drainAssignments returns entries directly from KV (Upstash auto-parses on read)', async () => {
    // Upstash returns parsed objects, not JSON strings. The mock simulates
    // that behavior here — pre-fix the mock returned strings, which masked
    // the production-only double-parse bug.
    lrange.mockResolvedValueOnce([
      {
        parent_trade_id: 'T-1', underlying: 'F', strike: 12, qty: 100,
        account: 'conservative_paper', detected_at: '2026-05-01T13:00:00Z',
      },
      {
        parent_trade_id: 'T-2', underlying: 'BAC', strike: 35, qty: 100,
        account: 'aggressive_paper', detected_at: '2026-05-02T13:00:00Z',
      },
    ]);
    const { drainAssignments } = await import('../api/_lib/assignment-spawn');
    const entries = await drainAssignments();
    expect(entries).toHaveLength(2);
    expect(entries[0].parent_trade_id).toBe('T-1');
    expect(entries[1].underlying).toBe('BAC');
    expect(lrange).toHaveBeenCalledWith('trades:index:assignments-pending', 0, -1);
  });

  it('drainAssignments returns empty array when list is empty', async () => {
    lrange.mockResolvedValueOnce([]);
    const { drainAssignments } = await import('../api/_lib/assignment-spawn');
    const entries = await drainAssignments();
    expect(entries).toEqual([]);
  });

  it('drainAssignments returns empty array when KV returns null', async () => {
    lrange.mockResolvedValueOnce(null);
    const { drainAssignments } = await import('../api/_lib/assignment-spawn');
    const entries = await drainAssignments();
    expect(entries).toEqual([]);
  });

  it('removeAssignment calls lrem with the entry object (Upstash handles serialization)', async () => {
    const { removeAssignment } = await import('../api/_lib/assignment-spawn');
    const entry = {
      parent_trade_id: 'T-1', underlying: 'F', strike: 12, qty: 100,
      account: 'conservative_paper' as const, detected_at: '2026-05-01T13:00:00Z',
    };
    await removeAssignment(entry);
    expect(lrem).toHaveBeenCalledWith('trades:index:assignments-pending', 1, entry);
  });
});
