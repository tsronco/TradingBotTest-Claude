import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

export function kv(): Redis {
  if (!_redis) {
    _redis = Redis.fromEnv();   // reads KV_REST_API_URL + KV_REST_API_TOKEN
  }
  return _redis;
}

// Convenience helpers used across the codebase.
export async function getJson<T>(key: string): Promise<T | null> {
  return (await kv().get<T>(key)) ?? null;
}

export async function setJson<T>(key: string, value: T): Promise<void> {
  await kv().set(key, value);
}
