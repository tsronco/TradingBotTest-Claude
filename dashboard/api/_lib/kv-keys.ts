export const BOT_STATE_KEYS = [
  'bot:state:conservative',
  'bot:state:aggressive',
  'bot:strategy:conservative',
  'bot:strategy:aggressive',
  'bot:congress',
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
  /^grade:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
  /^trades:index:open$/,
  /^trades:index:\d{4}-\d{2}$/,
  /^trades:counter:\d{4}-\d{2}-\d{2}$/,
  /^tags:list$/,
  /^config:totp_thresholds$/,
  /^auth:backup_codes_hashed$/,
  /^auth:used-backup-codes$/,
  /^watchlist$/,
];

export function isAllowedDashboardKey(key: string): boolean {
  return DASHBOARD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export const KV_KEYS = {
  watchlist: 'watchlist',
  totpThresholds: 'config:totp_thresholds',
  sessionPrefix: 'session:',
  tagsList: 'tags:list',
  backupCodesHashed: 'auth:backup_codes_hashed',
  tradesIndexOpen: 'trades:index:open',
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
