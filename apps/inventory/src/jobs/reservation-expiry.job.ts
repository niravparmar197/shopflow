import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { type Env, REDIS } from '@app/common';
import { type JobContext, LeaderJob } from '@app/scheduler';
import { holdsReleased } from '../metrics';
import { ReservationService } from '../reservations/reservation.service';

const BATCH = 100;

/**
 * The last safety net: stock held past its expiry (60 min, longer than any
 * order can live) goes back on sale. Normally order.paid / order.cancelled
 * settle every hold long before that.
 */
@Injectable()
export class ReservationExpiryJob extends LeaderJob {
  protected readonly name = 'reservation-expiry';
  protected readonly cronEnvKey = 'RESERVATION_EXPIRY_CRON' as const;
  // Every minute at :30, so it doesn't run at the same second as order-expiry.
  protected readonly defaultCron = '30 * * * * *';

  constructor(
    @Inject(REDIS) redis: Redis,
    scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
    private readonly ds: DataSource,
    private readonly reservations: ReservationService,
  ) {
    super(redis, scheduler, config);
  }

  protected async run(ctx: JobContext): Promise<number> {
    let total = 0;
    while (!ctx.lost) {
      const n = await this.releaseBatch();
      total += n;
      if (n < BATCH) break;
    }
    return total;
  }

  /** One batch in one short transaction. Public for tests. */
  async releaseBatch(): Promise<number> {
    const n = await this.ds.transaction((m) =>
      this.reservations.releaseExpired(m, BATCH),
    );
    if (n) holdsReleased.inc({ reason: 'hold_expired' }, n); // after commit
    return n;
  }
}
