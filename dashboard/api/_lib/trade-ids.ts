import { kv } from './kv.js';
import { tradesCounterKey } from './kv-keys.js';

export function currentDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export async function allocateTradeId(now: Date = new Date()): Promise<string> {
  const day = currentDay(now);
  const seq = await kv().incr(tradesCounterKey(day));
  return `T-${day}-${pad3(Number(seq))}`;
}
