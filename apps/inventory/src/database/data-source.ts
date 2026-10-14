// DataSource for the TypeORM CLI (migration:generate / run / revert).
// The running service configures TypeORM in inventory.module.ts instead.
import { DataSource } from 'typeorm';
import { MIGRATIONS } from './migrations';
import { INVENTORY_ENTITIES } from './entities';

try {
  process.loadEnvFile('apps/inventory/.env');
} catch {
  // No .env file (e.g. CI): rely on DATABASE_URL already being set.
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set for the inventory service');
}

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: INVENTORY_ENTITIES,
  migrations: MIGRATIONS,
  migrationsTableName: 'migrations',
});
