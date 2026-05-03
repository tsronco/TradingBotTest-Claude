import { generateBackupCode } from '../api/_lib/backup-codes';

console.log('=== Backup codes — store these somewhere safe ===');
console.log('Each code can be used once in place of your TOTP.\n');

const hashes: string[] = [];
for (let i = 1; i <= 8; i++) {
  const { code, hash } = generateBackupCode();
  console.log(`${i}. ${code}`);
  hashes.push(hash);
}

console.log('\n=== Add this to Vercel env vars ===');
console.log(`BACKUP_CODES_HASHED=${hashes.join(',')}`);
