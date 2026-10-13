// globalSetup runs outside Jest's module mapping; resolve @app/* from tsconfig.
import 'tsconfig-paths/register';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { startKafka } from '../../../test/helpers/kafka';
import { PAYMENT_ENTITIES } from '../src/database/entities';

const FAKE_SECRET = 'test-fake-webhook-secret';

// Runs once before the e2e suite: a real PostgreSQL (with the real
// migrations) and a real Kafka in Docker.
export default async function setup() {
  const [pg, kafka] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    startKafka(),
  ]);

  const ds = new DataSource({
    type: 'postgres',
    url: pg.getConnectionUri(),
    entities: PAYMENT_ENTITIES,
    migrations: [join(__dirname, '../src/database/migrations/*.ts')],
  });
  await ds.initialize();
  const ran = await ds.runMigrations();
  await ds.destroy();
  if (ran.length === 0) throw new Error('No migrations were run');

  // The service only verifies tokens; the tests sign them with the private key.
  const keyDir = mkdtempSync(join(tmpdir(), 'shopflow-jwt-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(keyDir, 'public.pem'), publicKey);
  writeFileSync(join(keyDir, 'private.pem'), privateKey);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    SERVICE_NAME: 'payment',
    PORT: '3004', // required by config; the app listens on a free port
    DATABASE_URL: pg.getConnectionUri(),
    JWT_PUBLIC_KEY_PATH: join(keyDir, 'public.pem'),
    E2E_JWT_PRIVATE_KEY_PATH: join(keyDir, 'private.pem'),
    KAFKA_BROKERS: kafka.brokers.join(','),
    OUTBOX_RELAY_ENABLED: 'true',
    KAFKA_CONSUMERS_ENABLED: 'true',
    OUTBOX_POLL_MS: '100',
    PAYMENT_PROVIDER: 'fake',
    FAKE_WEBHOOK_SECRET: FAKE_SECRET,
    // The tests call expireDue() / processPending() themselves: no timing luck.
    PAYMENT_SWEEPER_ENABLED: 'false',
  });

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, {
    __E2E__: { containers: [pg, kafka.container], keyDir },
  });
}
