import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Order } from '../orders/order.entity';

/**
 * A GST tax invoice: one per paid order, issued in the same transaction as
 * PAID. The rate and the seller's state are copied in, so a later config
 * change never alters an invoice already issued.
 */
@Entity('invoices')
export class Invoice {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @OneToOne(() => Order, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  /** SF/26-27/000042 */
  @Column({ type: 'varchar', length: 16, unique: true })
  number!: string;

  @Column({ name: 'financial_year', type: 'varchar', length: 7 })
  financialYear!: string; // '2026-27'

  @Column({ type: 'int' })
  seq!: number;

  @Column({ name: 'gst_rate_percent', type: 'numeric', precision: 5, scale: 2 })
  gstRatePercent!: string; // numeric comes back as a string

  @Column({ name: 'seller_state', type: 'varchar', length: 50 })
  sellerState!: string;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;
}

/**
 * The last number used in each financial year. Taking the next one is an
 * UPSERT on this row: the row lock is held until the transaction commits,
 * so two payments can't get the same number, and a rolled-back payment
 * gives its number back (no gaps, which GST wants).
 */
@Entity('invoice_counters')
export class InvoiceCounter {
  @PrimaryColumn({ name: 'financial_year', type: 'varchar', length: 7 })
  financialYear!: string;

  @Column({ name: 'last_seq', type: 'int' })
  lastSeq!: number;
}
