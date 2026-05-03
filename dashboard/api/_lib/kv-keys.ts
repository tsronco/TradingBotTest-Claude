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

export const KV_KEYS = {
  watchlist: 'watchlist',
  totpThresholds: 'config:totp_thresholds',
  sessionPrefix: 'session:',
} as const;
