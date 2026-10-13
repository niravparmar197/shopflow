import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { rmSync } from 'node:fs';

export default async function teardown() {
  const state = (
    globalThis as {
      __E2E__?: { pg: StartedPostgreSqlContainer; keyDir: string };
    }
  ).__E2E__;
  if (!state) return;
  await state.pg.stop();
  rmSync(state.keyDir, { recursive: true, force: true });
}
