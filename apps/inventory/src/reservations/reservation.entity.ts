import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum ReservationStatus {
  RESERVED = 'RESERVED',
  RELEASED = 'RELEASED', // order cancelled / failed: stock goes back (F6, F8)
  COMMITTED = 'COMMITTED', // paid: the stock is really gone (F6)
}

@Entity('reservations')
// Second duplicate guard after processed_events.
@Index('uq_reservations_order_product', ['orderId', 'productId'], {
  unique: true,
})
// For releasing expired holds (F8).
@Index('idx_reservations_expiry', ['expiresAt'], {
  where: `"status" = 'RESERVED'`,
})
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'product_id', type: 'varchar', length: 24 })
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'varchar', length: 20, default: ReservationStatus.RESERVED })
  status!: ReservationStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
