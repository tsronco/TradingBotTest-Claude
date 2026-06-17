import { createHash, randomBytes } from 'node:crypto';
import { kv } from './kv.js';
import { KV_KEYS } from './kv-keys.js';

function normalize(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function hash(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

/**
 * Legacy key (JSON array) written by the old read-modify-write implementation.
 * Checked read-only during the migration window so previously-consumed codes
 * remain rejected even before a key rotation.
 */
const USED_KEY_LEGACY = 'auth:used-backup-codes';

/**
 * Current key (Redis SET). Consumption is a single atomic SADD:
 *   returns 1  → member was newly added   → code is valid, now consumed
 *   returns 0  → member already in set    → code was already used, reject
 * No read-modify-write, no race window.
 */
const USED_KEY_V2 = 'auth:used-backup-codes:v2';

async function loadAllowedHashes(): Promise<string[]> {
  const fromKv = await kv().get<string[]>(KV_KEYS.backupCodesHashed);
  if (Array.isArray(fromKv) && fromKv.length > 0) return fromKv;
  const fromEnv = (process.env.BACKUP_CODES_HASHED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv;
}

/**
 * Returns true iff the input matches an unused backup code and atomically
 * marks it consumed.  Single-use guarantee is enforced via Redis SADD:
 * the first concurrent caller that SADDs the hash wins; all subsequent callers
 * see SADD return 0 (already-member) and are rejected.
 *
 * Migration: also checks the legacy JSON-array key written by the old
 * read-modify-write implementation.  A code found in the legacy list is
 * rejected even if the v2 SET hasn't recorded it yet — conservative and safe.
 *
 * Checks KV first; falls back to env var if KV is empty.
 */
export async function consumeBackupCodeIfValid(input: string): Promise<boolean> {
  if (!input) return false;
  const candidate = hash(input);

  const allowed = await loadAllowedHashes();
  if (!allowed.includes(candidate)) return false;

  // Migration check: if the legacy JSON-array key has this hash, reject.
  const legacyUsed = await kv().get<string[]>(USED_KEY_LEGACY);
  if (Array.isArray(legacyUsed) && legacyUsed.includes(candidate)) return false;

  // Atomic consumption: SADD returns the number of elements actually added.
  //   1 → newly added to the set → first use, accept.
  //   0 → already in the set    → previously consumed (or concurrent dupe), reject.
  const added = await kv().sadd(USED_KEY_V2, candidate);
  return added === 1;
}

/** True if the input *looks* like a backup code (not a 6-digit TOTP). */
export function looksLikeBackupCode(input: string): boolean {
  const cleaned = normalize(input);
  return cleaned.length >= 10 && /^[A-Z0-9]+$/.test(cleaned);
}

/** Used at setup time only — generate a fresh code and its hash. Logged once, never stored plaintext. */
export function generateBackupCode(): { code: string; hash: string } {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // omit confusing 0/O/1/I
  const bytes = randomBytes(12);
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars[bytes[i] % chars.length];
    if (i === 3 || i === 7) code += '-';
  }
  return { code, hash: hash(code) };
}

/**
 * Generate and store 8 fresh backup codes in KV, clear both the legacy
 * JSON-array key and the v2 SET key, return plaintext codes.
 */
export async function regenerateBackupCodes(): Promise<{ codes: string[] }> {
  const fresh = Array.from({ length: 8 }, () => generateBackupCode());
  await kv().set(KV_KEYS.backupCodesHashed, fresh.map((c) => c.hash));
  // Delete both used-code stores so the new codes start with a clean slate.
  await kv().del(USED_KEY_LEGACY);
  await kv().del(USED_KEY_V2);
  return { codes: fresh.map((c) => c.code) };
}
