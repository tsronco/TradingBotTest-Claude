import { createHash, randomBytes } from 'node:crypto';
import { kv } from './kv.js';
import { KV_KEYS } from './kv-keys.js';

function normalize(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function hash(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

const USED_KEY = 'auth:used-backup-codes';

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
 * Returns true iff the input matches an unused backup code.
 * On match, the code is marked consumed atomically (idempotent if called twice).
 * Checks KV first; falls back to env var if KV is empty.
 */
export async function consumeBackupCodeIfValid(input: string): Promise<boolean> {
  if (!input) return false;
  const candidate = hash(input);
  const allowed = await loadAllowedHashes();
  if (!allowed.includes(candidate)) return false;
  const used = ((await kv().get<string[]>(USED_KEY)) ?? []);
  if (used.includes(candidate)) return false;
  used.push(candidate);
  await kv().set(USED_KEY, used);
  return true;
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

/** Generate and store 8 fresh backup codes in KV, clear used-codes list, return plaintext codes. */
export async function regenerateBackupCodes(): Promise<{ codes: string[] }> {
  const fresh = Array.from({ length: 8 }, () => generateBackupCode());
  await kv().set(KV_KEYS.backupCodesHashed, fresh.map((c) => c.hash));
  await kv().set(USED_KEY, []);
  return { codes: fresh.map((c) => c.code) };
}
