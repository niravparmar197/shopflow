// Preloaded into every Node process in the image (NODE_OPTIONS=--require).
// It turns platform-injected secrets into what the services already expect,
// so ONE image runs locally, on Stage 1 (compose) and on Stage 2 (ECS):
//
//   JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (PEM text, injected by ECS from SSM)
//     -> written to /tmp/shopflow-keys/*.pem (0600), *_PATH set, raw var removed
//   DB_HOST + DB_NAME + DB_PASSWORD (+ DB_USER, DB_PORT), no DATABASE_URL
//     -> DATABASE_URL built here (RDS-managed password, URL-encoded)
//
// Does nothing when those variables are absent (local, Stage 1).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KEY_DIR = '/tmp/shopflow-keys';

function pemToFile(name) {
  const pem = process.env[name];
  if (!pem || process.env[`${name}_PATH`]) return;
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(KEY_DIR, `${name.toLowerCase().replace(/_/g, '-')}.pem`);
  // Some tools store PEMs with literal "\n"; normalise to real newlines.
  fs.writeFileSync(file, pem.replace(/\\n/g, '\n'), { mode: 0o600 });
  process.env[`${name}_PATH`] = file;
  delete process.env[name]; // do not leave the key in the environment
}

pemToFile('JWT_PRIVATE_KEY');
pemToFile('JWT_PUBLIC_KEY');

const { DB_HOST, DB_NAME, DB_PASSWORD } = process.env;
if (!process.env.DATABASE_URL && DB_HOST && DB_NAME && DB_PASSWORD) {
  const user = encodeURIComponent(process.env.DB_USER || 'shop');
  const port = process.env.DB_PORT || '5432';
  process.env.DATABASE_URL =
    `postgresql://${user}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${port}/${DB_NAME}`;
  delete process.env.DB_PASSWORD;
}
