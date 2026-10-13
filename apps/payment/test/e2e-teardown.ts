import type { StartedTestContainer } from 'testcontainers';
import { rmSync } from 'node:fs';

export default async function teardown() {
  const state = (
    globalThis as {
      __E2E__?: { containers: StartedTestContainer[]; keyDir: string };
    }
  ).__E2E__;
  if (!state) return;
  await Promise.all(state.containers.map((c) => c.stop()));
  rmSync(state.keyDir, { recursive: true, force: true });
}
