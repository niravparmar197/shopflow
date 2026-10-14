import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { SpanKind } from '@opentelemetry/api';
import { type Job, UnrecoverableError } from 'bullmq';
import { Model } from 'mongoose';
import { inSpan, restoreTraceContext } from '@app/observability';
import {
  type NotificationCommand,
  NOTIFICATIONS_QUEUE,
} from '../commands/notification-command';
import {
  COMMAND_HANDLERS,
  type CommandHandler,
} from '../handlers/command-handler';
import { NotificationLog } from '../logs/notification-log.schema';
import { notificationsSent } from '../metrics';

type JobData = Record<string, unknown> & {
  // Missing on jobs queued before the log travelled with the job.
  log?: NotificationCommand['log'];
  // The trace of the event that queued it (missing on older jobs).
  trace?: Record<string, string>;
};

/*
 * Executes the queued commands.
 *   1. already SENT in the log? → skip (a retry after a crash must not
 *      email twice)
 *   2. the handler for job.name executes the command
 *   3. log → SENT
 * On error: UnrecoverableError (SMTP 5xx, unknown template) → FAILED now;
 * anything else → retried in 2 s, 4 s, 8 s, then FAILED.
 *
 * Delivery is AT LEAST ONCE: if we crash after sending but before the log
 * says SENT, the retry sends again. SMTP has no idempotency key, so exactly
 * once is impossible; the SENT check keeps duplicates rare, and a rare
 * duplicate beats a lost email.
 */
@Processor(NOTIFICATIONS_QUEUE, {
  concurrency: 5, // jobs at once per pod
  limiter: { max: 10, duration: 1_000 }, // ≤ 10 emails/s (providers have send limits)
})
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);
  private readonly handlers: Map<string, CommandHandler>;

  constructor(
    @Inject(COMMAND_HANDLERS) handlers: CommandHandler[],
    @InjectModel(NotificationLog.name)
    private readonly logs: Model<NotificationLog>,
  ) {
    super();
    this.handlers = new Map(handlers.map((h) => [h.jobName, h]));
  }

  process(job: Job<JobData>): Promise<void> {
    const { trace, log, ...payload } = job.data;
    // A span in the trace of the event that queued the job.
    return inSpan(
      `job ${job.name}`,
      {
        kind: SpanKind.CONSUMER,
        parent: restoreTraceContext(trace),
        attributes: {
          'shopflow.order_id': log?.orderId ?? '',
          'job.id': job.id ?? '',
          'job.attempt': job.attemptsMade + 1,
        },
      },
      () => this.send(job, log, payload),
    );
  }

  private async send(
    job: Job<JobData>,
    log: JobData['log'],
    payload: Record<string, unknown>,
  ) {
    const key = job.id!;

    // Create the log if the dispatcher hasn't yet; count this attempt.
    const current = await this.logs.findOneAndUpdate(
      { key },
      {
        $setOnInsert: { key, ...log, status: 'QUEUED' },
        $set: { attempts: job.attemptsMade + 1 },
      },
      { upsert: true, returnDocument: 'after' },
    );

    // Sent already (we crashed AFTER sending, BEFORE BullMQ marked the job
    // done) → don't send twice.
    if (current?.status === 'SENT') {
      this.logger.warn(`${key} already SENT, skipping`);
      return;
    }

    const handler = this.handlers.get(job.name);
    if (!handler)
      throw new UnrecoverableError(`No handler for job "${job.name}"`);

    await handler.execute(payload, key);

    await this.logs.updateOne(
      { key },
      {
        $set: { status: 'SENT', sentAt: new Date() },
        $unset: { lastError: 1 },
      },
    );
    notificationsSent.inc({
      template: log?.template ?? current?.template ?? 'unknown',
      status: 'sent',
    });
    this.logger.log(`Sent ${job.name} ${key} → ${current?.to ?? '?'}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<JobData> | undefined, err: Error) {
    if (!job) return;
    const permanent =
      err instanceof UnrecoverableError || err.name === 'UnrecoverableError';
    const final = permanent || job.attemptsMade >= (job.opts.attempts ?? 1);

    await this.logs.updateOne(
      { key: job.id },
      {
        $set: {
          lastError: err.message.slice(0, 500),
          attempts: job.attemptsMade,
          ...(final ? { status: 'FAILED' } : {}),
        },
      },
    );

    if (final) {
      notificationsSent.inc({
        template: job.data.log?.template ?? 'unknown',
        status: 'failed',
      });
      this.logger.error(
        `FAILED ${job.id} after ${job.attemptsMade} attempt(s): ${err.message}`,
      );
    } else {
      this.logger.warn(
        `Attempt ${job.attemptsMade} failed for ${job.id}, will retry: ${err.message}`,
      );
    }
  }
}
