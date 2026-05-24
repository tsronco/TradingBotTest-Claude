export const BOT_STATE_KEYS = [
  'bot:state:conservative',
  'bot:state:aggressive',
  'bot:state:manual',
  'bot:state:live',
  'bot:state:sm500',
  'bot:state:sm1000',
  'bot:state:sm2000',
  'bot:strategy:conservative',
  'bot:strategy:aggressive',
  'bot:strategy:manual',
  'bot:strategy:live',
  'bot:strategy:sm500',
  'bot:strategy:sm1000',
  'bot:strategy:sm2000',
  'bot:congress',
  'bot:rules:conservative',
  'bot:rules:aggressive',
  'bot:rules:manual',
  'bot:rules:live',
  'bot:rules:sm500',
  'bot:rules:sm1000',
  'bot:rules:sm2000',
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
  /^assignment-child:T-\d{4}-\d{2}-\d{2}-\d{3}$/,
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
  /^config:display_name$/,
  /^import:cursor:(conservative_paper|aggressive_paper|manual_paper|live|sm500_paper|sm1000_paper|sm2000_paper)$/,
];

export function isAllowedDashboardKey(key: string): boolean {
  return DASHBOARD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export const KV_KEYS = {
  watchlist: 'watchlist',
  totpThresholds: 'config:totp_thresholds',
  displayName: 'config:display_name',
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

export type Mode =
  | 'conservative'
  | 'aggressive'
  | 'manual'
  | 'live'
  | 'sm500'
  | 'sm1000'
  | 'sm2000';

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

export function assignmentChildKey(parentTradeId: string): string {
  return `assignment-child:${parentTradeId}`;
}

export function importCursorKey(account: string): string {
  return `import:cursor:${account}`;
}
