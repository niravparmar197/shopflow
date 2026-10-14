// DataSource for the TypeORM CLI (migration:generate / run / revert).
// The running service configures TypeORM in user.module.ts instead.
import { DataSource } from 'typeorm';
import { MIGRATIONS } from './migrations';
import { USER_ENTITIES } from '../entities';

try {
  process.loadEnvFile('apps/user/.env');
} catch {
  // No .env file (e.g. CI): rely on DATABASE_URL already being set.
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set for the user service');
}

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: USER_ENTITIES,
  migrations: MIGRATIONS,
  migrationsTableName: 'migrations',
});
