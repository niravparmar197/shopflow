// globalSetup runs outside Jest's module mapping; resolve @app/* from tsconfig.
import 'tsconfig-paths/register';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { ORDER_ENTITIES } from '../src/database/entities';

// Runs once before the e2e suite: a real PostgreSQL (with the real
// migrations) and Redis in Docker, plus throwaway JWT keys. Everything
// reaches the app through env vars, which win over apps/order/.env.
export default async function setup() {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const ds = new DataSource({
    type: 'postgres',
    url: pg.getConnectionUri(),
    entities: ORDER_ENTITIES,
    migrations: [join(__dirname, '../src/database/migrations/*.ts')],
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
    SERVICE_NAME: 'order',
    PORT: '3003', // required by config; supertest never listens on it
    DATABASE_URL: pg.getConnectionUri(),
    // 127.0.0.1, not localhost: on Windows "localhost" resolves to ::1 first,
    // where Docker Desktop accepts and then drops the connection.
    REDIS_URL: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
    JWT_PUBLIC_KEY_PATH: join(keyDir, 'public.pem'),
    // Only the test signs tokens; the service under test never sees this key.
    E2E_JWT_PRIVATE_KEY_PATH: join(keyDir, 'private.pem'),
    // Required by config; the tests replace the product client with a fake.
    PRODUCT_GRPC_URL: '127.0.0.1:1',
    // No Kafka by default: the outbox is checked in the database.
    // startOrderApp({ kafka: true }) switches it on for the saga suite.
    KAFKA_BROKERS: '127.0.0.1:1',
    OUTBOX_RELAY_ENABLED: 'false',
    KAFKA_CONSUMERS_ENABLED: 'false',
    JOBS_ENABLED: 'false', // the tests call tick() themselves
    // No inventory here: the flash gate's calls fail fast → it fails open.
    INVENTORY_SERVICE_URL: 'http://127.0.0.1:1',
    INTERNAL_API_TOKEN: 'test-internal-token',
  });

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, {
    __E2E__: { containers: [pg, redis], keyDir },
  });
}
