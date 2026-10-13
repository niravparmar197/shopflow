// The TRUTH after a flash-sale run comes from the databases, not from HTTP
// answers: waits for the saga to finish, then checks what this run's
// buyers (load-tests/.data/tokens.json) really got.
//
//   node load-tests/verify-flash.js <productId> [expected=10]
//
// PASS: exactly `expected` orders CONFIRMED, every other order FAILED (none
// still PENDING), one RESERVED reservation per confirmed order, and no
// stock row negative anywhere.
const fs = require('node:fs');
const { Client } = require('pg');

const [productId, expectedArg] = process.argv.slice(2);
const expected = Number(expectedArg || 10);
if (!productId) {
  console.error('Usage: node load-tests/verify-flash.js <productId> [expected]');
  process.exit(1);
}

const dbUrl = (svc) =>
  fs.readFileSync(`apps/${svc}/.env`, 'utf8').match(/^DATABASE_URL=(.*)$/m)[1].trim();
const userIds = JSON.parse(fs.readFileSync('load-tests/.data/tokens.json', 'utf8')).map((u) => u.userId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const orders = new Client({ connectionString: dbUrl('order') });
  const inventory = new Client({ connectionString: dbUrl('inventory') });
  await Promise.all([orders.connect(), inventory.connect()]);

  // This run's orders: placed by this run's buyers, for this product.
  const ordersQuery = () =>
    orders.query(
      `SELECT o.id, o.status FROM orders o
         JOIN order_items i ON i.order_id = o.id
        WHERE o.user_id = ANY($1::uuid[]) AND i.product_id = $2`,
      [userIds, productId],
    );

  // Wait for the saga (Kafka → inventory → order) to settle every order.
  let rows;
  for (let i = 0; i < 90; i++) {
    rows = (await ordersQuery()).rows;
    if (!rows.some((r) => r.status === 'PENDING')) break;
    await sleep(1_000);
  }

  const byStatus = rows.reduce((t, r) => ((t[r.status] = (t[r.status] ?? 0) + 1), t), {});
  const confirmed = rows.filter((r) => r.status === 'CONFIRMED').map((r) => r.id);
  const [stock] = (
    await inventory.query('SELECT available, reserved FROM stock WHERE product_id = $1', [productId])
  ).rows;
  const [{ negative }] = (
    await inventory.query('SELECT count(*)::int AS negative FROM stock WHERE available < 0 OR reserved < 0')
  ).rows;
  const reservations = (
    await inventory.query(
      `SELECT status, count(*)::int AS n FROM reservations
        WHERE order_id = ANY($1::uuid[]) GROUP BY status`,
      [rows.map((r) => r.id)],
    )
  ).rows.reduce((t, r) => ((t[r.status] = r.n), t), {});

  const lines = [
    `buyers in this run:          ${userIds.length}`,
    `orders by status:            ${JSON.stringify(byStatus)}`,
    `reservations by status:      ${JSON.stringify(reservations)}`,
    `stock (available|reserved):  ${stock.available}|${stock.reserved}`,
    `stock rows below zero:       ${negative}`,
  ];
  const pass =
    confirmed.length === expected &&
    rows.every((r) => r.status === 'CONFIRMED' || r.status === 'FAILED') &&
    (reservations.RESERVED ?? 0) === expected &&
    negative === 0;
  lines.push(
    pass
      ? `PASS: exactly ${expected} confirmed, the rest failed, no negative stock`
      : `FAIL: expected exactly ${expected} confirmed and no negative stock`,
  );
  console.log(lines.join('\n'));

  fs.mkdirSync('load-tests/reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(`load-tests/reports/verify-${stamp}.txt`, lines.join('\n') + '\n');

  await Promise.all([orders.end(), inventory.end()]);
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
