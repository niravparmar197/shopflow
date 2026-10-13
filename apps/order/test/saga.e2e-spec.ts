import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import {
  envelope,
  eventually,
  header,
  readTopic,
} from '../../../test/helpers/kafka';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1);

// Real order service + PostgreSQL + Redis + Kafka. The test plays the
// inventory service: it puts stock.* events on Kafka and checks the order.
describe('Order saga (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  let producer: Producer;

  const reset = async () => {
    await ds.query(
      'TRUNCATE order_items, orders, outbox, idempotency_keys, coupons, processed_events CASCADE',
    );
    await redis.flushdb();
  };

  async function placeOrder(): Promise<string> {
    const auth = ctx.bearer(randomUUID());
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
  }

  const orderOf = async (id: string) =>
    (
      await ds.query<{ status: string; failure_reason: string | null }[]>(
        'SELECT status, failure_reason FROM orders WHERE id = $1',
        [id],
      )
    )[0];

  const outboxCount = async (orderId: string, eventType: string) =>
    (
      await ds.query<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1 AND event_type = $2',
        [orderId, eventType],
      )
    )[0].n;

  const sendInventoryEvent = (ev: object, key: string) =>
    producer.send({
      topic: 'inventory-events',
      messages: [{ key, value: JSON.stringify(ev) }],
    });

  const stockReserved = (orderId: string) =>
    envelope('stock.reserved', {
      orderId,
      items: [{ productId: PHONE, quantity: 1 }],
    });

  const stockFailed = (orderId: string) =>
    envelope('stock.failed', {
      orderId,
      reason: 'OUT_OF_STOCK',
      items: [{ productId: PHONE, requested: 1, available: 0 }],
    });

  beforeAll(async () => {
    ctx = await startOrderApp({ kafka: true });
    ds = ctx.app.get(DataSource);
    redis = ctx.app.get(REDIS);
    producer = new Kafka({
      clientId: 'test',
      brokers: ctx.brokers,
      logLevel: logLevel.NOTHING,
    }).producer();
    await producer.connect();
  });

  beforeEach(async () => {
    await reset();
    ctx.catalog.set(product(PHONE, 'Phone', 'phones', 1_000_000));
  });

  afterAll(async () => {
    await producer?.disconnect();
    if (!ctx) return;
    await reset(); // leave the shared database clean for the other suites
    await ctx.close();
  });

  it('placing an order publishes order.created to Kafka (outbox relay)', async () => {
    const orderId = await placeOrder();

    const [msg] = await readTopic(ctx.brokers, 'order-events', {
      key: orderId,
    });
    const ev = JSON.parse(msg.value!.toString());
    expect(ev).toMatchObject({
      type: 'order.created',
      version: 1,
      data: { orderId },
    });
    expect(header(msg.headers, 'event-id')).toBe(ev.eventId);

    await eventually(async () => {
      const [row] = await ds.query<{ published_at: Date | null }[]>(
        'SELECT published_at FROM outbox WHERE aggregate_id = $1',
        [orderId],
      );
      expect(row.published_at).not.toBeNull();
    });
  });

  it('stock.reserved 3 times → CONFIRMED, one order.confirmed', async () => {
    const orderId = await placeOrder();
    const markerOrder = await placeOrder();
    const ev = stockReserved(orderId);

    await sendInventoryEvent(ev, orderId);
    await sendInventoryEvent(ev, orderId);
    await sendInventoryEvent(ev, orderId);
    // Marker on the same key → same partition → handled after the 3 copies.
    await sendInventoryEvent(stockReserved(markerOrder), orderId);

    await eventually(async () =>
      expect((await orderOf(markerOrder)).status).toBe('CONFIRMED'),
    );
    expect((await orderOf(orderId)).status).toBe('CONFIRMED');
    expect(await outboxCount(orderId, 'order.confirmed')).toBe(1);
  });

  it('stock.failed → FAILED; a late stock.reserved is ignored', async () => {
    const orderId = await placeOrder();

    await sendInventoryEvent(stockFailed(orderId), orderId);
    await eventually(async () =>
      expect(await orderOf(orderId)).toEqual({
        status: 'FAILED',
        failure_reason: 'OUT_OF_STOCK',
      }),
    );
    expect(await outboxCount(orderId, 'order.failed')).toBe(1);

    // The state machine says no; the event is recorded as handled, not
    // retried or dead-lettered.
    const late = stockReserved(orderId);
    await sendInventoryEvent(late, orderId);
    await eventually(async () => {
      const rows = await ds.query<unknown[]>(
        'SELECT 1 FROM processed_events WHERE event_id = $1',
        [late.eventId],
      );
      expect(rows).toHaveLength(1);
    });
    expect((await orderOf(orderId)).status).toBe('FAILED');
    expect(await outboxCount(orderId, 'order.confirmed')).toBe(0);
  });

  it('an event for an unknown order → order-svc.dlq', async () => {
    const ghost = randomUUID();
    await sendInventoryEvent(stockReserved(ghost), ghost);

    const [dead] = await readTopic(ctx.brokers, 'order-svc.dlq', {
      key: ghost,
    });
    expect(header(dead.headers, 'x-error')).toContain('not found');
    expect(header(dead.headers, 'x-dlq-reason')).toBe('poison');
  });
});
