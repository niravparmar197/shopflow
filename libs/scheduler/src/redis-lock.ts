import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

// Only the OWNER (same token) may renew or release. One Lua script = one
// atomic step in Redis: nobody can take the lock between the GET and the
// PEXPIRE / DEL.
const RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

// ARGV[2] = keep it this many ms more (0 = delete now).
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
if tonumber(ARGV[2]) > 0 then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return redis.call("DEL", KEYS[1])`;

export class LockHandle {
  constructor(
    private readonly redis: Redis,
    readonly key: string,
    readonly token: string,
    private readonly ttlMs: number,
  ) {}

  /** true = still ours, TTL extended. false = LOST (expired, maybe taken). */
  async renew(): Promise<boolean> {
    const res = await this.redis.eval(
      RENEW_LUA,
      1,
      this.key,
      this.token,
      String(this.ttlMs),
    );
    return res === 1;
  }

  /**
   * Frees it, only if it's still ours (a slow release can't free B's lock).
   * `keepMs` > 0: don't free it yet, let it expire in keepMs instead.
   */
  async release(keepMs = 0): Promise<boolean> {
    const res = await this.redis.eval(
      RELEASE_LUA,
      1,
      this.key,
      this.token,
      String(Math.max(0, Math.floor(keepMs))),
    );
    return res === 1;
  }
}

/**
 * A lease in Redis: at most one holder at a time, and it expires by itself
 * if the holder dies.
 *
 * It's for EFFICIENCY (don't do the work 3 times), not correctness: a GC
 * pause or network split can still let two holders overlap for a moment.
 * Correctness comes from the database (conditional updates, row locks).
 */
export class RedisLock {
  constructor(private readonly redis: Redis) {}

  /**
   * SET key token NX PX ttl: "only if nobody has it" + the expiry in ONE
   * command. SETNX then EXPIRE would leave a lock that never expires if we
   * crashed in between.
   */
  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const token = randomUUID();
    const ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? new LockHandle(this.redis, key, token, ttlMs) : null;
  }
}
