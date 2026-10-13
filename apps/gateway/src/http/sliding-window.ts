import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/*
 * Sliding LOG: the time of every request in the window, in a sorted set.
 * Exact (no boundary burst like a fixed window: 5 at :09.9 + 5 at :10.1),
 * at one entry per request: fine for small per-user limits.
 *
 * All in ONE atomic step inside Redis. "Count, then add" as two commands is
 * a race: two requests both read 4, both add, and the user gets 6.
 *   1. drop entries older than the window
 *   2. count what's left
 *   3. allowed → add this request; denied → when the oldest one leaves
 * The clock is Redis's (TIME), not each gateway pod's: no skew between pods.
 */
const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}
`;

export interface WindowResult {
  allowed: boolean;
  remaining: number;
  /** 0 when allowed; else ms until the oldest request leaves the window. */
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<WindowResult> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(windowMs),
      String(limit),
      // The member must be unique: a sorted set keeps one copy, so two
      // requests in the same ms with member = now would count as one.
      randomUUID(),
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
