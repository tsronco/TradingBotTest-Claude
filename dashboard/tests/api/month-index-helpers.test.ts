// dashboard/tests/api/month-index-helpers.test.ts
//
// D4 — month-index concurrent-append + legacy-migration tests.
//
// The month-index (trades:index:YYYY-MM) previously used a read-modify-write
// get/set pattern. Under concurrent writers, one append overwrites the other.
// The fix converts to atomic rpush/lrange, with lazy migration of legacy
// JSON-array string keys to list type.
//
// These tests verify:
//   1. Two concurrent appends BOTH survive (list semantics, no lost ids).
//   2. A reader returns all ids in insertion order.
//   3. A legacy "string" (JSON-array) month key is read correctly AND migrated
//      to a list in place (subsequent type returns 'list', ids preserved, no
//      data lost).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-process KV mock that faithfully models Redis list vs string type ──────
//
// The production bug is that kv().get() on a list key throws WRONGTYPE, and
// kv().set() on a string key silently overwrites concurrent appends. A mock
// that simply stores values in a Map and accepts any key for any op would mask
// the bug. This mock enforces type discipline:
//   - set()  → marks key as 'string'
//   - rpush() → marks key as 'list'
//   - get()  → reads string keys; throws WRONGTYPE on list keys (like Redis)
//   - lrange() → reads list keys; throws WRONGTYPE on string keys
//   - type()  → returns 'string' | 'list' | 'none'
//   - del()  → removes the key entirely

class TypeAwareKvStore {
  // Store values as their raw JS form (Upstash auto-serialises/deserialises
  // JSON under the hood, so set(k, [1,2]) and get(k) returns [1,2] directly).
  private store = new Map<string, { type: 'string' | 'list'; value: unknown | string[] }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.type === 'list') {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value (key="${key}")`);
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown): Promise<'OK'> {
    // Upstash stores the JS value and returns it as-is on get() (JSON round-trip
    // is transparent to callers). Mirror that: store the raw value.
    this.store.set(key, { type: 'string', value });
    return 'OK';
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const entry = this.store.get(key);
    if (entry && entry.type === 'string') {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value (key="${key}")`);
    }
    const list: string[] = (entry?.value as string[]) ?? [];
    const next = [...list, ...values];
    this.store.set(key, { type: 'list', value: next });
    return next.length;
  }

  async lrange<T = string>(key: string, start: number, stop: number): Promise<T[]> {
    const entry = this.store.get(key);
    if (!entry) return [];
    if (entry.type === 'string') {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value (key="${key}")`);
    }
    const list = entry.value as string[];
    const len = list.length;
    const normaliseIdx = (i: number) => (i < 0 ? Math.max(0, len + i) : i);
    const s = normaliseIdx(start);
    const e = stop < 0 ? len + stop + 1 : stop + 1;
    return list.slice(s, e) as unknown as T[];
  }

  async type(key: string): Promise<'string' | 'list' | 'none'> {
    const entry = this.store.get(key);
    if (!entry) return 'none';
    return entry.type;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.has(k)) { this.store.delete(k); count++; }
    }
    return count;
  }

  // Seed a legacy string key (old format: the key was set via kv().set(key, arrayValue)).
  // Upstash stores as JSON and returns the parsed JS value on get(), so we store
  // the parsed array directly — the same value that get() would return in production.
  seedLegacyString(key: string, ids: string[]): void {
    this.store.set(key, { type: 'string', value: ids });
  }

  // Inspect internal key type (test introspection only).
  internalType(key: string): 'string' | 'list' | 'none' {
    return this.store.get(key)?.type ?? 'none';
  }
}

let kvStore: TypeAwareKvStore;

vi.mock('../../api/_lib/kv', () => ({
  kv: () => kvStore,
}));

// Import helpers AFTER the mock is in place.
// Note: vi.mock() is hoisted, but the dynamic import below occurs after mock
// registration, which is all we need.
let readMonthIndex: (month: string) => Promise<string[]>;
let appendMonthIndex: (month: string, id: string) => Promise<void>;

beforeEach(async () => {
  kvStore = new TypeAwareKvStore();
  // Re-import to pick up a fresh mock each time.
  vi.resetModules();
  const mod = await import('../../api/_lib/kv-keys.js');
  readMonthIndex = (mod as any).readMonthIndex;
  appendMonthIndex = (mod as any).appendMonthIndex;
});

// ── Test 1: concurrent appends BOTH survive ──────────────────────────────────
describe('appendMonthIndex — concurrent append safety', () => {
  it('two simultaneous appends both survive (list semantics, no lost ids)', async () => {
    const month = '2026-06';
    // Fire both appends without awaiting either first — simulates concurrent writers
    await Promise.all([
      appendMonthIndex(month, 'T-2026-06-01-001'),
      appendMonthIndex(month, 'T-2026-06-01-002'),
    ]);
    const ids = await readMonthIndex(month);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('T-2026-06-01-001');
    expect(ids).toContain('T-2026-06-01-002');
  });

  it('sequential appends accumulate in order', async () => {
    const month = '2026-06';
    await appendMonthIndex(month, 'T-2026-06-01-001');
    await appendMonthIndex(month, 'T-2026-06-01-002');
    await appendMonthIndex(month, 'T-2026-06-01-003');
    const ids = await readMonthIndex(month);
    expect(ids).toEqual(['T-2026-06-01-001', 'T-2026-06-01-002', 'T-2026-06-01-003']);
  });
});

// ── Test 2: reader returns all ids ───────────────────────────────────────────
describe('readMonthIndex', () => {
  it('returns empty array for missing key', async () => {
    expect(await readMonthIndex('2026-05')).toEqual([]);
  });

  it('returns all ids from a fresh list key', async () => {
    await appendMonthIndex('2026-05', 'T-2026-05-15-001');
    await appendMonthIndex('2026-05', 'T-2026-05-15-002');
    const ids = await readMonthIndex('2026-05');
    expect(ids).toEqual(['T-2026-05-15-001', 'T-2026-05-15-002']);
  });
});

// ── Test 3: legacy string key migration ─────────────────────────────────────
describe('legacy month-index migration', () => {
  it('readMonthIndex reads a legacy JSON-array string key without throwing', async () => {
    const month = '2026-04';
    const key = `trades:index:${month}`;
    kvStore.seedLegacyString(key, ['T-2026-04-01-001', 'T-2026-04-01-002']);

    const ids = await readMonthIndex(month);
    expect(ids).toEqual(['T-2026-04-01-001', 'T-2026-04-01-002']);
  });

  it('readMonthIndex migrates the legacy key to a list in place', async () => {
    const month = '2026-04';
    const key = `trades:index:${month}`;
    kvStore.seedLegacyString(key, ['T-2026-04-01-001', 'T-2026-04-01-002']);

    await readMonthIndex(month);

    // After migration, the key must be a list type
    expect(kvStore.internalType(key)).toBe('list');
  });

  it('migrated key preserves all ids with no loss', async () => {
    const month = '2026-04';
    const key = `trades:index:${month}`;
    const originalIds = ['T-2026-04-01-001', 'T-2026-04-01-002', 'T-2026-04-15-003'];
    kvStore.seedLegacyString(key, originalIds);

    await readMonthIndex(month);

    // Second read via lrange must return exactly the same ids
    const afterMigration = await readMonthIndex(month);
    expect(afterMigration).toEqual(originalIds);
  });

  it('appendMonthIndex migrates then appends to a legacy string key', async () => {
    const month = '2026-04';
    const key = `trades:index:${month}`;
    kvStore.seedLegacyString(key, ['T-2026-04-01-001']);

    await appendMonthIndex(month, 'T-2026-04-30-002');

    // Key is now a list
    expect(kvStore.internalType(key)).toBe('list');
    // Both old and new ids are present
    const ids = await readMonthIndex(month);
    expect(ids).toContain('T-2026-04-01-001');
    expect(ids).toContain('T-2026-04-30-002');
  });

  it('two concurrent appends to a legacy key both survive after migration', async () => {
    const month = '2026-04';
    const key = `trades:index:${month}`;
    kvStore.seedLegacyString(key, ['T-2026-04-01-001']);

    // Both callers see the legacy key; the first migrates, the second sees a list.
    await Promise.all([
      appendMonthIndex(month, 'T-2026-04-30-002'),
      appendMonthIndex(month, 'T-2026-04-30-003'),
    ]);

    const ids = await readMonthIndex(month);
    expect(ids).toContain('T-2026-04-01-001');
    expect(ids).toContain('T-2026-04-30-002');
    expect(ids).toContain('T-2026-04-30-003');
  });
});
