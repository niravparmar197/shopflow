// globalSetup runs outside Jest's module mapping; resolve @app/* from tsconfig.
import 'tsconfig-paths/register';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { startKafka } from '../../../test/helpers/kafka';
import { INVENTORY_ENTITIES } from '../src/database/entities';

// Runs once before the e2e suite: a real PostgreSQL (with the real
// migrations) and a real Kafka in Docker. Migrations run here, before any
// app starts, so the consumers and the relay always find their tables.
export default async function setup() {
  const [pg, kafka] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    startKafka(),
  ]);

  const ds = new DataSource({
    type: 'postgres',
    url: pg.getConnectionUri(),
    entities: INVENTORY_ENTITIES,
    migrations: [join(__dirname, '../src/database/migrations/*.ts')],
  });
  await ds.initialize();
  const ran = await ds.runMigrations();
  await ds.destroy();
  if (ran.length === 0) throw new Error('No migrations were run');

  // The service only verifies tokens; no test signs one.
  const keyDir = mkdtempSync(join(tmpdir(), 'shopflow-jwt-'));
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(keyDir, 'public.pem'), publicKey);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    SERVICE_NAME: 'inventory',
    PORT: '3005', // required by config; nothing listens on it
    DATABASE_URL: pg.getConnectionUri(),
    JWT_PUBLIC_KEY_PATH: join(keyDir, 'public.pem'),
    KAFKA_BROKERS: kafka.brokers.join(','),
    OUTBOX_RELAY_ENABLED: 'true',
    KAFKA_CONSUMERS_ENABLED: 'true',
    OUTBOX_POLL_MS: '100',
  });

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, {
    __E2E__: { containers: [pg, kafka.container], keyDir },
  });
}
