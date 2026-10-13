import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

// Stored for "not found", so repeated lookups of missing items skip the DB.
const NULL_MARKER = '__null__';
const TTL_JITTER = 0.2; // up to +20%, so keys cached together don't expire together

/**
 * Cache-aside on Redis. Values go through JSON, so Dates come back as ISO
 * strings and ObjectIds as hex strings.
 *
 * Every Redis error is logged and ignored (fail open): with Redis down,
 * reads simply go to the database.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  // Single-flight: loads in progress in this process, by key.
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Returns the cached value, or loads it (once per key at a time) and caches it. */
  async getOrSet<T>(
    key: string,
    ttlSec: number,
    loader: () => Promise<T | null>,
    opts: { negativeTtlSec?: number } = {},
  ): Promise<T | null> {
    const cached = await this.safeGet(key);
    if (cached !== undefined) {
      this.logger.debug({ key }, 'cache hit');
      return cached === NULL_MARKER ? null : (JSON.parse(cached) as T);
    }

    // If this key is already loading, wait for that load instead of starting
    // another: a popular key expiring then costs one DB query, not hundreds.
    // Per process only; across instances you'd need a Redis lock.
    const running = this.inFlight.get(key) as Promise<T | null> | undefined;
    if (running) return running;

    const load = (async () => {
      this.logger.debug({ key }, 'cache miss, loading from DB');
      const value = await loader();
      if (value !== null) {
        await this.safeSet(key, JSON.stringify(value), this.jitter(ttlSec));
      } else if (opts.negativeTtlSec) {
        await this.safeSet(key, NULL_MARKER, opts.negativeTtlSec);
      }
      return value;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, load);
    return load;
  }

  async del(...keys: string[]) {
    if (!keys.length) return;
    try {
      await this.redis.del(...keys);
    } catch (err: unknown) {
      this.logger.warn({ err, keys }, 'cache delete failed');
    }
  }

  /**
   * Version counter for a group of keys (e.g. every cached product list).
   * Put it in the key; bumping it makes all old keys unused at once.
   */
  async getVersion(name: string): Promise<string> {
    try {
      return (await this.redis.get(`ver:${name}`)) ?? '0';
    } catch {
      return 'nocache'; // Redis is down; the read that follows fails open too
    }
  }

  async bumpVersion(name: string) {
    try {
      await this.redis.incr(`ver:${name}`);
    } catch (err: unknown) {
      this.logger.warn({ err, name }, 'cache version bump failed');
    }
  }

  private async safeGet(key: string): Promise<string | undefined> {
    try {
      return (await this.redis.get(key)) ?? undefined;
    } catch (err: unknown) {
      this.logger.warn({ err, key }, 'cache read failed, using DB');
      return undefined;
    }
  }

  private async safeSet(key: string, value: string, ttlSec: number) {
    try {
      await this.redis.set(key, value, 'EX', ttlSec);
    } catch (err: unknown) {
      this.logger.warn({ err, key }, 'cache write failed');
    }
  }

  private jitter(ttlSec: number) {
    return Math.round(ttlSec * (1 + Math.random() * TTL_JITTER));
  }
}
