import type { JobsOptions } from 'bullmq';
import type { NotificationChannel } from '../logs/notification-log.schema';

export const NOTIFICATIONS_QUEUE = 'notifications';

/**
 * COMMAND: a request packed into an object. It can be queued, stored,
 * retried, and executed later by someone else (the worker).
 */
export interface NotificationCommand {
  /** Dedupe key = BullMQ job id. No ':' (BullMQ uses it in its Redis keys). */
  readonly id: string;
  /** Which handler executes it. */
  readonly jobName: string;
  readonly payload: Record<string, unknown>;
  readonly log: {
    eventId: string;
    orderId: string;
    channel: NotificationChannel;
    template: string;
    to: string;
  };
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 4, // 1 try + 3 retries
  backoff: { type: 'exponential', delay: 2_000 }, // 2 s, 4 s, 8 s
  // Kept 1 day, so a redelivered event's duplicate job id is still caught.
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 }, // 7 days to inspect failures
};
