// Saves every spec the gateway's docs page serves to docs/openapi/*.json, so
// API changes show up as a diff in the PR.
//   npm run openapi:export                     (services running locally)
//   DOCS_BASE=http://host:3000 npm run openapi:export
const fs = require('fs');
const path = require('path');

const base = process.env.DOCS_BASE || 'http://localhost:3000';
const specs = ['gateway', 'user', 'order', 'payment', 'product', 'inventory', 'notification'];
const outDir = path.join('docs', 'openapi');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of specs) {
    const r = await fetch(`${base}/docs/specs/${s}.json`).catch((e) => e);
    if (!(r instanceof Response) || !r.ok) {
      console.error(`✗ ${s}: ${r instanceof Response ? `HTTP ${r.status}` : r.message}`);
      process.exitCode = 1;
      continue;
    }
    const spec = await r.json();
    // Stable output: the version is the build's (APP_VERSION), not the API's.
    if (spec.info) spec.info.version = 'exported';
    fs.writeFileSync(path.join(outDir, `${s}.json`), JSON.stringify(spec, null, 2) + '\n');
    console.log(`✓ ${s}`);
  }
})();
