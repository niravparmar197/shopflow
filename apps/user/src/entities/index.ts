import { OutboxEvent } from '@app/kafka';
import { AccountToken } from './account-token.entity';
import { Address } from './address.entity';
import { RefreshToken } from './refresh-token.entity';
import { User } from './user.entity';

export * from './account-token.entity';
export * from './address.entity';
export * from './refresh-token.entity';
export * from './user.entity';

// OutboxEvent: account events go to Kafka through the outbox (Phase 2 P3).
export const USER_ENTITIES = [
  User,
  RefreshToken,
  Address,
  AccountToken,
  OutboxEvent,
];
