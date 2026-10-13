import {
  Check,
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('stock')
// The last safety net: the database itself refuses negative stock.
@Check('chk_stock_available', '"available" >= 0')
@Check('chk_stock_reserved', '"reserved" >= 0')
export class Stock {
  // Mongo ObjectId from the product service.
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 24 })
  productId!: string;

  @Column({ type: 'int', default: 0 })
  available!: number; // can be sold now

  @Column({ type: 'int', default: 0 })
  reserved!: number; // held for orders waiting for payment

  @VersionColumn()
  version!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
