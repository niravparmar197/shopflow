// globalSetup runs outside Jest's module mapping; resolve @app/* from tsconfig.
import 'tsconfig-paths/register';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { RedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startKafka } from '../../../test/helpers/kafka';

// Runs once before the e2e suite: a real MongoDB, Redis (BullMQ) and Kafka
// in Docker, plus throwaway JWT keys for the admin endpoint.
export default async function setup() {
  const [mongo, redis, kafka] = await Promise.all([
    new MongoDBContainer('mongo:7').start(),
    new RedisContainer('redis:7-alpine').start(),
    startKafka(),
  ]);

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
    SERVICE_NAME: 'notification',
    PORT: '3006', // required by config; the app listens on a free port
    // 127.0.0.1, not localhost: on Windows "localhost" resolves to ::1 first,
    // where Docker Desktop accepts and then drops the connection.
    // directConnection: the Mongo container is a 1-node replica set.
    MONGO_URL: `mongodb://127.0.0.1:${mongo.getMappedPort(27017)}/notifications_test?directConnection=true`,
    REDIS_URL: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
    KAFKA_BROKERS: kafka.brokers.join(','),
    KAFKA_CONSUMERS_ENABLED: 'true',
    JWT_PUBLIC_KEY_PATH: join(keyDir, 'public.pem'),
    E2E_JWT_PRIVATE_KEY_PATH: join(keyDir, 'private.pem'),
    NOTIFY_BACKOFF_MS: '100', // 100, 200, 400 ms instead of 2, 4, 8 s
  });

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, {
    __E2E__: { containers: [mongo, redis, kafka.container], keyDir },
  });
}
