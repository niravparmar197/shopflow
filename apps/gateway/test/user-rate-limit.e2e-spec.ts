import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { SlidingWindowLimiter } from '../src/http/sliding-window';
import { userRateLimit } from '../src/http/user-rate-limit';

// The sliding-window limiter against a real Redis (from e2e-setup.ts).
describe('Per-user sliding-window rate limit (e2e)', () => {
  let redis: Redis;
  let limiter: SlidingWindowLimiter;
  const key = () => `rl:test:${randomUUID()}`;

  /** A tiny app: a fake JWT step (sets req.user), the limiter, a handler. */
  function appWith(
    client: Redis,
    rule = { name: 'orders', limit: 5, windowMs: 10_000 },
  ) {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const sub = req.header('x-test-user');
      if (sub)
        Object.assign(req, { user: { sub, email: '', role: 'customer' } });
      next();
    });
    app.use(userRateLimit(client, rule));
    app.all('/{*path}', (_req, res) => res.status(201).json({ ok: true }));
    return app;
  }

  beforeAll(() => {
    redis = new Redis(process.env.E2E_REDIS_URL!);
    limiter = new SlidingWindowLimiter(redis);
  });

  afterAll(() => redis?.quit());

  it('100 requests at the same moment → exactly 5 allowed (atomic check-and-add)', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => limiter.hit(k, 5, 10_000)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(await redis.zcard(k)).toBe(5); // denied requests aren't stored
  });

  it('counts down remaining, then says when to retry', async () => {
    const k = key();
    const remaining: number[] = [];
    for (let i = 0; i < 5; i++)
      remaining.push((await limiter.hit(k, 5, 10_000)).remaining);
    expect(remaining).toEqual([4, 3, 2, 1, 0]);

    const denied = await limiter.hit(k, 5, 10_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(9_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it('the window slides: only the requests that left it free up room', async () => {
    const k = key();
    for (let i = 0; i < 3; i++) await limiter.hit(k, 5, 1_000); // t ≈ 0
    await sleep(600);
    for (let i = 0; i < 2; i++) await limiter.hit(k, 5, 1_000); // t ≈ 600
    expect((await limiter.hit(k, 5, 1_000)).allowed).toBe(false); // full

    await sleep(500); // t ≈ 1100: the first 3 left the window, the last 2 didn't
    const after = await Promise.all(
      Array.from({ length: 5 }, () => limiter.hit(k, 5, 1_000)),
    );
    // A fixed window would have reset to 5 here.
    expect(after.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('every key expires by itself (idle users cost no memory)', async () => {
    const k = key();
    await limiter.hit(k, 5, 10_000);
    const ttl = await redis.pttl(k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('middleware: 6th POST → 429 RATE_LIMITED with Retry-After; per user; reads untouched', async () => {
    const app = appWith(redis);
    const alice = randomUUID();
    const bob = randomUUID();
    const post = (user: string) =>
      request(app).post('/v1/orders').set('x-test-user', user);

    for (let i = 0; i < 5; i++) {
      const ok = await post(alice).expect(201);
      expect(ok.headers['ratelimit-limit']).toBe('5');
      expect(ok.headers['ratelimit-remaining']).toBe(String(4 - i));
    }
    const res = await post(alice).expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(9);
    expect(res.body).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.any(String),
      details: { limit: 5, windowMs: 10_000, retryAfterMs: expect.any(Number) },
    });
    expect(res.body).toHaveProperty('correlationId');

    await post(bob).expect(201); // another user isn't affected
    await request(app).get('/v1/orders').set('x-test-user', alice).expect(201);
  });

  it('Redis down → fails OPEN (the shop keeps working)', async () => {
    // Nothing listens on port 1; fail fast like the gateway's real client.
    const dead = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    try {
      await request(appWith(dead))
        .post('/v1/orders')
        .set('x-test-user', randomUUID())
        .expect(201);
    } finally {
      dead.disconnect();
    }
  });
});
