import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Providers redeliver webhooks (Razorpay for 24 h, Stripe for 3 days), so
 * the same event can arrive many times. The (provider, event_id) primary
 * key, written in the same transaction as the state change, makes
 * processing exactly-once.
 */
@Entity('webhook_events')
export class WebhookEvent {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  provider!: string;

  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 100 })
  eventId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}
