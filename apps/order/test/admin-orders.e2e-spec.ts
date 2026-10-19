import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1); // ₹10,000

interface AdminList {
  items: {
    id: string;
    userId: string;
    customerEmail: string;
    status: string;
    itemCount: number;
    totalPaise: number;
  }[];
  nextCursor: string | null;
}

// GET /v1/admin/orders: every customer's orders, admins only.
describe('Admin orders (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  const http = () => ctx.http();
  const admin = () => ctx.bearer(randomUUID(), 'admin');

  async function placeOrder(qty = 1) {
    const id = randomUUID();
    const auth = ctx.bearer(id);
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty })
      .expect(201);
    const res = await http()
      .post('/v1/orders')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(201);
    return { userId: id, orderId: (res.body as { id: string }).id };
  }

  const reset = async () => {
    await ds.query(
      'TRUNCATE order_items, orders, outbox, idempotency_keys, coupons CASCADE',
    );
    await redis.flushdb();
  };

  beforeAll(async () => {
    ctx = await startOrderApp();
    ds = ctx.app.get(DataSource);
    redis = ctx.app.get(REDIS);
  });

  beforeEach(async () => {
    await reset();
    ctx.catalog.set(product(PHONE, 'Phone', 'phones', 1_000_000));
  });

  afterAll(async () => {
    if (!ctx) return;
    await reset();
    await ctx.app.close();
  });

  it('a customer gets 403, no token gets 401', async () => {
    await http()
      .get('/v1/admin/orders')
      .set('Authorization', ctx.bearer(randomUUID()))
      .expect(403);
    await http().get('/v1/admin/orders').expect(401);
  });

  it("lists every customer's orders, newest first, with the customer and item count", async () => {
    const a = await placeOrder(2);
    const b = await placeOrder(1);

    const res = await http()
      .get('/v1/admin/orders')
      .set('Authorization', admin())
      .expect(200);
    const body = res.body as AdminList;

    expect(body.items.map((o) => o.id)).toEqual([b.orderId, a.orderId]);
    expect(body.items[1]).toMatchObject({
      userId: a.userId,
      customerEmail: `${a.userId}@test.dev`,
      status: 'PENDING',
      itemCount: 2,
      totalPaise: 2_000_000,
    });
    expect(body.nextCursor).toBeNull();
  });

  it('filters by status and pages with a cursor', async () => {
    const first = await placeOrder();
    const second = await placeOrder();
    const third = await placeOrder();
    await ds.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [
      second.orderId,
    ]);

    const cancelled = await http()
      .get('/v1/admin/orders?status=CANCELLED')
      .set('Authorization', admin())
      .expect(200);
    expect((cancelled.body as AdminList).items.map((o) => o.id)).toEqual([
      second.orderId,
    ]);

    const page1 = (
      await http()
        .get('/v1/admin/orders?limit=2')
        .set('Authorization', admin())
        .expect(200)
    ).body as AdminList;
    expect(page1.items.map((o) => o.id)).toEqual([
      third.orderId,
      second.orderId,
    ]);
    const page2 = (
      await http()
        .get(`/v1/admin/orders?limit=2&cursor=${page1.nextCursor}`)
        .set('Authorization', admin())
        .expect(200)
    ).body as AdminList;
    expect(page2.items.map((o) => o.id)).toEqual([first.orderId]);
    expect(page2.nextCursor).toBeNull();

    await http()
      .get('/v1/admin/orders?status=NOPE')
      .set('Authorization', admin())
      .expect(400);
  });

  it('one order with items and the customer; 404 for an unknown id', async () => {
    const { userId, orderId } = await placeOrder(3);

    const res = await http()
      .get(`/v1/admin/orders/${orderId}`)
      .set('Authorization', admin())
      .expect(200);
    expect(res.body).toMatchObject({
      id: orderId,
      userId,
      customerEmail: `${userId}@test.dev`,
      items: [{ productId: PHONE, quantity: 3, lineTotalPaise: 3_000_000 }],
    });

    await http()
      .get(`/v1/admin/orders/${randomUUID()}`)
      .set('Authorization', admin())
      .expect(404);
  });
});
