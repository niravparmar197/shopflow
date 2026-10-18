// globalSetup runs outside Jest's module mapping; resolve @app/* from tsconfig.
import 'tsconfig-paths/register';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { USER_ENTITIES } from '../src/entities';
import { MIGRATIONS } from '../src/database/migrations';

// Runs once before the e2e suite: a real PostgreSQL in Docker with the real
// migrations applied, plus throwaway JWT keys. Everything is passed to the
// app through env vars, which win over apps/user/.env.
export default async function setup() {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(), // the clean-up job's lock
  ]);

  const ds = new DataSource({
    type: 'postgres',
    url: pg.getConnectionUri(),
    entities: USER_ENTITIES,
    migrations: MIGRATIONS,
  });
  await ds.initialize();
  const ran = await ds.runMigrations();
  await ds.destroy();
  if (ran.length === 0) throw new Error('No migrations were run');

  const keyDir = mkdtempSync(join(tmpdir(), 'shopflow-jwt-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(keyDir, 'private.pem'), privateKey);
  writeFileSync(join(keyDir, 'public.pem'), publicKey);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    SERVICE_NAME: 'user',
    PORT: '3001', // required by config; supertest never listens on it
    DATABASE_URL: pg.getConnectionUri(),
    JWT_PRIVATE_KEY_PATH: join(keyDir, 'private.pem'),
    JWT_PUBLIC_KEY_PATH: join(keyDir, 'public.pem'),
    // Account events stay in the outbox table (the tests read them there);
    // no Kafka in this suite, so the relay is off.
    KAFKA_BROKERS: 'localhost:9092',
    OUTBOX_RELAY_ENABLED: 'false',
    REDIS_URL: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
    JOBS_ENABLED: 'false', // the test calls tick() itself
  });

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, { __E2E__: { pg, redis, keyDir } });
}
