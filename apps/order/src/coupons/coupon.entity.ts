import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  VersionColumn,
} from 'typeorm';

export enum CouponType {
  PERCENT = 'PERCENT',
  FLAT = 'FLAT',
}

@Entity('coupons')
export class Coupon {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Stored uppercased; uniqueness is enforced on the normalised value.
  @Column({ type: 'varchar', length: 20, unique: true })
  code!: string;

  @Column({ type: 'enum', enum: CouponType })
  type!: CouponType;

  // PERCENT: 10 means 10%. FLAT: amount in paise.
  @Column({ type: 'int' })
  value!: number;

  // Cap on a percent discount, in paise.
  @Column({ name: 'max_discount_paise', type: 'int', nullable: true })
  maxDiscountPaise!: number | null;

  @Column({ name: 'min_cart_paise', type: 'int', default: 0 })
  minCartPaise!: number;

  // Lowercase, like product categories. Only items of this category count.
  @Column({ type: 'varchar', length: 50, nullable: true })
  category!: string | null;

  @Column({ name: 'first_order_only', type: 'boolean', default: false })
  firstOrderOnly!: boolean;

  @Column({ name: 'valid_from', type: 'timestamptz' })
  validFrom!: Date;

  @Column({ name: 'valid_to', type: 'timestamptz' })
  validTo!: Date;

  // Total uses allowed; null means unlimited.
  @Column({ name: 'usage_limit', type: 'int', nullable: true })
  usageLimit!: number | null;

  // Increased when an order using the coupon is placed (F4).
  @Column({ name: 'used_count', type: 'int', default: 0 })
  usedCount!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
