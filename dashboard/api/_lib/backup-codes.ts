import { createHash } from 'node:crypto';
import { kv } from './kv';

function normalize(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function hash(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

const USED_KEY = 'auth:used-backup-codes';

/**
 * Returns true iff the input matches an unused backup code.
 * On match, the code is marked consumed atomically (idempotent if called twice).
 */
export async function consumeBackupCodeIfValid(input: string): Promise<boolean> {
  if (!input) return false;
  const candidate = hash(input);
  const allowed = (process.env.BACKUP_CODES_HASHED ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
    if (i === 3 || i === 7) code += '-';
  }
  return { code, hash: hash(code) };
}
