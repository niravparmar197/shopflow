import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model } from 'mongoose';
import type { Env } from '@app/common';
import { captureTraceContext, scrapeGauge } from '@app/observability';
import { NotificationLog } from '../logs/notification-log.schema';
import {
  DEFAULT_JOB_OPTIONS,
  type NotificationCommand,
  NOTIFICATIONS_QUEUE,
} from './notification-command';

@Injectable()
export class CommandDispatcher {
  private readonly logger = new Logger(CommandDispatcher.name);
  private readonly backoffMs: number;

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    @InjectModel(NotificationLog.name)
    private readonly logs: Model<NotificationLog>,
    config: ConfigService<Env, true>,
  ) {
    this.backoffMs = config.get('NOTIFY_BACKOFF_MS', { infer: true });
    // Queue depth by state, read from Redis when Prometheus scrapes.
    scrapeGauge(
      'queue_jobs',
      'BullMQ jobs by state',
      ['queue', 'state'],
      async (g) => {
        const counts = await this.queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );
        for (const [state, n] of Object.entries(counts)) {
          g.set({ queue: NOTIFICATIONS_QUEUE, state }, n);
        }
      },
    );
  }

  /**
   * Enqueue FIRST, then log. A crash in between:
   *   log first     → a QUEUED log with no job: the email is lost for good
   *   enqueue first → the job exists; Kafka redelivers the event (offset not
   *                   committed), the duplicate add is ignored (same job id)
   *                   and the log gets written. Nothing is lost.
   */
  async dispatch(cmd: NotificationCommand) {
    // The job carries the log fields too: the worker may run before this
    // log is written (or we crash first), and must be able to create it.
    await this.queue.add(
      cmd.jobName,
      // + the trace: the worker continues it (BullMQ has no auto-tracing).
      { ...cmd.payload, log: cmd.log, trace: captureTraceContext() },
      {
        ...DEFAULT_JOB_OPTIONS,
        backoff: { type: 'exponential', delay: this.backoffMs },
        jobId: cmd.id,
      },
    );

    // $setOnInsert: never overwrites SENT if the worker was faster than us.
    await this.logs.updateOne(
      { key: cmd.id },
      {
        $setOnInsert: {
          key: cmd.id,
          ...cmd.log,
          status: 'QUEUED',
          attempts: 0,
        },
      },
      { upsert: true },
    );
    this.logger.log(`Queued ${cmd.jobName} ${cmd.id}`);
  }
}
