export const BOT_STATE_KEYS = [
  'bot:state:conservative',
  'bot:state:aggressive',
  'bot:state:manual',
  'bot:strategy:conservative',
  'bot:strategy:aggressive',
  'bot:strategy:manual',
  'bot:congress',
  'bot:rules:conservative',
  'bot:rules:aggressive',
  'bot:rules:manual',
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
  /^trades:index:assignments-pending$/,
  /^trades:index:\d{4}-\d{2}$/,
  /^trades:counter:\d{4}-\d{2}-\d{2}$/,
  /^tags:list$/,
  /^config:totp_thresholds$/,
  /^auth:backup_codes_hashed$/,
  /^auth:used-backup-codes$/,
  /^watchlist$/,
  /^rules:(manual|patterns|cheatsheets|goals|tendencies|proposals)$/,
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

export type Mode = 'conservative' | 'aggressive' | 'manual';

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
