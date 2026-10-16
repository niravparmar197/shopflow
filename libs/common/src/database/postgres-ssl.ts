import { readFileSync } from 'node:fs';

/**
 * TLS to Postgres, verified against a CA bundle. On only when DATABASE_SSL_CA
 * points at the bundle (Stage 2: RDS, which refuses plain connections; the
 * image ships AWS's RDS CA bundle at /app/certs/rds-global-bundle.pem).
 * Off locally and on Stage 1, where Postgres is a container on a private network.
 */
export function postgresSsl():
  { ca: string; rejectUnauthorized: true } | undefined {
  const caPath = process.env.DATABASE_SSL_CA;
  if (!caPath) return undefined;
  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}
