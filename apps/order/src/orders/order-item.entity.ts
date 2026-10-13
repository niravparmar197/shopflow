import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';

@Entity('order_items')
@Index('idx_order_items_order', ['orderId']) // Postgres doesn't index FKs itself
@Check('chk_order_items_quantity', '"quantity" > 0')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  // Mongo ObjectId from the product service.
  @Column({ name: 'product_id', type: 'varchar', length: 24 })
  productId!: string;

  // Snapshot of the name and price at order time, so old orders stay
  // correct when the product changes later.
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'unit_price_paise', type: 'int' })
  unitPricePaise!: number;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ name: 'line_total_paise', type: 'int' })
  lineTotalPaise!: number;
}
