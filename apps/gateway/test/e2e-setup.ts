import { RedisContainer } from '@testcontainers/redis';

// Runs once before the e2e suite: a real Redis in Docker (the limiter's
// atomicity can only be shown against the real thing).
export default async function setup() {
  const redis = await new RedisContainer('redis:7-alpine').start();

  // 127.0.0.1, not localhost: on Windows "localhost" resolves to ::1 first,
  // where Docker Desktop accepts and then drops the connection.
  process.env.E2E_REDIS_URL = `redis://127.0.0.1:${redis.getMappedPort(6379)}`;

  // Handed to e2e-teardown.ts (same process).
  Object.assign(globalThis, { __E2E__: { containers: [redis] } });
}
