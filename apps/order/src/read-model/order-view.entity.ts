import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface TimelineEntry {
  step: string; // PLACED, CONFIRMED, PAYMENT_RECEIVED, PAID, CANCELLED, FAILED, REFUNDED
  at: string; // event time (ISO)
  reason?: string | null;
}

/**
 * READ MODEL (CQRS): one flat row per order, shaped for the "My orders"
 * screen and built from order-events + payment-events. No joins, no call to
 * the payment service. It can be truncated and rebuilt from the events
 * (scripts/rebuild-order-views.ps1); the orders tables stay the truth.
 */
@Entity('order_views')
@Index('idx_order_views_user_placed', ['userId', 'placedAt', 'orderId'])
export class OrderView {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  // The status only moves FORWARD: PENDING 1 → CONFIRMED 2 →
  // PAID/FAILED/CANCELLED 3. Events from different topics (and different
  // clocks) arrive out of order; the rank follows the state machine, so a
  // late order.confirmed can't put a PAID order back.
  @Column({ name: 'status_rank', type: 'int', default: 0 })
  statusRank!: number;

  @Column({
    name: 'payment_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  paymentStatus!: string | null;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({ name: 'total_paise', type: 'int', nullable: true })
  totalPaise!: number | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  currency!: string | null;

  @Column({ name: 'item_count', type: 'int', nullable: true })
  itemCount!: number | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  title!: string | null; // "Phone + 2 more"

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  timeline!: TimelineEntry[];

  // Null on a placeholder row (a later event arrived before order.created).
  @Column({ name: 'placed_at', type: 'timestamptz', nullable: true })
  placedAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
