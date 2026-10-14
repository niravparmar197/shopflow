// Services run migrations from an explicit list (the webpack bundle has no .ts
// files to glob), so a generated migration that isn't added to the list would
// silently never run. Each service's index.spec.ts fails on that instead.
import { readdirSync } from 'node:fs';

/** Class names of the migration files in `dir`, oldest first. */
export function migrationFileClassNames(dir: string): string[] {
  // 1791889015976-CreateOrders.ts holds class CreateOrders1791889015976.
  return readdirSync(dir)
    .map((f) => /^(\d+)-(.+)\.ts$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(([, ts, name]) => `${name}${ts}`);
}
