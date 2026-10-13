import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { PaymentStatus } from './payment-status';

@Entity('payments')
// One payment per order: a duplicate order.confirmed can't create a second.
@Index('uq_payments_order', ['orderId'], { unique: true })
// Webhooks find the payment by the provider's order id.
@Index('uq_payments_provider_order', ['provider', 'providerOrderId'], {
  unique: true,
  where: '"provider_order_id" IS NOT NULL',
})
// For the timeout job (Part 3): only pending payments can expire.
@Index('idx_payments_expiry', ['expiresAt'], {
  where: `"status" = 'PENDING'`,
})
@Check('chk_payments_amount', '"amount_paise" >= 0')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'amount_paise', type: 'int' })
  amountPaise!: number;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 20, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  // Set at checkout (Part 2); null until the user starts paying.
  @Column({ type: 'varchar', length: 20, nullable: true })
  provider!: string | null;

  @Column({
    name: 'provider_order_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  providerOrderId!: string | null;

  @Column({
    name: 'provider_payment_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  providerPaymentId!: string | null;

  // The last failed attempt's reason, shown to the user.
  @Column({ name: 'last_error', type: 'varchar', length: 300, nullable: true })
  lastError!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  // Refund LEASE: a pod sets this before calling the provider; others skip
  // the row until it is 2 minutes old (then the refund is retried).
  @Column({ name: 'refund_attempted_at', type: 'timestamptz', nullable: true })
  refundAttemptedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
