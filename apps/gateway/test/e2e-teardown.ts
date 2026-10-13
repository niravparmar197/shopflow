import type { StartedTestContainer } from 'testcontainers';

export default async function teardown() {
  const state = (
    globalThis as { __E2E__?: { containers: StartedTestContainer[] } }
  ).__E2E__;
  if (!state) return;
  await Promise.all(state.containers.map((c) => c.stop()));
}
