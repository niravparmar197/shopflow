import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export enum IdemStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/** One row per (user, Idempotency-Key header): a retry replays the stored response. */
@Entity('idempotency_keys')
export class IdempotencyKey {
  // Composite primary key (user_id, key): of two requests with the same key,
  // the database lets exactly one insert win.
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  key!: string;

  // sha256 (hex) of the request body. Same key + different body → 422.
  @Column({ name: 'request_hash', type: 'char', length: 64 })
  requestHash!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: IdemStatus;

  @Column({ name: 'response_status', type: 'int', nullable: true })
  responseStatus!: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody!: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
