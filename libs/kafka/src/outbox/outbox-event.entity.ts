import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { EventEnvelope } from '@app/events';

/**
 * Transactional outbox: an event is saved in the same transaction as the
 * change it describes, so it can't be lost between "save" and "send". A
 * separate publisher sends it to Kafka later (F5).
 */
@Entity('outbox')
// Partial index: the publisher only ever reads rows not sent yet.
@Index('idx_outbox_unpublished', ['createdAt'], {
  where: '"published_at" IS NULL',
})
export class OutboxEvent {
  // Also the event id, so consumers can skip duplicates.
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 40 })
  aggregateType!: string; // 'order'

  // The order id; the Kafka message key in F5 (keeps one order's events in order).
  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 60 })
  eventType!: string; // 'order.created'

  @Column({ type: 'jsonb' })
  payload!: EventEnvelope<object>; // exactly what goes to Kafka

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;
}
