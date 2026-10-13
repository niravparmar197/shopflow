import { OutboxEvent, ProcessedEvent } from '@app/kafka';
import { Payment } from '../payments/payment.entity';
import { WebhookEvent } from '../webhooks/webhook-event.entity';

// Used by both the running service (payment.module.ts) and the migration CLI.
export const PAYMENT_ENTITIES = [
  Payment,
  WebhookEvent,
  OutboxEvent,
  ProcessedEvent,
];
