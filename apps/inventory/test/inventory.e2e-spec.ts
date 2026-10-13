import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { DataSource } from 'typeorm';
import {
  envelope,
  eventually,
  header,
  readTopic,
} from '../../../test/helpers/kafka';
import { startInventoryApp } from './helpers';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);

type Line = { productId: string; quantity: number };

// Real inventory service + real PostgreSQL + real Kafka. The test plays the
// order service: it puts order.created on Kafka and checks what happened.
describe('Inventory (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startInventoryApp>>;
  let ds: DataSource;
  let producer: Producer;

  // ---------- helpers ----------
  const setStock = (id: string, available: number) =>
    ds.query(
      `INSERT INTO stock (product_id, available, version) VALUES ($1, $2, 1)
       ON CONFLICT (product_id) DO UPDATE SET available = $2, reserved = 0`,
      [id, available],
    );

  const stockOf = async (id: string) =>
    (
      await ds.query<{ available: number; reserved: number }[]>(
        'SELECT available, reserved FROM stock WHERE product_id = $1',
        [id],
      )
    )[0];

  const count = async (table: string, where = 'true', params: unknown[] = []) =>
    (
      await ds.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
        params,
      )
    )[0].n;

  const orderCreated = (items: Line[], orderId = randomUUID()) =>
    envelope('order.created', {
      orderId,
      userId: randomUUID(),
      items,
      totalPaise: 100,
      currency: 'INR',
    });

  // Key = orderId, the same as the real relay.
  const publish = (ev: { data: { orderId: string } }, key = ev.data.orderId) =>
    producer.send({
      topic: 'order-events',
      messages: [{ key, value: JSON.stringify(ev) }],
    });

  const publishAll = (events: { data: { orderId: string } }[]) =>
    producer.send({
      topic: 'order-events',
      messages: events.map((e) => ({
        key: e.data.orderId,
        value: JSON.stringify(e),
      })),
    });

  // ---------- lifecycle ----------
  beforeAll(async () => {
    ctx = await startInventoryApp();
    ds = ctx.ds;
    producer = new Kafka({
      clientId: 'test',
      brokers: ctx.brokers,
      logLevel: logLevel.NOTHING,
    }).producer();
    await producer.connect();
  });

  afterAll(async () => {
    await producer?.disconnect();
    await ctx?.app.close();
  });

  beforeEach(() => ctx.reset());

  it('reserves stock and publishes stock.reserved', async () => {
    await setStock(A, 5);
    const ev = orderCreated([{ productId: A, quantity: 2 }]);
    await publish(ev);

    await eventually(async () =>
      expect(await stockOf(A)).toEqual({ available: 3, reserved: 2 }),
    );
    expect(
      await count('reservations', 'order_id = $1', [ev.data.orderId]),
    ).toBe(1);

    // The relay really sent it to Kafka.
    const [msg] = await readTopic(ctx.brokers, 'inventory-events', {
      key: ev.data.orderId,
    });
    const out = JSON.parse(msg.value!.toString());
    expect(out.type).toBe('stock.reserved');
    expect(out.correlationId).toBe('test'); // the trace id travels along
  });

  it('the same event 3 times → reserved once', async () => {
    await setStock(A, 5);
    await setStock(B, 5);
    const ev = orderCreated([{ productId: A, quantity: 2 }]);
    await publish(ev);
    await publish(ev);
    await publish(ev);

    // Marker: another order on the SAME key → same partition → handled after
    // the 3 copies. Once it's done, all 3 copies have been handled.
    const marker = orderCreated([{ productId: B, quantity: 1 }]);
    await publish(marker, ev.data.orderId);
    await eventually(async () =>
      expect(await stockOf(B)).toEqual({ available: 4, reserved: 1 }),
    );

    expect(await stockOf(A)).toEqual({ available: 3, reserved: 2 });
    expect(
      await count('reservations', 'order_id = $1', [ev.data.orderId]),
    ).toBe(1);
    expect(await count('processed_events', 'event_id = $1', [ev.eventId])).toBe(
      1,
    );
    expect(
      await count(
        'outbox',
        `aggregate_id = $1 AND event_type = 'stock.reserved'`,
        [ev.data.orderId],
      ),
    ).toBe(1);
  });

  it('one product short → nothing reserved, stock.failed has the numbers', async () => {
    await setStock(A, 5);
    await setStock(B, 1);
    const ev = orderCreated([
      { productId: A, quantity: 2 },
      { productId: B, quantity: 3 },
    ]);
    await publish(ev);

    await eventually(async () =>
      expect(
        await count(
          'outbox',
          `aggregate_id = $1 AND event_type = 'stock.failed'`,
          [ev.data.orderId],
        ),
      ).toBe(1),
    );
    expect(await stockOf(A)).toEqual({ available: 5, reserved: 0 }); // savepoint undid A
    expect(await stockOf(B)).toEqual({ available: 1, reserved: 0 });
    expect(await count('reservations')).toBe(0);

    const [row] = await ds.query<{ payload: { data: { items: unknown } } }[]>(
      'SELECT payload FROM outbox WHERE aggregate_id = $1',
      [ev.data.orderId],
    );
    expect(row.payload.data.items).toEqual([
      { productId: B, requested: 3, available: 1 },
    ]);
  });

  it('flash sale: 100 buyers, 10 items → exactly 10 reserved, never negative', async () => {
    await setStock(A, 10);
    await publishAll(
      Array.from({ length: 100 }, () =>
        orderCreated([{ productId: A, quantity: 1 }]),
      ),
    );

    await eventually(
      async () => expect(await count('processed_events')).toBe(100),
      90_000,
      500,
    );
    expect(await stockOf(A)).toEqual({ available: 0, reserved: 10 });
    expect(await count('reservations')).toBe(10);
    expect(await count('outbox', `event_type = 'stock.reserved'`)).toBe(10);
    expect(await count('outbox', `event_type = 'stock.failed'`)).toBe(90);
  });

  it('orders locking [A,B] and [B,A] at once → all finish, no deadlock', async () => {
    await setStock(A, 100);
    await setStock(B, 100);
    await publishAll(
      Array.from({ length: 30 }, (_, i) =>
        orderCreated(
          i % 2 === 0
            ? [
                { productId: A, quantity: 1 },
                { productId: B, quantity: 1 },
              ]
            : [
                { productId: B, quantity: 1 },
                { productId: A, quantity: 1 },
              ],
        ),
      ),
    );

    await eventually(
      async () => expect(await count('processed_events')).toBe(30),
      60_000,
      500,
    );
    expect(await stockOf(A)).toEqual({ available: 70, reserved: 30 });
    expect(await stockOf(B)).toEqual({ available: 70, reserved: 30 });
  });

  it.each([
    ['not JSON', () => 'hello', 'Not valid JSON'],
    ['bad envelope', () => JSON.stringify({ hello: 'world' }), 'Bad envelope'],
    [
      'bad data',
      () => JSON.stringify(envelope('order.created', { orderId: 'x' })),
      'Invalid order.created',
    ],
    [
      'unknown version',
      () =>
        JSON.stringify({
          ...orderCreated([{ productId: A, quantity: 1 }]),
          version: 9,
        }),
      'Unsupported version',
    ],
  ])(
    'poison (%s) → DLQ, and the consumer keeps going',
    async (_name, makeValue, expectedError) => {
      const key = `poison-${randomUUID()}`;
      await producer.send({
        topic: 'order-events',
        messages: [{ key, value: makeValue() }],
      });

      const [dead] = await readTopic(ctx.brokers, 'inventory-svc.dlq', {
        key,
      });
      expect(header(dead.headers, 'x-error')).toContain(expectedError);
      expect(header(dead.headers, 'x-original-topic')).toBe('order-events');
      expect(header(dead.headers, 'x-dlq-reason')).toBe('poison');

      // Still alive.
      await setStock(A, 1);
      await publish(orderCreated([{ productId: A, quantity: 1 }]));
      await eventually(async () =>
        expect(await stockOf(A)).toEqual({ available: 0, reserved: 1 }),
      );
    },
  );

  it('a DB error → retry topic → succeeds once the DB is fixed', async () => {
    await setStock(A, 5);
    try {
      await ds.query('ALTER TABLE stock RENAME TO stock_x'); // "the DB is broken"
      const ev = orderCreated([{ productId: A, quantity: 1 }]);
      await publish(ev);

      const [retry] = await readTopic(ctx.brokers, 'inventory-svc.retry', {
        key: ev.data.orderId,
      });
      expect(header(retry.headers, 'x-attempt')).toBe('1');
      expect(header(retry.headers, 'x-error')).toContain('stock');

      await ds.query('ALTER TABLE stock_x RENAME TO stock'); // "the DB is fixed"
      await eventually(
        async () =>
          expect(await stockOf(A)).toEqual({ available: 4, reserved: 1 }),
        30_000,
      );
      expect(
        await count('reservations', 'order_id = $1', [ev.data.orderId]),
      ).toBe(1);
    } finally {
      await ds.query('ALTER TABLE IF EXISTS stock_x RENAME TO stock');
    }
  });
});
