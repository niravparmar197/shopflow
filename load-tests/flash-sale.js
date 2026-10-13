// k6 flash-sale load test: N buyers (one per token) each try to buy 1 unit
// of a product with STOCK units on sale. Exactly STOCK must win, with no 5xx
// and no dropped connections. Full run: load-tests/README.md.
//
//   k6 run -e PRODUCT_ID=<id> -e STOCK=10 load-tests/flash-sale.js
//   k6 run -e PRODUCT_ID=<id> -e STOCK=10 -e GATE=off load-tests/flash-sale.js   (A/B: no sale)
//
// Two phases, like a real sale: carts are filled beforehand (not measured),
// then everyone clicks "Buy" within the same second. BURST=instant starts
// all buyers in the same millisecond instead: on one Windows laptop that
// overflows the OS's accept queue (connections refused before the gateway
// sees them), which a load balancer in front would absorb.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const PRODUCT = __ENV.PRODUCT_ID;
const STOCK = Number(__ENV.STOCK || 10);
const GATE = (__ENV.GATE || 'on') !== 'off'; // off: no flash sale, the DB alone decides
const INSTANT = __ENV.BURST === 'instant';
// Buy clicks per second (default: everyone within 1 s). One Windows laptop
// running every service refuses connections past a few hundred new ones
// per second; see load-tests/README.md.
const RATE = Number(__ENV.RATE || 0);

if (!PRODUCT) throw new Error('Set -e PRODUCT_ID=<product id>');

// Loaded ONCE and shared by all VUs (not 1,000 copies in memory).
// Made by: node scripts/make-test-tokens.js 1000
const users = new SharedArray('users', () => JSON.parse(open('./.data/tokens.json')));

// Our business "no" answers are EXPECTED, not failures.
http.setResponseCallback(http.expectedStatuses(200, 201, 204, 409, 422, 429));

const ordersCreated = new Counter('orders_created');
const soldOut = new Counter('sold_out');
const busyGaveUp = new Counter('busy_gave_up');
const cartFailed = new Counter('cart_failed');
// 5xx AND dropped connections (status 0): neither is an answer.
const serverErrors = new Counter('server_errors');
const buyLatency = new Trend('buy_latency', true);

export const options = {
  scenarios: {
    fill_carts: {
      executor: 'shared-iterations',
      exec: 'fillCart',
      vus: 50,
      iterations: users.length,
      maxDuration: '1m',
    },
    buy: INSTANT
      ? {
          executor: 'per-vu-iterations', // all buyers in the same ms
          exec: 'buy',
          vus: users.length,
          iterations: 1,
          startTime: '20s', // after the carts are full
          maxDuration: '2m',
        }
      : {
          executor: 'constant-arrival-rate', // clicks spread evenly
          exec: 'buy',
          rate: RATE || users.length,
          timeUnit: '1s',
          duration: `${Math.ceil(users.length / (RATE || users.length))}s`,
          preAllocatedVUs: users.length,
          startTime: '20s', // after the carts are full
        },
  },
  thresholds: {
    // With the gate, EXACTLY the stock wins at the door. Without it, every
    // buyer gets an order and the DB decides later (checked by verify).
    ...(GATE ? { orders_created: [`count==${STOCK}`] } : {}),
    cart_failed: ['count==0'],
    server_errors: ['count==0'],
    http_req_failed: ['rate<0.001'], // only unexpected statuses count
    buy_latency: ['p(95)<800'], // the plan: p95 under 800 ms
  },
};

const user = () => users[exec.scenario.iterationInTest];
const authOf = (u) => ({
  Authorization: `Bearer ${u.token}`,
  'Content-Type': 'application/json',
});
const answered = (r) => r.status !== 0 && r.status < 500;

export function fillCart() {
  const res = http.post(
    `${BASE}/v1/cart/items`,
    JSON.stringify({ productId: PRODUCT, qty: 1 }),
    { headers: authOf(user()), tags: { step: 'cart' } },
  );
  if (!answered(res)) serverErrors.add(1);
  if (!check(res, { 'cart filled': (r) => r.status === 201 })) cartFailed.add(1);
}

export function buy() {
  const auth = authOf(user());
  // A GOOD client: the SAME Idempotency-Key on every retry (a lost response
  // must not buy twice), and waits as long as Retry-After says, plus jitter
  // (so the retries don't all land at once).
  const key = crypto.randomUUID();
  let res;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = http.post(`${BASE}/v1/orders`, '{}', {
      headers: { ...auth, 'Idempotency-Key': key },
      tags: { step: 'buy' },
    });
    buyLatency.add(res.timings.duration);
    if (res.status !== 429) break;
    sleep(Number(res.headers['Retry-After'] || 1) + Math.random() * 0.5);
  }

  const code = res.status >= 400 && res.status < 500 ? res.json('code') : undefined;
  if (res.status === 201) ordersCreated.add(1);
  else if (res.status === 409 && code === 'SOLD_OUT') soldOut.add(1);
  else if (res.status === 429) busyGaveUp.add(1);
  if (!answered(res)) serverErrors.add(1);

  check(res, {
    'buy answered (201/409/429)': (r) => [201, 409, 429].includes(r.status),
    'no 5xx, no dropped connection': answered,
  });
}

// The report goes into the repo: load-tests/reports/.
export function handleSummary(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `load-tests/reports/flash-sale-${GATE ? 'gate' : 'nogate'}-${stamp}`;
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${name}.json`]: JSON.stringify(data, null, 2),
    [`${name}.txt`]: textSummary(data, { indent: ' ', enableColors: false }),
  };
}
