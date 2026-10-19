import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { type Env, REDIS } from '@app/common';
import { type JobContext, LeaderJob } from '@app/scheduler';

const BATCH = 5_000;

/*
 * Trims the user service's growing tables (Phase 2 P3), in small batches.
 *
 *   outbox          published > 1 day ago. Shorter than the order service's
 *                   7 days on purpose: reset / verify events hold a raw
 *                   one-time token, so don't keep them around (user-events
 *                   keeps 1 day in Kafka too).
 *   account_tokens  expired or used > 7 days ago (kept a week for support).
 *   refresh_tokens  expired > 7 days ago.
 */
@Injectable()
export class AccountHousekeepingJob extends LeaderJob {
  protected readonly name = 'user-housekeeping';
  protected readonly cronEnvKey = 'HOUSEKEEPING_CRON' as const;
  protected readonly defaultCron = '0 25 * * * *'; // every hour at :25

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
          WHERE published_at < now() - interval '1 day' LIMIT ${BATCH})`,
    );
    total += await this.deleteInBatches(
      ctx,
      `DELETE FROM account_tokens WHERE id IN (
         SELECT id FROM account_tokens
          WHERE COALESCE(used_at, expires_at) < now() - interval '7 days'
          LIMIT ${BATCH})`,
    );
    total += await this.deleteInBatches(
      ctx,
      `DELETE FROM refresh_tokens WHERE id IN (
         SELECT id FROM refresh_tokens
          WHERE expires_at < now() - interval '7 days' LIMIT ${BATCH})`,
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
