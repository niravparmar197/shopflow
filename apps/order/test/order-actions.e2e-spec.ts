import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1); // ₹10,000

const address = {
  fullName: 'Asha Patel',
  phone: '+91 98765 43210',
  line1: '12, Shanti Nagar, SG Highway',
  city: 'Ahmedabad',
  state: 'Gujarat',
  pincode: '380015',
};

interface ApiOrder {
  id: string;
  status: string;
  failureReason: string | null;
  shippingAddress: Record<string, string | null> | null;
  carrier: string | null;
  trackingNumber: string | null;
}

// Phase 2: shipping address, cancel (customer + admin), ship, deliver.
// No Kafka here: each move must leave its event in the outbox, in the same
// transaction (the saga e2e covers what the other services do with it).
describe('Order actions (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  const http = () => ctx.http();
  const admin = () => ctx.bearer(randomUUID(), 'admin');

  async function placeOrder(body: object = { shippingAddress: address }) {
    const userId = randomUUID();
    const auth = ctx.bearer(userId);
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 1 })
      .expect(201);
    const res = await http()
      .post('/v1/orders')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    return { userId, auth, order: res.body as ApiOrder };
  }

  const setStatus = (id: string, status: string) =>
    ds.query(`UPDATE orders SET status = $2 WHERE id = $1`, [id, status]);
  const events = async (id: string) =>
    (
      await ds.query<{ event_type: string; payload: { data: object } }[]>(
        `SELECT event_type, payload FROM outbox WHERE aggregate_id = $1 ORDER BY created_at`,
        [id],
      )
    ).map((r) => ({ type: r.event_type, data: r.payload.data }));

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

  it('saves a COPY of the shipping address on the order (phone normalised)', async () => {
    const { auth, order } = await placeOrder();
    expect(order.shippingAddress).toEqual({
      ...address,
      phone: '9876543210',
      line2: null,
    });
    const again = await http()
      .get(`/v1/orders/${order.id}`)
      .set('Authorization', auth)
      .expect(200);
    expect((again.body as ApiOrder).shippingAddress?.pincode).toBe('380015');
  });

  it('rejects a bad address; no address at all is still allowed (older clients)', async () => {
    const auth = ctx.bearer(randomUUID());
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 1 })
      .expect(201);
    const bad = await http()
      .post('/v1/orders')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: { ...address, pincode: '12' } })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('pincode must be 6 digits');

    const { order } = await placeOrder({});
    expect(order.shippingAddress).toBeNull();
  });

  it('the customer cancels: CANCELLED (USER_CANCELLED) + order.cancelled in the outbox', async () => {
    const { auth, userId, order } = await placeOrder();
    await setStatus(order.id, 'PAID'); // paid → the saga refunds it

    const res = await http()
      .post(`/v1/orders/${order.id}/cancel`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body).toMatchObject({
      id: order.id,
      status: 'CANCELLED',
      failureReason: 'USER_CANCELLED',
    });
    expect((await events(order.id)).at(-1)).toEqual({
      type: 'order.cancelled',
      data: { orderId: order.id, userId, reason: 'USER_CANCELLED' },
    });

    // Twice → 409 (the state machine), no second event.
    const again = await http()
      .post(`/v1/orders/${order.id}/cancel`)
      .set('Authorization', auth)
      .expect(409);
    expect(again.body).toMatchObject({ code: 'INVALID_ORDER_TRANSITION' });
    expect(
      (await events(order.id)).filter((e) => e.type === 'order.cancelled'),
    ).toHaveLength(1);
  });

  it("someone else's order: 404, and nothing changes", async () => {
    const { order } = await placeOrder();
    await http()
      .post(`/v1/orders/${order.id}/cancel`)
      .set('Authorization', ctx.bearer(randomUUID()))
      .expect(404);
    const [{ status }] = await ds.query<{ status: string }[]>(
      `SELECT status FROM orders WHERE id = $1`,
      [order.id],
    );
    expect(status).toBe('PENDING');
  });

  it('admin: ship (carrier + tracking) → deliver, each with its event; then no cancel', async () => {
    const { auth, userId, order } = await placeOrder();

    // Not paid yet → can't ship.
    await http()
      .post(`/v1/admin/orders/${order.id}/ship`)
      .set('Authorization', admin())
      .send({})
      .expect(409);

    await setStatus(order.id, 'PAID');
    const shipped = await http()
      .post(`/v1/admin/orders/${order.id}/ship`)
      .set('Authorization', admin())
      .send({ carrier: ' Delhivery ', trackingNumber: 'DL123456789IN' })
      .expect(200);
    expect(shipped.body).toMatchObject({
      status: 'SHIPPED',
      carrier: 'Delhivery',
      trackingNumber: 'DL123456789IN',
      customerEmail: `${userId}@test.dev`,
    });

    // Shipped: the customer can't cancel any more.
    await http()
      .post(`/v1/orders/${order.id}/cancel`)
      .set('Authorization', auth)
      .expect(409);

    const delivered = await http()
      .post(`/v1/admin/orders/${order.id}/deliver`)
      .set('Authorization', admin())
      .expect(200);
    expect((delivered.body as ApiOrder).status).toBe('DELIVERED');

    expect((await events(order.id)).slice(-2)).toEqual([
      {
        type: 'order.shipped',
        data: {
          orderId: order.id,
          userId,
          carrier: 'Delhivery',
          trackingNumber: 'DL123456789IN',
        },
      },
      { type: 'order.delivered', data: { orderId: order.id, userId } },
    ]);
  });

  it('admin cancel (ADMIN_CANCELLED); customers get 403 on admin actions', async () => {
    const { auth, order } = await placeOrder();
    await http()
      .post(`/v1/admin/orders/${order.id}/cancel`)
      .set('Authorization', auth)
      .expect(403);
    const res = await http()
      .post(`/v1/admin/orders/${order.id}/cancel`)
      .set('Authorization', admin())
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'CANCELLED',
      failureReason: 'ADMIN_CANCELLED',
    });
  });
});
