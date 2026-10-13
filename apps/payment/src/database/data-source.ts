// DataSource for the TypeORM CLI (migration:generate / run / revert).
// The running service configures TypeORM in payment.module.ts instead.
import { DataSource } from 'typeorm';
import { PAYMENT_ENTITIES } from './entities';

try {
  process.loadEnvFile('apps/payment/.env');
} catch {
  // No .env file (e.g. CI): rely on DATABASE_URL already being set.
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set for the payment service');
}

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: PAYMENT_ENTITIES,
  migrations: ['apps/payment/src/database/migrations/*.ts'],
  migrationsTableName: 'migrations',
});
