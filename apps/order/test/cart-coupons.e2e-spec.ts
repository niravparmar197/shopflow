import { randomUUID } from 'node:crypto';
import { FakeCatalog, oid, product, startOrderApp } from './helpers';

const PHONE = oid(1); // ₹5,000
const SHOE = oid(2); // ₹2,000
const PEN = oid(3); // ₹300
const MISC = Array.from({ length: 25 }, (_, i) => oid(100 + i)); // ₹10 each

// Real order service + real PostgreSQL + real Redis; only the product
// service is faked.
describe('Cart + coupons (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let catalog: FakeCatalog;
  const http = () => ctx.http();
  const bearer = (sub: string, role = 'customer') => ctx.bearer(sub, role);

  // Each test gets its own user, so its own empty cart.
  const newUser = () => bearer(randomUUID());

  const add = (auth: string, productId: string, qty = 1) =>
    http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId, qty });
  const applyCoupon = (auth: string, code: string) =>
    http().post('/v1/cart/coupon').set('Authorization', auth).send({ code });
  const createCoupon = (body: object, auth = bearer(randomUUID(), 'admin')) =>
    http()
      .post('/v1/coupons')
      .set('Authorization', auth)
      .send({ validFrom: '2026-01-01', validTo: '2030-12-31', ...body });

  beforeAll(async () => {
    ctx = await startOrderApp();
    catalog = ctx.catalog;
    catalog.set(
      product(PHONE, 'Phone', 'phones', 500000),
      product(SHOE, 'Shoe', 'shoes', 200000),
      product(PEN, 'Pen', 'stationery', 30000),
      ...MISC.map((id, i) => product(id, `Item ${i}`, 'misc', 1000)),
    );

    await createCoupon({
      code: 'SAVE10',
      type: 'PERCENT',
      value: 10,
      maxDiscountPaise: 50000,
    }).expect(201);
    await createCoupon({
      code: 'FLAT200',
      type: 'FLAT',
      value: 20000,
      minCartPaise: 100000,
    }).expect(201);
    await createCoupon({
      code: 'PHONES15',
      type: 'PERCENT',
      value: 15,
      category: 'phones',
    }).expect(201);
    await createCoupon({
      code: 'OLD50',
      type: 'FLAT',
      value: 5000,
      validFrom: '2024-01-01',
      validTo: '2024-12-31',
    }).expect(201);
  });

  afterEach(() => {
    catalog.down = false;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('cart', () => {
    it('adds items and calculates the subtotal from live prices', async () => {
      const u = newUser();
      await add(u, PHONE, 2).expect(201);
      const res = await add(u, SHOE, 1).expect(201);
      expect(res.body.subtotalPaise).toBe(2 * 500000 + 200000);
      expect(res.body.itemCount).toBe(3);
      expect(res.body.pricingAvailable).toBe(true);
    });

    it('25 parallel adds of different items leave exactly 20 in the cart (atomic Lua)', async () => {
      const u = newUser();
      const results = await Promise.all(MISC.map((id) => add(u, id)));

      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(20);
      expect(statuses.filter((s) => s === 400)).toHaveLength(5);

      const cart = await http()
        .get('/v1/cart')
        .set('Authorization', u)
        .expect(200);
      expect(cart.body.items).toHaveLength(20);
    });

    it('product service down: the cart loads without prices, adding fails with 503', async () => {
      const u = newUser();
      await add(u, PHONE).expect(201);
      catalog.down = true;

      const cart = await http()
        .get('/v1/cart')
        .set('Authorization', u)
        .expect(200);
      expect(cart.body.pricingAvailable).toBe(false);
      expect(cart.body.subtotalPaise).toBeNull();
      expect(cart.body.items).toEqual([
        { productId: PHONE, qty: 1, available: true },
      ]);

      await add(u, SHOE).expect(503);
    });
  });

  describe('coupons', () => {
    it('percent coupon is capped at maxDiscountPaise; the code is case-insensitive', async () => {
      const u = newUser();
      await add(u, PHONE, 2); // ₹10,000: 10% is ₹1,000, capped at ₹500
      const res = await applyCoupon(u, 'save10').expect(200);
      expect(res.body.coupon).toEqual({
        code: 'SAVE10',
        applied: true,
        discountPaise: 50000,
      });
      expect(res.body.totalPaise).toBe(1000000 - 50000);
    });

    it('min cart not met: 400 saying how much more to add', async () => {
      const u = newUser();
      await add(u, PEN); // ₹300 < ₹1,000
      const res = await applyCoupon(u, 'FLAT200').expect(400);
      expect(res.body.message).toBe(
        'Add items worth ₹700 more to use this coupon',
      );
    });

    it('category coupon discounts only items of that category', async () => {
      const u = newUser();
      await add(u, PHONE); // ₹5,000
      await add(u, SHOE); // ₹2,000
      const res = await applyCoupon(u, 'PHONES15').expect(200);
      expect(res.body.discountPaise).toBe(75000); // 15% of the phone only
      expect(res.body.totalPaise).toBe(700000 - 75000);
    });

    it('expired: 400, unknown: 404', async () => {
      const u = newUser();
      await add(u, PHONE);
      const expired = await applyCoupon(u, 'OLD50').expect(400);
      expect(expired.body.message).toBe('Coupon has expired');
      await applyCoupon(u, 'NOPE99').expect(404);
    });

    it('stops qualifying after a cart change: applied=false with a reason, cart still loads', async () => {
      const u = newUser();
      await add(u, SHOE); // ₹2,000 ≥ ₹1,000
      await applyCoupon(u, 'FLAT200').expect(200);

      await http()
        .delete(`/v1/cart/items/${SHOE}`)
        .set('Authorization', u)
        .expect(200);
      await add(u, PEN); // now ₹300

      const cart = await http()
        .get('/v1/cart')
        .set('Authorization', u)
        .expect(200);
      expect(cart.body.coupon).toMatchObject({
        code: 'FLAT200',
        applied: false,
        reason: 'Add items worth ₹700 more to use this coupon',
      });
      expect(cart.body.discountPaise).toBe(0);
      expect(cart.body.totalPaise).toBe(30000);
    });

    it('only admins can create coupons', async () => {
      await createCoupon(
        { code: 'HACK90', type: 'PERCENT', value: 90 },
        newUser(),
      ).expect(403);
    });
  });
});
