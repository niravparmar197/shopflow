import { HttpException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';
import { REDIS } from '@app/common';
import { Coupon, CouponType } from '../src/coupons/coupon.entity';
import { CouponsService } from '../src/coupons/coupons.service';
import { IdempotencyService } from '../src/idempotency/idempotency.service';
import { CheckoutService } from '../src/orders/checkout.service';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1); // ₹10,000
const CASE = oid(2); // ₹500
const CART_TOTAL = 2 * 1_000_000 + 50_000; // 2 phones + 1 case

interface ApiOrder {
  id: string;
  items: { productId: string; unitPricePaise: number }[];
}

// Real order service + real PostgreSQL + real Redis; only the product
// service is faked. Each test starts from empty tables and Redis.
describe('Orders (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  let coupons: Repository<Coupon>;

  const http = () => ctx.http();
  const newUser = () => {
    const id = randomUUID();
    return { id, auth: ctx.bearer(id) };
  };

  async function fillCart(auth: string, coupon?: string) {
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 2 })
      .expect(201);
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: CASE, qty: 1 })
      .expect(201);
    if (coupon) {
      await http()
        .post('/v1/cart/coupon')
        .set('Authorization', auth)
        .send({ code: coupon })
        .expect(200);
    }
  }

  const placeOrder = (auth: string, key = randomUUID(), body: object = {}) =>
    http()
      .post('/v1/orders')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send(body);

  const cartItems = async (auth: string) =>
    (await http().get('/v1/cart').set('Authorization', auth).expect(200)).body
      .items as unknown[];

  async function count(table: string) {
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${table}`,
    );
    return n;
  }

  const usedCount = async (code: string) =>
    (await coupons.findOneByOrFail({ code })).usedCount;

  const createCoupon = (fields: Partial<Coupon>) =>
    coupons.save(
      coupons.create({
        type: CouponType.PERCENT,
        value: 10,
        validFrom: new Date('2026-01-01'),
        validTo: new Date('2030-12-31'),
        ...fields,
      }),
    );

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
    coupons = ctx.app.get(getRepositoryToken(Coupon));
  });

  beforeEach(async () => {
    await reset();
    ctx.catalog.down = false;
    ctx.catalog.set(
      product(PHONE, 'Phone', 'phones', 1_000_000),
      product(CASE, 'Case', 'accessories', 50_000),
    );
  });

  afterAll(async () => {
    if (!ctx) return;
    await reset(); // leave the shared database clean for the other suite
    await ctx.app.close();
  });

  it('places an order: order, items and outbox event saved, cart cleared, prices snapshotted', async () => {
    const user = newUser();
    await fillCart(user.auth);

    const res = await placeOrder(user.auth, randomUUID(), {
      expectedTotalPaise: CART_TOTAL,
    }).expect(201);
    const order = res.body as ApiOrder;
    expect(res.body).toMatchObject({
      status: 'PENDING',
      subtotalPaise: CART_TOTAL,
      discountPaise: 0,
      totalPaise: CART_TOTAL,
    });
    expect(order.items).toHaveLength(2);

    const [event] = await ds.query<
      {
        id: string;
        event_type: string;
        published_at: Date | null;
        payload: Record<string, unknown>;
      }[]
    >('SELECT * FROM outbox WHERE aggregate_id = $1', [order.id]);
    expect(event.event_type).toBe('order.created');
    expect(event.published_at).toBeNull();
    expect(event.payload).toMatchObject({
      eventId: event.id,
      orderId: order.id,
      userId: user.id,
      totalPaise: CART_TOTAL,
    });

    expect(await cartItems(user.auth)).toHaveLength(0);

    // A later price change doesn't touch the placed order.
    ctx.catalog.set(product(PHONE, 'Phone', 'phones', 1));
    const again = await http()
      .get(`/v1/orders/${order.id}`)
      .set('Authorization', user.auth)
      .expect(200);
    const phone = (again.body as ApiOrder).items.find(
      (i) => i.productId === PHONE,
    );
    expect(phone?.unitPricePaise).toBe(1_000_000);
  });

  describe('idempotency', () => {
    it('same key twice: one order, the second response is replayed', async () => {
      const user = newUser();
      await fillCart(user.auth);
      const key = randomUUID();

      const first = await placeOrder(user.auth, key).expect(201);
      // The cart is empty now; the saved success comes back anyway.
      const second = await placeOrder(user.auth, key).expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await count('orders')).toBe(1);
      expect(await count('outbox')).toBe(1);
    });

    it('5 parallel requests with the same key: exactly one order', async () => {
      const user = newUser();
      await fillCart(user.auth);
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => placeOrder(user.auth, key)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain(201);
      statuses.forEach((s) => expect([201, 409]).toContain(s));
      const ids = results
        .filter((r) => r.status === 201)
        .map((r) => (r.body as ApiOrder).id);
      expect(new Set(ids).size).toBe(1);
      expect(await count('orders')).toBe(1);
      expect(await count('outbox')).toBe(1);
    });

    it('same key with a different body: 422; no key: 400', async () => {
      const user = newUser();
      await fillCart(user.auth);
      const key = randomUUID();
      await placeOrder(user.auth, key, {}).expect(201);

      const reused = await placeOrder(user.auth, key, {
        expectedTotalPaise: 5,
      }).expect(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const missing = await http()
        .post('/v1/orders')
        .set('Authorization', user.auth)
        .send({})
        .expect(400);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('a key completed by someone else meanwhile: this checkout rolls back (no second order)', async () => {
      // A slow request whose lease was taken over: the other one finished
      // first, so this one must not commit a second order.
      const user = newUser();
      await fillCart(user.auth);
      const idempotency = ctx.app.get(IdempotencyService);
      const key = randomUUID();
      await idempotency.claim(user.id, key, idempotency.hash({}));
      await ds.query(
        `UPDATE idempotency_keys SET status = 'COMPLETED' WHERE key = $1`,
        [key],
      );

      await expect(
        ctx.app.get(CheckoutService).placeOrder(
          user.id,
          {},
          {
            beforeCommit: (m, o) =>
              idempotency.complete(m, user.id, key, 201, { id: o.id }),
          },
        ),
      ).rejects.toThrow(HttpException);
      expect(await count('orders')).toBe(0);
      expect(await count('outbox')).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('2 users race for the last coupon use: one order, used_count = 1', async () => {
      await createCoupon({ code: 'LAST1', usageLimit: 1 });
      const a = newUser();
      const b = newUser();
      await fillCart(a.auth, 'LAST1');
      await fillCart(b.auth, 'LAST1');

      const [ra, rb] = await Promise.all([
        placeOrder(a.auth),
        placeOrder(b.auth),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([201, 409]);
      const loser = ra.status === 409 ? ra : rb;
      expect(['COUPON_EXHAUSTED', 'COUPON_NOT_APPLICABLE']).toContain(
        loser.body.code,
      );
      expect(await usedCount('LAST1')).toBe(1);
      expect(await count('orders')).toBe(1);

      // The loser keeps their cart.
      expect(await cartItems(ra.status === 409 ? a.auth : b.auth)).toHaveLength(
        2,
      );
    });

    it('both pass the rules before either commits: the atomic UPDATE stops the second (COUPON_EXHAUSTED)', async () => {
      // Forces the timing the HTTP race only sometimes hits: transaction 1
      // redeems and holds the row lock; transaction 2 has already read the
      // coupon (still unused), then blocks on the UPDATE until 1 commits.
      await createCoupon({ code: 'LAST1', usageLimit: 1 });
      const service = ctx.app.get(CouponsService);
      const line = {
        productId: PHONE,
        qty: 1,
        name: 'Phone',
        category: 'phones',
        unitPricePaise: 1_000_000,
        lineTotalPaise: 1_000_000,
        available: true,
      };
      const redeem = (m: Parameters<CouponsService['redeem']>[0]) =>
        service.redeem(m, 'LAST1', randomUUID(), [line], 1_000_000);

      const runner1 = ds.createQueryRunner();
      await runner1.startTransaction();
      await redeem(runner1.manager); // used_count 0 → 1, row locked

      const second = ds.transaction((m) => redeem(m));
      await new Promise((r) => setTimeout(r, 300)); // let it block on the row
      await runner1.commitTransaction();
      await runner1.release();

      await expect(second).rejects.toMatchObject({
        response: { code: 'COUPON_EXHAUSTED' },
      });
      expect(await usedCount('LAST1')).toBe(1);
    });

    it('same user, 2 keys at once: one order, the other finds the cart empty', async () => {
      const user = newUser();
      await fillCart(user.auth);

      const results = await Promise.all([
        placeOrder(user.auth),
        placeOrder(user.auth),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(await count('orders')).toBe(1);
    });
  });

  describe('failures leave nothing behind', () => {
    it('wrong expected total: full rollback, key freed, retry with the same key works', async () => {
      await createCoupon({ code: 'SAVE10', usageLimit: 10 });
      const user = newUser();
      await fillCart(user.auth, 'SAVE10');
      const key = randomUUID();

      const bad = await placeOrder(user.auth, key, {
        expectedTotalPaise: 1,
      }).expect(409);
      expect(bad.body.code).toBe('PRICE_CHANGED');
      expect(bad.body.details.totalPaise).toBe(CART_TOTAL - CART_TOTAL / 10);

      expect(await count('orders')).toBe(0);
      expect(await count('outbox')).toBe(0);
      expect(await count('idempotency_keys')).toBe(0);
      expect(await usedCount('SAVE10')).toBe(0);
      expect(await cartItems(user.auth)).toHaveLength(2);

      await placeOrder(user.auth, key, {
        expectedTotalPaise: bad.body.details.totalPaise,
      }).expect(201);
      expect(await usedCount('SAVE10')).toBe(1);
    });

    it('product service down: 503, nothing saved, cart intact', async () => {
      const user = newUser();
      await fillCart(user.auth);
      ctx.catalog.down = true;

      await placeOrder(user.auth).expect(503);
      expect(await count('orders')).toBe(0);
      expect(await count('idempotency_keys')).toBe(0);
      ctx.catalog.down = false;
      expect(await cartItems(user.auth)).toHaveLength(2);
    });
  });

  describe('reading orders', () => {
    it("another user's order is a 404; the list pages with a cursor", async () => {
      const owner = newUser();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        await fillCart(owner.auth);
        ids.push((await placeOrder(owner.auth).expect(201)).body.id);
      }

      const notMine = await http()
        .get(`/v1/orders/${ids[0]}`)
        .set('Authorization', newUser().auth)
        .expect(404);
      expect(notMine.body.code).toBe('ORDER_NOT_FOUND');

      const page1 = await http()
        .get('/v1/orders?limit=2')
        .set('Authorization', owner.auth)
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toBeTruthy();

      const page2 = await http()
        .get(`/v1/orders?limit=2&cursor=${page1.body.nextCursor}`)
        .set('Authorization', owner.auth)
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      const seen = [...page1.body.items, ...page2.body.items].map(
        (o: { id: string }) => o.id,
      );
      expect(seen).toEqual([...ids].reverse()); // newest first, none missed
    });
  });
});
