import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Response } from 'supertest';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { financialYear } from '../src/invoices/invoice-math';
import { OrderSagaService } from '../src/saga/order-saga.service';
import { oid, product, startOrderApp } from './helpers';

const PHONE = oid(1); // ₹10,000

// Phase 2 P4: one GST invoice per paid order, numbered when it becomes
// PAID, downloadable as a PDF by its owner and by admins.
describe('Invoices (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startOrderApp>>;
  let ds: DataSource;
  let redis: Redis;
  const http = () => ctx.http();
  const fy = financialYear(new Date());

  // Read the PDF as raw bytes.
  const binary = (
    res: Response,
    done: (e: Error | null, b: Buffer) => void,
  ) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  async function placeOrder() {
    const userId = randomUUID();
    const auth = ctx.bearer(userId);
    await http()
      .post('/v1/cart/items')
      .set('Authorization', auth)
      .send({ productId: PHONE, qty: 2 })
      .expect(201);
    const res = await http()
      .post('/v1/orders')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        shippingAddress: {
          fullName: 'Asha Patel',
          phone: '9876543210',
          line1: '12, Shanti Nagar',
          city: 'Pune',
          state: 'Maharashtra', // another state than the seller: IGST
          pincode: '411001',
        },
      })
      .expect(201);
    return { userId, auth, id: (res.body as { id: string }).id };
  }

  /** CONFIRMED → PAID through the real saga step, in one transaction. */
  const pay = async (orderId: string) => {
    await ds.query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [
      orderId,
    ]);
    const saga = ctx.app.get(OrderSagaService);
    await ds.transaction((m) =>
      saga.onPaymentSucceeded(m, {
        orderId,
        paymentId: randomUUID(),
        amountPaise: 1,
      } as never),
    );
  };
  const invoiceRow = async (orderId: string) =>
    (
      await ds.query<{ number: string; seq: number }[]>(
        'SELECT number, seq FROM invoices WHERE order_id = $1',
        [orderId],
      )
    )[0];
  const download = (id: string, auth: string) =>
    http()
      .get(`/v1/orders/${id}/invoice`)
      .set('Authorization', auth)
      .buffer(true)
      .parse(binary);

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

  it('PAID issues the invoice; the owner downloads it as a PDF', async () => {
    const { auth, id } = await placeOrder();
    const early = await download(id, auth).expect(409);
    expect(JSON.parse((early.body as Buffer).toString()).code).toBe(
      'INVOICE_NOT_READY',
    );

    await pay(id);
    expect(await invoiceRow(id)).toMatchObject({
      number: `SF/${fy.slice(2)}/000001`,
      seq: 1,
    });

    const res = await download(id, auth).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="invoice-SF-${fy.slice(2)}-000001.pdf"`,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('numbers go up by one; a rolled-back payment gives its number back', async () => {
    const a = await placeOrder();
    const b = await placeOrder();
    const c = await placeOrder();
    await pay(a.id);

    // B's payment transaction fails after the invoice was numbered.
    await ds.query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [
      b.id,
    ]);
    const saga = ctx.app.get(OrderSagaService);
    await expect(
      ds.transaction(async (m) => {
        await saga.onPaymentSucceeded(m, { orderId: b.id } as never);
        throw new Error('crash after numbering');
      }),
    ).rejects.toThrow('crash');
    expect(await invoiceRow(b.id)).toBeUndefined();

    await pay(c.id);
    expect((await invoiceRow(c.id)).seq).toBe(2); // no gap
    await pay(b.id); // the retry
    expect((await invoiceRow(b.id)).seq).toBe(3);
  });

  it('only the owner or an admin; old paid orders get one on first download', async () => {
    const { auth, id } = await placeOrder();
    // Paid before invoices existed: no row yet.
    await ds.query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [
      id,
    ]);

    await download(id, ctx.bearer(randomUUID())).expect(404);

    // Two first downloads at once: one number, not two.
    const [one, two] = await Promise.all([
      download(id, auth),
      http()
        .get(`/v1/admin/orders/${id}/invoice`)
        .set('Authorization', ctx.bearer(randomUUID(), 'admin'))
        .buffer(true)
        .parse(binary),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.headers['content-disposition']).toBe(
      two.headers['content-disposition'],
    );
    const counters = await ds.query<{ last_seq: number }[]>(
      'SELECT last_seq FROM invoice_counters',
    );
    expect(counters).toEqual([{ last_seq: 1 }]);

    await http()
      .get(`/v1/admin/orders/${id}/invoice`)
      .set('Authorization', auth) // a customer token
      .expect(403);
  });

  it('a cancelled + refunded order keeps its invoice (marked cancelled)', async () => {
    const { auth, id } = await placeOrder();
    await pay(id);
    await http()
      .post(`/v1/orders/${id}/cancel`)
      .set('Authorization', auth)
      .expect(200);
    await download(id, auth).expect(200);

    // Never paid and cancelled: still no invoice.
    const other = await placeOrder();
    await http()
      .post(`/v1/orders/${other.id}/cancel`)
      .set('Authorization', other.auth)
      .expect(200);
    await download(other.id, other.auth).expect(409);
  });
});
