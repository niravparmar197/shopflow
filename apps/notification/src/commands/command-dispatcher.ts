import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { NotificationLog } from '../logs/notification-log.schema';
import {
  DEFAULT_JOB_OPTIONS,
  type NotificationCommand,
  NOTIFICATIONS_QUEUE,
} from './notification-command';

@Injectable()
export class CommandDispatcher {
  private readonly logger = new Logger(CommandDispatcher.name);

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    @InjectModel(NotificationLog.name)
    private readonly logs: Model<NotificationLog>,
  ) {}

  /**
   * Enqueue FIRST, then log. A crash in between:
   *   log first     → a QUEUED log with no job: the email is lost for good
   *   enqueue first → the job exists; Kafka redelivers the event (offset not
   *                   committed), the duplicate add is ignored (same job id)
   *                   and the log gets written. Nothing is lost.
   */
  async dispatch(cmd: NotificationCommand) {
    await this.queue.add(cmd.jobName, cmd.payload, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: cmd.id,
    });

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
