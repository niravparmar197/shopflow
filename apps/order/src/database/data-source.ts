// DataSource for the TypeORM CLI (migration:generate / run / revert).
// The running service configures TypeORM in order.module.ts instead.
import { DataSource } from 'typeorm';
import { MIGRATIONS } from './migrations';
import { ORDER_ENTITIES } from './entities';

try {
  process.loadEnvFile('apps/order/.env');
} catch {
  // No .env file (e.g. CI): rely on DATABASE_URL already being set.
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set for the order service');
}

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ORDER_ENTITIES,
  migrations: MIGRATIONS,
  migrationsTableName: 'migrations',
});
