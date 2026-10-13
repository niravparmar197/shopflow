import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { OrderItem } from './order-item.entity';
import { nextStatus } from './order-state';
import { OrderAction, OrderStatus } from './order-status';

@Entity('orders')
@Index('idx_orders_user_created', ['userId', 'createdAt']) // "my orders", newest first
@Check('chk_orders_amounts', '"discount_paise" >= 0 AND "total_paise" >= 0')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  // varchar, not a Postgres enum: adding a status later needs no type change.
  @Column({ type: 'varchar', length: 20, default: OrderStatus.PENDING })
  status!: OrderStatus;

  // Money in paise, as integers.
  @Column({ name: 'subtotal_paise', type: 'int' })
  subtotalPaise!: number;

  @Column({ name: 'discount_paise', type: 'int', default: 0 })
  discountPaise!: number;

  @Column({ name: 'total_paise', type: 'int' })
  totalPaise!: number;

  @Column({ name: 'coupon_code', type: 'varchar', length: 20, nullable: true })
  couponCode!: string | null;

  // Why the order FAILED, e.g. OUT_OF_STOCK.
  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({ type: 'varchar', length: 3, default: 'INR' })
  currency!: string;

  // Optimistic lock for status updates from the saga (F5/F6).
  @VersionColumn()
  version!: number;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items!: OrderItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** The only way to change the status; the state machine checks the move. */
  apply(action: OrderAction) {
    this.status = nextStatus(this.status, action);
  }
}
