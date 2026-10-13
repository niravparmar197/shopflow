import { Module } from '@nestjs/common';
import { HousekeepingJob } from './housekeeping.job';
import { OrderExpiryJob } from './order-expiry.job';

/** Scheduled jobs. Every pod schedules them; a Redis lock picks who runs. */
@Module({ providers: [HousekeepingJob, OrderExpiryJob] })
export class JobsModule {}
