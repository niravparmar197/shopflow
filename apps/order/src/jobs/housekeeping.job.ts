import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { type Env, REDIS } from '@app/common';
import { type JobContext, LeaderJob } from '@app/scheduler';

const BATCH = 5_000;

/*
 * Tables that grow forever, trimmed in small batches (short locks, no huge
 * transaction, and the job can stop between batches if it loses its lock).
 *
 *   outbox            published > 7 days ago (the topics keep 7 days too)
 *   processed_events  > 14 days. Dedupe retention must be ≥ topic retention:
 *                     a duplicate can't arrive once the topic has dropped
 *                     the event. Shorten one → check the other.
 *   idempotency_keys  > 1 day: a retry with the same key after that is a
 *                     new request (Stripe keeps 24 h as well).
 */
@Injectable()
export class HousekeepingJob extends LeaderJob {
  protected readonly name = 'order-housekeeping';
  protected readonly cronEnvKey = 'HOUSEKEEPING_CRON' as const;
  protected readonly defaultCron = '0 15 * * * *'; // every hour at :15

  constructor(
    @Inject(REDIS) redis: Redis,
    scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
    private readonly ds: DataSource,
  ) {
    super(redis, scheduler, config);
  }

  protected async run(ctx: JobContext): Promise<number> {
    let total = 0;
    total += await this.deleteInBatches(
      ctx,
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox
          WHERE published_at < now() - interval '7 days' LIMIT ${BATCH})`,
    );
    total += await this.deleteInBatches(
      ctx,
      `DELETE FROM processed_events WHERE (consumer, event_id) IN (
         SELECT consumer, event_id FROM processed_events
          WHERE processed_at < now() - interval '14 days' LIMIT ${BATCH})`,
    );
    total += await this.deleteInBatches(
      ctx,
      `DELETE FROM idempotency_keys WHERE (user_id, key) IN (
         SELECT user_id, key FROM idempotency_keys
          WHERE created_at < now() - interval '1 day' LIMIT ${BATCH})`,
    );
    return total;
  }

  private async deleteInBatches(ctx: JobContext, sql: string) {
    let total = 0;
    while (!ctx.lost) {
      // TypeORM's postgres driver returns [rows, affected] for DELETE.
      const [, count] = await this.ds.query<[unknown[], number]>(sql);
      total += count;
      if (count < BATCH) break;
    }
    return total;
  }
}
