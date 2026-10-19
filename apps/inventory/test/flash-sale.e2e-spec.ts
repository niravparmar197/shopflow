import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type Redis from 'ioredis';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { envelope, eventually } from '../../../test/helpers/kafka';
import { FlashSaleService } from '../src/flash/flash-sale.service';
import { startInventoryApp } from './helpers';

const P = 'c'.repeat(24); // a product id
const TOKEN = 'test-internal-token'; // e2e-setup.ts

// The flash-sale gate (Redis) + its tie-in with reservations (Postgres,
// Kafka). Real Redis, Postgres and Kafka.
describe('Flash-sale gate (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startInventoryApp>>;
  let ds: DataSource;
  let redis: Redis;
  let flash: FlashSaleService;
  let producer: Producer;

  const setStock = (available: number) =>
    ds.query(
      `INSERT INTO stock (product_id, available, version) VALUES ($1, $2, 1)
       ON CONFLICT (product_id) DO UPDATE SET available = $2, reserved = 0`,
      [P, available],
    );
  const reservationStatus = async (orderId: string) =>
    (
      await ds.query<{ status: string }[]>(
        'SELECT status FROM reservations WHERE order_id = $1',
        [orderId],
      )
    )[0]?.status;
  const publish = (ev: { data: { orderId: string } }) =>
    producer.send({
      topic: 'order-events',
      messages: [{ key: ev.data.orderId, value: JSON.stringify(ev) }],
    });
  const internal = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await startInventoryApp();
    ds = ctx.ds;
    redis = ctx.app.get(REDIS);
    flash = ctx.app.get(FlashSaleService);
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

  beforeEach(async () => {
    await ctx.reset();
    await redis.flushdb();
  });

  it('100 buyers at once for 10 units → exactly 10 tokens', async () => {
    await setStock(10);
    await flash.start(P, 10, 30);
    const results = await Promise.all(
      Array.from({ length: 100 }, () => flash.acquire(P, randomUUID(), 1)),
    );
    expect(results.filter((r) => r.result === 'OK')).toHaveLength(10);
    expect(results.filter((r) => r.result === 'SOLD_OUT')).toHaveLength(90);
    expect(await flash.status(P)).toMatchObject({
      active: true,
      left: 0,
      total: 10,
      buyers: 10,
    });
  });

  it('one per customer; too many units; not on sale', async () => {
    await setStock(10);
    const user = randomUUID();
    expect((await flash.acquire(P, user, 1)).result).toBe('NOT_FLASH');

    await flash.start(P, 10, 30);
    expect((await flash.acquire(P, user, 2)).result).toBe('LIMIT');
    expect((await flash.acquire(P, user, 1)).result).toBe('OK');
    expect((await flash.acquire(P, user, 1)).result).toBe('ALREADY_BOUGHT');
    expect((await flash.status(P)).left).toBe(9);
  });

  it('release is idempotent, and a non-buyer gives nothing back', async () => {
    await setStock(5);
    await flash.start(P, 5, 30);
    const user = randomUUID();
    await flash.acquire(P, user, 1);

    expect(await flash.release(P, user, 1)).toBe(true);
    expect(await flash.release(P, user, 1)).toBe(false); // redelivery, retry
    expect(await flash.release(P, randomUUID(), 1)).toBe(false);
    expect(await flash.status(P)).toMatchObject({ left: 5, buyers: 0 });
    // Back on sale: the same user may buy again.
    expect((await flash.acquire(P, user, 1)).result).toBe('OK');
  });

  it('order.cancelled → stock AND the flash token go back (after commit)', async () => {
    await setStock(2);
    await flash.start(P, 2, 30);
    const user = randomUUID();
    await flash.acquire(P, user, 1);

    const orderId = randomUUID();
    const created = envelope('order.created', {
      orderId,
      userId: user,
      items: [{ productId: P, quantity: 1 }],
      totalPaise: 100,
      currency: 'INR',
    });
    await publish(created);
    await eventually(async () =>
      expect(await reservationStatus(orderId)).toBe('RESERVED'),
    );
    expect(await flash.status(P)).toMatchObject({ left: 1, buyers: 1 });

    await publish(
      envelope('order.cancelled', {
        orderId,
        userId: user,
        reason: 'PAYMENT_TIMEOUT',
      }),
    );
    await eventually(async () =>
      expect(await flash.status(P)).toMatchObject({ left: 2, buyers: 0 }),
    );
    expect(await reservationStatus(orderId)).toBe('RELEASED');
  });

  it('the gate said yes but the DB said no (stock.failed) → the token goes back', async () => {
    await setStock(1);
    await flash.start(P, 1, 30);
    await setStock(0); // drift: the DB has less than the gate thinks
    const user = randomUUID();
    expect((await flash.acquire(P, user, 1)).result).toBe('OK');

    const orderId = randomUUID();
    await publish(
      envelope('order.created', {
        orderId,
        userId: user,
        items: [{ productId: P, quantity: 1 }],
        totalPaise: 100,
        currency: 'INR',
      }),
    );
    // The DB is the final judge: no reservation, and the token is returned.
    await eventually(async () =>
      expect(await flash.status(P)).toMatchObject({ left: 1, buyers: 0 }),
    );
    expect(await reservationStatus(orderId)).toBeUndefined();
  });

  it('start: no more than the stock; no restart while one is running', async () => {
    await setStock(3);
    await expect(flash.start(P, 4, 30)).rejects.toMatchObject({
      response: { code: 'NOT_ENOUGH_STOCK' },
    });
    await flash.start(P, 3, 30);
    await flash.acquire(P, randomUUID(), 1);
    await expect(flash.start(P, 3, 30)).rejects.toMatchObject({
      response: { code: 'SALE_ACTIVE' },
    });
    expect((await flash.status(P)).buyers).toBe(1); // buyers not forgotten

    await flash.end(P);
    expect(await flash.status(P)).toEqual({ productId: P, active: false });
  });

  it('a sale ends by itself; the buyer list goes with it', async () => {
    await setStock(3);
    await flash.start(P, 3, 30);
    await flash.acquire(P, randomUUID(), 1);
    expect(await flash.activeProductIds()).toEqual([P]);
    // The buyer list expires together with the sale (no leftover keys).
    const [saleTtl, buyersTtl] = await Promise.all([
      redis.pttl(`inv:flash:${P}`),
      redis.pttl(`inv:flash:${P}:buyers`),
    ]);
    expect(buyersTtl).toBeGreaterThan(0);
    expect(Math.abs(saleTtl - buyersTtl)).toBeLessThan(1_000);

    await redis.pexpire(`inv:flash:${P}`, 100); // "30 minutes later"
    await sleep(200);
    expect(await flash.status(P)).toEqual({ productId: P, active: false });
    expect((await flash.acquire(P, randomUUID(), 1)).result).toBe('NOT_FLASH');
    expect(await flash.activeProductIds()).toEqual([]);
  });

  it('public list: live sales only, units and time left, soonest first (P5)', async () => {
    const Q = 'd'.repeat(24);
    await setStock(5);
    await ds.query(
      `INSERT INTO stock (product_id, available, version) VALUES ($1, 4, 1)
       ON CONFLICT (product_id) DO UPDATE SET available = 4, reserved = 0`,
      [Q],
    );
    await flash.start(P, 5, 60);
    await flash.start(Q, 4, 10); // ends sooner
    await flash.acquire(P, randomUUID(), 1);

    const res = await internal().get('/flash-sales').expect(200); // no token
    expect(res.body.items).toEqual([
      expect.objectContaining({ productId: Q, left: 4, total: 4 }),
      expect.objectContaining({ productId: P, left: 4, total: 5 }),
    ]);
    expect(res.body.items[0].endsInSec).toBeLessThanOrEqual(600);
    expect(res.body.items[0]).not.toHaveProperty('buyers');

    await flash.end(Q);
    const after = await internal().get('/flash-sales').expect(200);
    expect(
      after.body.items.map((i: { productId: string }) => i.productId),
    ).toEqual([P]);
  });

  it('/internal/* needs the service token', async () => {
    await setStock(3);
    await flash.start(P, 3, 30);
    const body = { productId: P, userId: randomUUID(), quantity: 1 };

    await internal()
      .post('/internal/flash-sales/acquire')
      .send(body)
      .expect(401);
    await internal()
      .post('/internal/flash-sales/acquire')
      .set('x-internal-token', 'wrong-token-of-the-same-length')
      .send(body)
      .expect(401);
    const ok = await internal()
      .post('/internal/flash-sales/acquire')
      .set('x-internal-token', TOKEN)
      .send(body)
      .expect(200);
    expect(ok.body).toEqual({ result: 'OK', left: 2 });
  });
});
