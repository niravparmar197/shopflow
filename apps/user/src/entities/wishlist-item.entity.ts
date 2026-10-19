import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from './user.entity';

/** A product the user saved for later (Phase 2 P5). */
@Entity('wishlist_items')
@Index(['userId', 'createdAt'])
export class WishlistItem {
  // The pair is the key: saving the same product twice is a no-op.
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** The product's id in the product service (Mongo ObjectId) */
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 24 })
  productId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
