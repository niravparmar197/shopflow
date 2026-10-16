import { DataSource, MixedList } from 'typeorm';
import { postgresSsl } from './postgres-ssl';

/**
 * `node dist/apps/<svc>/main.js migrate`: apply pending migrations and exit.
 * Deploys run this once, and roll out the new version only if it succeeds;
 * services never migrate on boot. Migrations must stay backward compatible
 * (expand / contract): the old version keeps serving during a rolling deploy.
 */
export interface MigrateOptions {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  migrations: MixedList<Function>;
  /**
   * The service's entities. Not used by the migrations themselves, but on
   * connect the Postgres driver installs the extensions they need (uuid-ossp
   * for uuid_generate_v4()), and it decides which from the entity metadata.
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  entities: MixedList<Function>;
}

export async function runMigrations(
  service: string,
  { migrations, entities }: MigrateOptions,
): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    ssl: postgresSsl(),
    entities,
    migrations,
    migrationsTableName: 'migrations',
  });
  await ds.initialize();
  // Advisory locks belong to a session, so lock and unlock on one dedicated
  // connection, not whichever pooled one a query happens to get. Only one
  // runner at a time, even if several tasks start together.
  const lock = ds.createQueryRunner();
  const key = `migrate:${service}`;
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    const ran = await ds.runMigrations({ transaction: 'each' });
    console.log(
      `[${service}] migrations done: ${ran.map((m) => m.name).join(', ') || 'nothing new'}`,
    );
  } finally {
    await lock
      .query('SELECT pg_advisory_unlock(hashtext($1))', [key])
      .catch(() => undefined); // destroy() closes the session, which drops it anyway
    await lock.release();
    await ds.destroy();
  }
}

/** Entry point for `main.ts`: run migrations, then exit with their status. */
export function migrateAndExit(service: string, options: MigrateOptions): void {
  runMigrations(service, options).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
