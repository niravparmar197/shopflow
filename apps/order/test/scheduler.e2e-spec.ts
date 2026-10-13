import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { type Env, REDIS } from '@app/common';
import { type JobContext, LeaderJob, type TickResult } from '@app/scheduler';
import { OrderExpiryJob } from '../src/jobs/order-expiry.job';
import { OrderStatus } from '../src/orders/order-status';
import { startOrderApp } from './helpers';

// ---------- a test-only job, to probe LeaderJob's lock behaviour ----------
const shared = { active: 0, maxActive: 0 }; // across instances ("pods")

class SlowJob extends LeaderJob {
  protected readonly name = 'test-slow';
  // Never read: jobs are off in tests, so nothing gets scheduled.
  protected readonly cronEnvKey = 'HOUSEKEEPING_CRON' as const;
  protected readonly defaultCron = '0 0 0 1 1 *';
  protected readonly lockTtlMs: number;
  batchesDone = 0;
  sawLost = false;

  constructor(
    redis: Redis,
    scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
    private readonly opts: { ttlMs: number; batches: number; batchMs: number },
  ) {
    super(redis, scheduler, config);
    this.lockTtlMs = opts.ttlMs;
  }

  protected async run(ctx: JobContext): Promise<number> {
    shared.active++;
    shared.maxActive = Math.max(shared.maxActive, shared.active);
    try {
      for (let i = 0; i < this.opts.batches; i++) {
        if (ctx.lost) {
          this.sawLost = true;
          break;
        }
        await sleep(this.opts.batchMs);
        this.batchesDone++;
      }
      return this.batchesDone;
    } finally {
      shared.active--;
    }
  }
}

// Three copies of the real order service on the same PostgreSQL and Redis,
// like three pods. Jobs are off (JOBS_ENABLED=false): the test ticks them.
describe('Scheduler + order expiry (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  let pods: INestApplication[];

  const slowJob = (opts: { ttlMs: number; batches: number; batchMs: number }) =>
    new SlowJob(
      redis,
      ctx.app.get(SchedulerRegistry),
      ctx.app.get(ConfigService),
      opts,
    );

  /** An order row straight in the DB, aged as asked. */
  async function seed(
    status: string,
    createdAgoMin: number,
    confirmedAgoMin: number | null = null,
  ) {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO orders (id, user_id, status, subtotal_paise, discount_paise, total_paise,
                           currency, version, created_at, confirmed_at)
       VALUES ($1, $2, $3, 1000, 0, 1000, 'INR', 1,
               now() - make_interval(mins => $4::int),
               now() - make_interval(mins => $5::int))`,
      [id, randomUUID(), status, createdAgoMin, confirmedAgoMin],
    );
    return id;
  }
  const seedMany = (
    n: number,
    status: string,
    createdAgoMin: number,
    confirmedAgoMin: number | null = null,
  ) =>
    Promise.all(
      Array.from({ length: n }, () =>
        seed(status, createdAgoMin, confirmedAgoMin),
      ),
    );

  const statusOf = (ids: string[]) =>
    ds.query<{ status: string; failure_reason: string | null; n: number }[]>(
      `SELECT status, failure_reason, count(*)::int AS n FROM orders
        WHERE id = ANY($1) GROUP BY status, failure_reason`,
      [ids],
    );

  beforeAll(async () => {
    ctx = await startOrderApp();
    ds = ctx.app.get(DataSource);
    redis = ctx.app.get(REDIS);
    pods = [ctx.app, await ctx.spawn(), await ctx.spawn()];
  });

  afterAll(async () => {
    if (!ctx) return;
    await ds.query('TRUNCATE order_items, orders, outbox CASCADE');
    await ctx.close(); // also closes the spawned copies
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE order_items, orders, outbox CASCADE');
    await redis.flushdb(); // locks from earlier tests
    shared.active = 0;
    shared.maxActive = 0;
  });

  // ---------- the "Done when" ----------
  it('3 copies × 5 rounds → every stale order cancelled exactly once, nothing else touched', async () => {
    const stalePending = await seedMany(150, 'PENDING', 20);
    const staleConfirmed = await seedMany(150, 'CONFIRMED', 60, 45);
    const freshPending = await seedMany(10, 'PENDING', 1);
    const freshConfirmed = await seedMany(10, 'CONFIRMED', 5, 5);
    const oldPaid = await seedMany(10, 'PAID', 120, 100);

    const jobs = pods.map((p) => p.get(OrderExpiryJob));
    const rounds: TickResult[][] = [];
    for (let round = 0; round < 5; round++) {
      // All 3 "pods" fire at the same moment.
      rounds.push(await Promise.all(jobs.map((j) => j.tick())));
    }
    // Each round: one pod ran, two skipped.
    for (const r of rounds) {
      expect(r.filter((x) => x === 'ran')).toHaveLength(1);
    }

    // Exactly ONE order.cancelled per stale order.
    const perOrder = await ds.query<{ n: number }[]>(
      `SELECT aggregate_id, count(*)::int AS n FROM outbox
        WHERE event_type = 'order.cancelled' GROUP BY aggregate_id`,
    );
    expect(perOrder).toHaveLength(300);
    expect(perOrder.every((r) => r.n === 1)).toBe(true);

    expect(await statusOf(stalePending)).toEqual([
      { status: 'CANCELLED', failure_reason: 'STOCK_TIMEOUT', n: 150 },
    ]);
    expect(await statusOf(staleConfirmed)).toEqual([
      { status: 'CANCELLED', failure_reason: 'PAYMENT_TIMEOUT', n: 150 },
    ]);
    // The job only touches what it should.
    expect(await statusOf(freshPending)).toEqual([
      { status: 'PENDING', failure_reason: null, n: 10 },
    ]);
    expect(await statusOf(freshConfirmed)).toEqual([
      { status: 'CONFIRMED', failure_reason: null, n: 10 },
    ]);
    expect(await statusOf(oldPaid)).toEqual([
      { status: 'PAID', failure_reason: null, n: 10 },
    ]);
  });

  it('even WITHOUT the lock, DB fencing keeps it exactly once', async () => {
    await seedMany(200, 'PENDING', 20);
    const jobs = pods.map((p) => p.get(OrderExpiryJob));
    const pendingRule = jobs[0].rules.find(
      (r) => r.status === OrderStatus.PENDING,
    )!;

    // Bypass tick() → no Redis lock at all: 3 pods × 3 batches at once.
    const counts = await Promise.all(
      jobs.flatMap((j) => [
        j.expireBatch(pendingRule),
        j.expireBatch(pendingRule),
        j.expireBatch(pendingRule),
      ]),
    );

    expect(counts.reduce((a, b) => a + b, 0)).toBe(200);
    const [{ n, distinct }] = await ds.query<{ n: number; distinct: number }[]>(
      `SELECT count(*)::int AS n, count(DISTINCT aggregate_id)::int AS distinct
         FROM outbox WHERE event_type = 'order.cancelled'`,
    );
    expect(n).toBe(200);
    expect(distinct).toBe(200);
  });

  // ---------- the lock itself ----------
  it('3 instances tick together → exactly one runs', async () => {
    const jobs = [0, 1, 2].map(() =>
      slowJob({ ttlMs: 5_000, batches: 3, batchMs: 200 }),
    );
    const results = await Promise.all(jobs.map((j) => j.tick()));

    expect(results.filter((r) => r === 'ran')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped-not-leader')).toHaveLength(2);
    expect(shared.maxActive).toBe(1);
  });

  it('the same instance ticks twice → the second is skipped (overlap)', async () => {
    const job = slowJob({ ttlMs: 5_000, batches: 3, batchMs: 200 });
    const results = await Promise.all([job.tick(), job.tick()]);
    expect(results.sort()).toEqual(['ran', 'skipped-overlap']);
  });

  it('a job longer than the TTL → the heartbeat keeps the lock', async () => {
    // 3 s of work, 0.9 s TTL: without renewals the lock would expire 3 times.
    const longJob = slowJob({ ttlMs: 900, batches: 10, batchMs: 300 });
    const other = slowJob({ ttlMs: 900, batches: 1, batchMs: 10 });

    const running = longJob.tick();
    await sleep(2_000); // well past the TTL
    expect(await other.tick()).toBe('skipped-not-leader');
    expect(await running).toBe('ran');
    expect(longJob.sawLost).toBe(false);
    expect(longJob.batchesDone).toBe(10);
    expect(shared.maxActive).toBe(1);
  });

  it('a crashed pod holds the lock → after the TTL another pod takes over', async () => {
    // Crashed: took the lock, never released it.
    await redis.set('lock:job:test-slow', 'dead-pod', 'PX', 1_000, 'NX');
    const job = slowJob({ ttlMs: 5_000, batches: 1, batchMs: 10 });

    expect(await job.tick()).toBe('skipped-not-leader');
    await sleep(1_200);
    expect(await job.tick()).toBe('ran');
  });

  it("the lock is stolen mid-run → the job stops early and doesn't delete the new owner's lock", async () => {
    const job = slowJob({ ttlMs: 900, batches: 20, batchMs: 200 }); // ~4 s
    const running = job.tick();

    await sleep(500);
    // Someone else owns it now (e.g. ours expired during a long GC pause).
    await redis.set('lock:job:test-slow', 'other-pod', 'PX', 10_000);

    expect(await running).toBe('ran');
    expect(job.sawLost).toBe(true);
    expect(job.batchesDone).toBeLessThan(20);
    // Our release was a no-op: the owner check saw another token.
    expect(await redis.get('lock:job:test-slow')).toBe('other-pod');
  });
});
