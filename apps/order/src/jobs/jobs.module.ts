import { Module } from '@nestjs/common';
import { HousekeepingJob } from './housekeeping.job';

/** Scheduled jobs. Every pod schedules them; a Redis lock picks who runs. */
@Module({ providers: [HousekeepingJob] })
export class JobsModule {}
