import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { rmSync } from 'node:fs';

export default async function teardown() {
  const state = (
    globalThis as {
      __E2E__?: {
        pg: StartedPostgreSqlContainer;
        redis: StartedRedisContainer;
        keyDir: string;
      };
    }
  ).__E2E__;
  if (!state) return;
  await Promise.all([state.pg.stop(), state.redis.stop()]);
  rmSync(state.keyDir, { recursive: true, force: true });
}
