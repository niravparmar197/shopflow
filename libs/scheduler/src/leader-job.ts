import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type Redis from 'ioredis';
import type { Env } from '@app/common';
import { type LockHandle, RedisLock } from './redis-lock';

export type TickResult =
  'ran' | 'failed' | 'skipped-overlap' | 'skipped-not-leader';

/** Passed to run(): check `lost` between batches and stop early if true. */
export interface JobContext {
  lost: boolean;
}

/** Env keys that hold a cron expression. */
export type CronEnvKey = {
  [K in keyof Env]-?: K extends `${string}_CRON` ? K : never;
}[keyof Env];

/*
 * TEMPLATE METHOD: tick() fixes the safety steps; a job only writes run().
 *
 *   Pitfall               Answer
 *   duplicates (N pods)   Redis lock: only the pod that gets it runs. Kept
 *                         until just before the next tick, not deleted when
 *                         run() ends: pods' timers fire a few ms apart, and a
 *                         late pod would find a freed lock and run the SAME
 *                         tick again
 *   overlap (one pod)     the `running` flag
 *   long jobs             heartbeat renews the lock at TTL/3; run() checks
 *                         ctx.lost between batches
 *   crash while locked    the lock's TTL: it expires by itself
 *   wrong-owner release   owner token + compare-and-delete (RedisLock)
 *   lock not 100 % safe   every row change in run() is conditional (fencing
 *                         in the DB), so a rare double run changes nothing
 *
 * Crons have 6 fields (the first is seconds) and run in UTC, so a daily job
 * fires at the same moment on a laptop and in a container.
 */
export abstract class LeaderJob
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);
  /** Also the lock key: unique across services (they share Redis). */
  protected abstract readonly name: string;
  protected abstract readonly cronEnvKey: CronEnvKey;
  protected abstract readonly defaultCron: string;
  protected readonly lockTtlMs: number = 30_000;
  /** The lock is let go this long before the next tick. */
  protected readonly releaseBeforeNextTickMs: number = 1_000;

  /** The real work. Returns a number for the log (rows changed). */
  protected abstract run(ctx: JobContext): Promise<number>;

  private running = false;
  private readonly locks: RedisLock;
  private cronJob?: CronJob;

  constructor(
    redis: Redis,
    private readonly scheduler: SchedulerRegistry,
    protected readonly config: ConfigService<Env, true>,
  ) {
    this.locks = new RedisLock(redis);
  }

  onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const cron =
      this.config.get(this.cronEnvKey, { infer: true }) ?? this.defaultCron;
    // An invalid expression throws here: the service fails at startup.
    const job = CronJob.from({
      cronTime: cron,
      onTick: () => void this.tick(),
      timeZone: 'UTC',
    });
    this.scheduler.addCronJob(this.name, job);
    job.start();
    this.cronJob = job;
    this.logger.log(`Scheduled "${this.name}" with cron "${cron}" (UTC)`);
  }

  onModuleDestroy() {
    if (this.scheduler.doesExist('cron', this.name)) {
      this.scheduler.deleteCronJob(this.name); // also stops it
    }
  }

  /** Public, so tests (or an admin "run now") can trigger a run. */
  async tick(): Promise<TickResult> {
    if (this.running) return 'skipped-overlap';
    this.running = true;
    try {
      let lock: LockHandle | null;
      try {
        lock = await this.locks.acquire(
          `lock:job:${this.name}`,
          this.lockTtlMs,
        );
      } catch (err) {
        // Redis down: skip this run; the next tick tries again.
        this.logger.error(
          `"${this.name}" couldn't take its lock: ${(err as Error).message}`,
        );
        return 'failed';
      }
      if (!lock) return 'skipped-not-leader';

      const ctx: JobContext = { lost: false };
      const heartbeat = setInterval(
        () => {
          void lock.renew().then(
            (mine) => mine || this.markLost(ctx),
            () => this.markLost(ctx),
          );
        },
        Math.floor(this.lockTtlMs / 3),
      );
      heartbeat.unref();

      const t0 = Date.now();
      try {
        const n = await this.run(ctx);
        this.logger.log(
          `"${this.name}" done in ${Date.now() - t0} ms, ${n} row(s)`,
        );
        return 'ran';
      } catch (err) {
        this.logger.error(`"${this.name}" failed: ${(err as Error).message}`);
        return 'failed';
      } finally {
        clearInterval(heartbeat);
        // Only if still ours: keep it until just before the next tick (so a
        // late pod can't rerun this one), or free it now.
        await lock.release(this.keepUntilNextTick()).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  /** ms to keep the lock after a run: 0 without a schedule (manual tick). */
  private keepUntilNextTick(): number {
    if (!this.cronJob) return 0;
    const next = this.cronJob.nextDate().toMillis();
    return Math.max(0, next - Date.now() - this.releaseBeforeNextTickMs);
  }

  private markLost(ctx: JobContext) {
    if (ctx.lost) return;
    ctx.lost = true;
    this.logger.error(
      `Lost the lock for "${this.name}" mid-run, stopping after this batch`,
    );
  }
}
