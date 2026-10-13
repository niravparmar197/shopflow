import { MongoDBContainer } from '@testcontainers/mongodb';
import { RedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs once before the e2e suite: a real MongoDB and Redis in Docker, plus
// throwaway JWT keys. Everything reaches the app through env vars, which win
// over apps/product/.env.
export default async function setup() {
  const [mongo, redis] = await Promise.all([
    new MongoDBContainer('mongo:7').start(),
    new RedisContainer('redis:7-alpine').start(),
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
    SERVICE_NAME: 'product',
    PORT: '3002', // required by config; supertest never listens on it
    // 127.0.0.1, not localhost: on Windows "localhost" resolves to ::1 first,
    // where Docker Desktop accepts and then drops the connection.
    MONGO_URL: `mongodb://127.0.0.1:${mongo.getMappedPort(27017)}/products_test?directConnection=true`,
    REDIS_URL: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
    JWT_PUBLIC_KEY_PATH: join(keyDir, 'public.pem'),
    // Only the test signs tokens; the service under test never sees this key.
    E2E_JWT_PRIVATE_KEY_PATH: join(keyDir, 'private.pem'),
    S3_BUCKET: 'test-bucket',
    ASSET_BASE_URL: 'http://cdn.test',
  });

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, {
    __E2E__: { containers: [mongo, redis], keyDir },
  });
}
