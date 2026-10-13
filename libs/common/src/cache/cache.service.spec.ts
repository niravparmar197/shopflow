import { CacheService } from './cache.service';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: string, _ex: string, _ttl: number) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    del: jest.fn((...ks: string[]) => {
      ks.forEach((k) => store.delete(k));
      return Promise.resolve(ks.length);
    }),
    incr: jest.fn((k: string) => {
      const next = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(next));
      return Promise.resolve(next);
    }),
  };
}

const down = () => Promise.reject(new Error('Redis down'));

describe('CacheService', () => {
  it('loads once, then serves from the cache', async () => {
    const cache = new CacheService(fakeRedis() as any);
    const loader = jest.fn(() => Promise.resolve({ id: 1 }));

    await cache.getOrSet('k', 60, loader);
    const second = await cache.getOrSet('k', 60, loader);

    expect(second).toEqual({ id: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('single-flight: 50 parallel misses run the loader once', async () => {
    const cache = new CacheService(fakeRedis() as any);
    const loader = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { id: 1 };
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => cache.getOrSet('hot', 60, loader)),
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.id === 1)).toBe(true);
  });

  it('a failed load is not cached and the next call retries', async () => {
    const cache = new CacheService(fakeRedis() as any);
    const loader = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: 2 });

    await expect(cache.getOrSet('k', 60, loader)).rejects.toThrow('db down');
    await expect(cache.getOrSet('k', 60, loader)).resolves.toEqual({ id: 2 });
  });

  it('caches "not found" when a negative TTL is set', async () => {
    const redis = fakeRedis();
    const cache = new CacheService(redis as any);
    const loader = jest.fn(() => Promise.resolve(null));

    await cache.getOrSet('missing', 60, loader, { negativeTtlSec: 30 });
    const second = await cache.getOrSet('missing', 60, loader, {
      negativeTtlSec: 30,
    });

    expect(second).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.store.get('missing')).toBe('__null__');
    expect(redis.set).toHaveBeenCalledWith('missing', '__null__', 'EX', 30);
  });

  it('does not cache "not found" without a negative TTL', async () => {
    const redis = fakeRedis();
    const cache = new CacheService(redis as any);
    await cache.getOrSet('missing', 60, () => Promise.resolve(null));
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('adds 0-20% jitter to the TTL', async () => {
    const redis = fakeRedis();
    const cache = new CacheService(redis as any);
    for (let i = 0; i < 20; i++) {
      await cache.getOrSet(`j${i}`, 100, () => Promise.resolve({ a: 1 }));
    }
    for (const [, , , ttl] of redis.set.mock.calls) {
      expect(ttl).toBeGreaterThanOrEqual(100);
      expect(ttl).toBeLessThanOrEqual(120);
    }
  });

  it('fails open when Redis is down', async () => {
    const broken = {
      get: jest.fn(down),
      set: jest.fn(down),
      del: jest.fn(down),
    };
    const cache = new CacheService(broken as any);

    await expect(
      cache.getOrSet('k', 60, () => Promise.resolve({ fromDb: true })),
    ).resolves.toEqual({ fromDb: true });
    await expect(cache.del('k')).resolves.toBeUndefined();
  });

  it('version keys: start at 0, bump, and degrade when Redis is down', async () => {
    const cache = new CacheService(fakeRedis() as any);
    expect(await cache.getVersion('list')).toBe('0');
    await cache.bumpVersion('list');
    expect(await cache.getVersion('list')).toBe('1');

    const broken = new CacheService({
      get: jest.fn(down),
      incr: jest.fn(down),
    } as any);
    expect(await broken.getVersion('list')).toBe('nocache');
    await expect(broken.bumpVersion('list')).resolves.toBeUndefined();
  });
});
