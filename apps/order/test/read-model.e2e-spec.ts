import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { registry } from '@app/observability';
import { OrderViewProjector } from '../src/read-model/order-view.projector';
import { envelope } from '../../../test/helpers/kafka';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1); // ₹10,000
const CASE = oid(2); // ₹500

interface TimelineStep {
  step: string;
  label: string;
}

// No Kafka here: the projector is fed directly, as the consumer would feed
// it, so the tests choose the order in which events arrive.
describe('Metrics + read model (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  let projector: OrderViewProjector;

  const http = () => ctx.http();

  /** One event into the projector, inside a transaction like the consumer. */
  const project = (type: string, data: object, occurredAt: string) =>
    ds.transaction((m) =>
      projector.apply(m, envelope(type, data, { occurredAt }) as never),
    );

  const counterValue = async (name: string) =>
    ((await registry.getSingleMetric(name)?.get())?.values ?? []).reduce(
      (n, v) => n + v.value,
      0,
    );

  async function placeOrder(auth: string) {
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 1 })
      .expect(201);
    return (
      await http()
        .post('/v1/orders')
        .set('Authorization', auth)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(201)
    ).body as { id: string; totalPaise: number };
  }

  const view = async (orderId: string) =>
    (
      await ds.query<Record<string, unknown>[]>(
        'SELECT * FROM order_views WHERE order_id = $1',
        [orderId],
      )
    )[0];

  beforeAll(async () => {
    ctx = await startOrderApp();
    ds = ctx.app.get(DataSource);
    redis = ctx.app.get(REDIS);
    projector = ctx.app.get(OrderViewProjector);
  });

  afterAll(() => ctx?.close());

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE order_items, orders, outbox, idempotency_keys, order_views CASCADE',
    );
    await redis.flushdb();
    ctx.catalog.set(
      product(PHONE, 'Phone', 'phones', 1_000_000),
      product(CASE, 'Case', 'accessories', 50_000),
    );
  });

  // ---------- metrics ----------
  it('/metrics: route templates, no raw ids, one unmatched bucket, business counter', async () => {
    const before = await counterValue('shopflow_orders_placed_total');
    const auth = ctx.bearer(randomUUID());
    await placeOrder(auth);
    const fake = randomUUID();
    await http()
      .get(`/v1/orders/${fake}`)
      .set('Authorization', auth)
      .expect(404);
    await http().get(`/totally-random-${fake}`).expect(404);

    const text = (await http().get('/metrics').expect(200)).text;
    expect(text).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*route="\/v1\/orders\/:id"[^}]*status_code="404"/,
    );
    expect(text).toMatch(/route="unmatched"/);
    // CARDINALITY: ids belong in traces, never in labels.
    expect(text).not.toContain(fake);
    expect(text).toContain('service="order"'); // default label (initMetrics)
    expect(await counterValue('shopflow_orders_placed_total')).toBe(before + 1);
  });

  // ---------- projector ----------
  it('out-of-order events: placeholder filled, status never goes back, timeline sorted', async () => {
    const orderId = randomUUID();
    const userId = randomUUID();

    // The WRONG order: payment first, then created, then a late confirmed.
    await project(
      'payment.succeeded',
      {
        paymentId: randomUUID(),
        orderId,
        userId,
        amountPaise: 1_100_000,
        provider: 'fake',
      },
      '2026-01-01T10:03:00.000Z',
    );
    expect(await view(orderId)).toMatchObject({
      status_rank: 0,
      placed_at: null, // placeholder: hidden from the list
    });
    await project(
      'order.paid',
      { orderId, userId, totalPaise: 1_100_000 },
      '2026-01-01T10:03:01.000Z',
    );
    await project(
      'order.created',
      {
        orderId,
        userId,
        totalPaise: 1_100_000,
        currency: 'INR',
        items: [
          { productId: PHONE, quantity: 1, name: 'Phone' },
          { productId: CASE, quantity: 2, name: 'Case' },
        ],
      },
      '2026-01-01T10:00:00.000Z',
    );
    await project(
      'order.confirmed',
      { orderId, userId, totalPaise: 1_100_000, currency: 'INR' },
      '2026-01-01T10:01:00.000Z',
    );

    expect(await view(orderId)).toMatchObject({
      status: 'PAID', // the late CONFIRMED did not move it back
      status_rank: 3,
      payment_status: 'SUCCEEDED',
      title: 'Phone + 1 more',
      item_count: 3,
      total_paise: 1_100_000,
    });

    const res = await http()
      .get(`/v1/orders/${orderId}/tracking`)
      .set('Authorization', ctx.bearer(userId))
      .expect(200);
    const timeline = res.body.timeline as TimelineStep[];
    expect(timeline.map((t) => t.step)).toEqual([
      'PLACED',
      'CONFIRMED',
      'PAYMENT_RECEIVED',
      'PAID',
    ]);
    expect(timeline[0].label).toBe('Order placed');
  });

  it('cancel then a late payment + refund: stays CANCELLED, payment REFUNDED', async () => {
    const orderId = randomUUID();
    const userId = randomUUID();
    const payment = { paymentId: randomUUID(), orderId, userId };

    await project(
      'order.created',
      {
        orderId,
        userId,
        totalPaise: 100,
        currency: 'INR',
        items: [{ productId: PHONE, quantity: 1 }],
      },
      '2026-01-01T10:00:00.000Z',
    );
    await project(
      'order.cancelled',
      { orderId, userId, reason: 'PAYMENT_TIMEOUT' },
      '2026-01-01T10:16:00.000Z',
    );
    await project(
      'payment.succeeded',
      { ...payment, amountPaise: 100, provider: 'fake' },
      '2026-01-01T10:17:00.000Z',
    );
    await project(
      'payment.refunded',
      { ...payment, amountPaise: 100 },
      '2026-01-01T10:17:05.000Z',
    );

    expect(await view(orderId)).toMatchObject({
      status: 'CANCELLED',
      failure_reason: 'PAYMENT_TIMEOUT',
      payment_status: 'REFUNDED',
    });
  });

  // ---------- read-your-writes + IDOR ----------
  it('a brand-new order shows at once (syncing), then from the view, never twice', async () => {
    const userId = randomUUID();
    const auth = ctx.bearer(userId);
    const order = await placeOrder(auth); // no consumers → the view is empty

    const list1 = (
      await http().get('/v1/orders').set('Authorization', auth).expect(200)
    ).body;
    expect(list1.items).toHaveLength(1);
    expect(list1.items[0]).toMatchObject({ id: order.id, syncing: true });
    const track1 = (
      await http()
        .get(`/v1/orders/${order.id}/tracking`)
        .set('Authorization', auth)
        .expect(200)
    ).body;
    expect(track1).toMatchObject({ syncing: true, status: 'PENDING' });

    // The projector catches up.
    await project(
      'order.created',
      {
        orderId: order.id,
        userId,
        totalPaise: order.totalPaise,
        currency: 'INR',
        items: [{ productId: PHONE, quantity: 1, name: 'Phone' }],
      },
      new Date().toISOString(),
    );

    const list2 = (
      await http().get('/v1/orders').set('Authorization', auth).expect(200)
    ).body;
    expect(list2.items).toHaveLength(1); // not from both sources
    expect(list2.items[0]).toMatchObject({
      id: order.id,
      syncing: false,
      title: 'Phone',
    });

    // Someone else's order: 404, not 403 (IDOR).
    await http()
      .get(`/v1/orders/${order.id}/tracking`)
      .set('Authorization', ctx.bearer(randomUUID()))
      .expect(404);
  });
});
