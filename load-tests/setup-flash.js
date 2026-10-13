// DEV ONLY: prepares a flash-sale load test through the gateway, as an
// admin signed with the LOCAL private key.
//
//   node load-tests/setup-flash.js <productId | new> [stock=10] [--no-sale]
//
// Sets the product's stock and starts a 30-minute flash sale of all of it
// (ending any sale already running). --no-sale: stock only, for the A/B run
// where the database alone decides.
// "new" first creates a dedicated product: no old holds or orders that
// could change its stock during the run. Its id → load-tests/.data/product.txt
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

let [productId, stockArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const noSale = process.argv.includes('--no-sale');
const stock = Number(stockArg || 10);
const BASE = process.env.BASE_URL || 'http://localhost:3000';
if (!productId) {
  console.error('Usage: node load-tests/setup-flash.js <productId> [stock] [--no-sale]');
  process.exit(1);
}

const admin = jwt.sign(
  { sub: randomUUID(), email: 'loadtest-admin@load.test', role: 'admin' },
  fs.readFileSync('keys/jwt-private.pem'),
  { algorithm: 'RS256', issuer: 'shopflow', audience: 'shopflow-api', expiresIn: '10m' },
);

async function call(method, path, body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

(async () => {
  if (productId === 'new') {
    const stamp = Date.now();
    const p = await call('POST', '/products', {
      name: `Load test phone ${stamp}`,
      slug: `load-test-phone-${stamp}`,
      category: 'loadtest',
      pricePaise: 100_000,
    });
    productId = p._id ?? p.id; // the product service returns the Mongo document
    fs.mkdirSync('load-tests/.data', { recursive: true });
    fs.writeFileSync('load-tests/.data/product.txt', productId);
    console.log(`product: ${productId} (saved to load-tests/.data/product.txt)`);
  }
  await call('DELETE', `/inventory/flash-sales/${productId}`);
  const s = await call('PUT', `/inventory/stock/${productId}`, { available: stock });
  console.log(`stock: available ${s.available}, reserved ${s.reserved}`);
  if (!noSale) {
    const sale = await call('POST', '/inventory/flash-sales', {
      productId,
      quantity: stock,
      durationMinutes: 30,
    });
    console.log(`flash sale: ${sale.left} of ${sale.total}, ends in ${sale.endsInSec} s`);
    // The order service caches the list of active sales for 2 s.
    await new Promise((r) => setTimeout(r, 2_500));
  } else {
    console.log('no flash sale (A/B run: the database alone decides)');
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
