import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * A saved delivery address (the address book). Orders do NOT point here:
 * the order service stores a COPY at checkout, so editing or deleting an
 * address later never changes where a past order went.
 */
@Entity('addresses')
@Index(['userId', 'createdAt'])
// At most ONE default address per user, enforced by the database.
@Index('UQ_addresses_one_default', ['userId'], {
  unique: true,
  where: '"is_default"',
})
export class Address {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  // Deleting a user deletes their addresses.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'full_name', type: 'varchar', length: 100 })
  fullName!: string;

  @Column({ type: 'varchar', length: 15 })
  phone!: string;

  @Column({ type: 'varchar', length: 200 })
  line1!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  line2!: string | null;

  @Column({ type: 'varchar', length: 100 })
  city!: string;

  @Column({ type: 'varchar', length: 100 })
  state!: string;

  @Column({ type: 'varchar', length: 6 })
  pincode!: string;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
