import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per (consumer group, event) handled. The primary key is the
 * duplicate guard; it is written in the same transaction as the handler's
 * changes. The group is part of the key so two groups in one service each
 * handle an event once.
 */
@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  consumer!: string; // the groupId, e.g. 'inventory-svc'

  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}
