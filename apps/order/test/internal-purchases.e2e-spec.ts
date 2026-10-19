import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1);
const OTHER = oid(2);

// Phase 2 P5: the product service asks "did this user receive it?" before
// accepting a review. Internal only: the service token is required.
describe('Internal purchase check (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  const token = () => process.env.INTERNAL_API_TOKEN!;

  beforeAll(async () => {
    ctx = await startOrderApp();
    ds = ctx.app.get(DataSource);
    redis = ctx.app.get(REDIS);
  });
  beforeEach(async () => {
    await ds.query(
      'TRUNCATE invoices, invoice_counters, order_items, orders, outbox, idempotency_keys, coupons CASCADE',
    );
    await redis.flushdb();
    ctx.catalog.set(product(PHONE, 'Phone', 'phones', 1_000_000));
  });
  afterAll(async () => {
    await ctx?.app.close();
  });

  const order = async (userId: string) => {
    const auth = ctx.bearer(userId);
    await ctx
      .http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 1 })
      .expect(201);
    const res = await ctx
      .http()
      .post('/v1/orders')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(201);
    return (res.body as { id: string }).id;
  };
  const check = (userId: string, productId: string, t = token()) =>
    ctx
      .http()
      .get(`/v1/internal/purchases?userId=${userId}&productId=${productId}`)
      .set('x-internal-token', t);

  it('true only for a DELIVERED order of that user with that product', async () => {
    const user = randomUUID();
    const id = await order(user);

    expect((await check(user, PHONE).expect(200)).body).toEqual({
      delivered: false,
    });
    await ds.query(`UPDATE orders SET status = 'SHIPPED' WHERE id = $1`, [id]);
    expect((await check(user, PHONE).expect(200)).body.delivered).toBe(false);

    await ds.query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [
      id,
    ]);
    expect((await check(user, PHONE).expect(200)).body.delivered).toBe(true);
    expect((await check(user, OTHER).expect(200)).body.delivered).toBe(false);
    expect((await check(randomUUID(), PHONE).expect(200)).body.delivered).toBe(
      false,
    );
  });

  it('needs the service token and valid ids', async () => {
    const user = randomUUID();
    await check(user, PHONE, 'x'.repeat(token().length)).expect(401);
    await ctx
      .http()
      .get(`/v1/internal/purchases?userId=${user}&productId=${PHONE}`)
      .expect(401);
    await check('nope', PHONE).expect(400);
  });
});
