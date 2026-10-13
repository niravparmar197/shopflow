import { OutboxEvent, ProcessedEvent } from '@app/kafka';
import { Payment } from '../payments/payment.entity';

// Used by both the running service (payment.module.ts) and the migration CLI.
export const PAYMENT_ENTITIES = [Payment, OutboxEvent, ProcessedEvent];
