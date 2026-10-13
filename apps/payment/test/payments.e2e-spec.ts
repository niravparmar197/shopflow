import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { DataSource } from 'typeorm';
import { ResilienceRegistry } from '@app/resilience';
import { envelope, eventually } from '../../../test/helpers/kafka';
import { PaymentSweeper } from '../src/payments/payment-sweeper';
import { RefundService } from '../src/payments/refund.service';
import { FakePaymentProvider } from '../src/providers/fake.provider';
import { PaymentProviderFactory } from '../src/providers/provider.factory';
import { startPaymentApp } from './helpers';

type Status =
  'PENDING' | 'SUCCEEDED' | 'EXPIRED' | 'REFUND_PENDING' | 'REFUNDED';

interface PaymentRow {
  status: Status;
  amount_paise: number;
  last_error: string | null;
  provider_order_id: string | null;
  refund_attempted_at: Date | null;
}

// Real payment service + real PostgreSQL + real Kafka, with the fake
// provider. The test plays the order service (order.* on Kafka) and the
// payment provider (signed webhooks). The sweeper's timer is off: the tests
// call expireDue() / processPending() themselves, so nothing depends on luck.
describe('Payments (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startPaymentApp>>;
  let ds: DataSource;
  let producer: Producer;
  let fake: FakePaymentProvider;
  let sweeper: PaymentSweeper;
  let refunds: RefundService;
  let registry: ResilienceRegistry;

  // ---------- helpers ----------
  const payment = async (orderId: string) =>
    (
      await ds.query<PaymentRow[]>(
        'SELECT * FROM payments WHERE order_id = $1',
        [orderId],
      )
    )[0];

  const outboxCount = async (orderId: string, type: string) =>
    (
      await ds.query<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1 AND event_type = $2',
        [orderId, type],
      )
    )[0].n;

  const processed = async (eventId: string) =>
    (
      await ds.query<unknown[]>(
        'SELECT 1 FROM processed_events WHERE event_id = $1',
        [eventId],
      )
    ).length === 1;

  // Key = orderId, the same as the real relay.
  const sendOrderEvent = async <T extends { data: { orderId: string } }>(
    ev: T,
  ) => {
    await producer.send({
      topic: 'order-events',
      messages: [{ key: ev.data.orderId, value: JSON.stringify(ev) }],
    });
    return ev;
  };

  const orderConfirmed = (
    orderId: string,
    userId: string,
    totalPaise = 50_000,
  ) =>
    envelope('order.confirmed', {
      orderId,
      userId,
      totalPaise,
      currency: 'INR',
    });

  const orderCancelled = (orderId: string, userId: string) =>
    envelope('order.cancelled', { orderId, userId, reason: 'USER_CANCELLED' });

  /** A payment row straight in the DB: fast, no Kafka round trip. */
  async function seedPayment(
    opts: { status?: Status; expired?: boolean; checkedOut?: boolean } = {},
  ) {
    const { status = 'PENDING', expired = false, checkedOut = true } = opts;
    const orderId = randomUUID();
    const userId = randomUUID();
    const paid = status === 'SUCCEEDED' || status === 'REFUND_PENDING';
    await ds.query(
      `INSERT INTO payments (order_id, user_id, amount_paise, currency, status, provider,
                             provider_order_id, provider_payment_id, expires_at, version)
       VALUES ($1, $2, 50000, 'INR', $3, $4, $5, $6, now() + $7::interval, 1)`,
      [
        orderId,
        userId,
        status,
        checkedOut ? 'fake' : null,
        checkedOut ? `fake_${orderId}` : null,
        paid ? `fakepay_${orderId}` : null,
        expired ? '-1 minute' : '15 minutes',
      ],
    );
    return { orderId, userId, providerOrderId: `fake_${orderId}` };
  }

  /** Signed exactly like the provider: HMAC of the raw string we send. */
  function webhook(
    type: 'payment.succeeded' | 'payment.failed',
    providerOrderId: string,
    opts: { eventId?: string; secret?: string } = {},
  ) {
    const { raw, signature } = FakePaymentProvider.sign(
      opts.secret ?? ctx.webhookSecret,
      { id: opts.eventId ?? randomUUID(), type, providerOrderId },
    );
    return ctx
      .http()
      .post('/v1/payments/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-fake-signature', signature)
      .send(raw); // the exact string → the exact bytes that were signed
  }

  const checkout = (orderId: string, userId: string) =>
    ctx
      .http()
      .post(`/v1/payments/${orderId}/checkout`)
      .set('Authorization', ctx.bearer(userId));

  // ---------- lifecycle ----------
  beforeAll(async () => {
    ctx = await startPaymentApp();
    ds = ctx.ds;
    fake = ctx.app.get(PaymentProviderFactory).default() as FakePaymentProvider;
    sweeper = ctx.app.get(PaymentSweeper);
    refunds = ctx.app.get(RefundService);
    registry = ctx.app.get(ResilienceRegistry);
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
    fake.mode = 'ok';
    fake.refunds.length = 0;
    registry.clear(); // every test starts with a CLOSED circuit
  });

  // ---------- order.confirmed → payment ----------
  it('order.confirmed 3 times → one PENDING payment', async () => {
    const orderId = randomUUID();
    const userId = randomUUID();
    const ev = orderConfirmed(orderId, userId);
    await sendOrderEvent(ev);
    await sendOrderEvent(ev);
    await sendOrderEvent(ev);
    // Marker on the same key → same partition → handled after the 3 copies.
    const marker = await sendOrderEvent(
      envelope('order.cancelled', {
        orderId,
        userId,
        reason: 'MARKER',
      }),
    );
    await eventually(async () =>
      expect(await processed(marker.eventId)).toBe(true),
    );

    const [{ n }] = await ds.query<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM payments WHERE order_id = $1',
      [orderId],
    );
    expect(n).toBe(1);
    // (the marker cancel then expired it, which also proves ordering)
    expect(await payment(orderId)).toMatchObject({
      status: 'EXPIRED',
      amount_paise: 50_000,
      last_error: 'ORDER_CANCELLED:MARKER',
    });
  });

  it('a free order (total 0) → SUCCEEDED at once + payment.succeeded', async () => {
    const orderId = randomUUID();
    await sendOrderEvent(orderConfirmed(orderId, randomUUID(), 0));
    await eventually(async () =>
      expect((await payment(orderId))?.status).toBe('SUCCEEDED'),
    );
    expect(await outboxCount(orderId, 'payment.succeeded')).toBe(1);
  });

  // ---------- checkout ----------
  it('checkout is idempotent; another user gets 404 (no IDOR)', async () => {
    const p = await seedPayment({ checkedOut: false });
    const a = await checkout(p.orderId, p.userId).expect(200);
    const b = await checkout(p.orderId, p.userId).expect(200);
    expect(a.body).toMatchObject({ provider: 'fake', amountPaise: 50_000 });
    expect(b.body.providerOrderId).toBe(a.body.providerOrderId); // resumed, not new
    expect((await payment(p.orderId)).provider_order_id).toBe(
      a.body.providerOrderId,
    );

    const other = await checkout(p.orderId, randomUUID()).expect(404);
    expect(other.body.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('checkout of an expired payment → 409 PAYMENT_EXPIRED', async () => {
    const p = await seedPayment({ expired: true, checkedOut: false });
    const res = await checkout(p.orderId, p.userId).expect(409);
    expect(res.body.code).toBe('PAYMENT_EXPIRED');
  });

  // ---------- webhooks ----------
  it('bad signature → 401, nothing changes', async () => {
    const p = await seedPayment();
    const res = await webhook('payment.succeeded', p.providerOrderId, {
      secret: 'wrong-secret',
    }).expect(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
    expect((await payment(p.orderId)).status).toBe('PENDING');
  });

  it('signed but incomplete body → 400 INVALID_WEBHOOK', async () => {
    // No providerOrderId. Signed by hand: sign() always includes one.
    const raw = JSON.stringify({ id: randomUUID(), type: 'payment.succeeded' });
    const sig = createHmac('sha256', ctx.webhookSecret)
      .update(raw)
      .digest('hex');
    const res = await ctx
      .http()
      .post('/v1/payments/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-fake-signature', sig)
      .send(raw)
      .expect(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK');
  });

  it('declined attempt keeps PENDING; success → SUCCEEDED once; duplicate skipped', async () => {
    const p = await seedPayment();
    await webhook('payment.failed', p.providerOrderId).expect(200);
    expect(await payment(p.orderId)).toMatchObject({
      status: 'PENDING',
      last_error: 'CARD_DECLINED',
    });

    const eventId = randomUUID();
    const outcome = async (opts: { eventId?: string } = {}) =>
      (await webhook('payment.succeeded', p.providerOrderId, opts).expect(200))
        .body.outcome as string;
    expect(await outcome({ eventId })).toBe('succeeded');
    expect(await outcome({ eventId })).toBe('duplicate');
    expect(await outcome()).toBe('already-succeeded'); // new event id

    expect(await payment(p.orderId)).toMatchObject({
      status: 'SUCCEEDED',
      last_error: null,
    });
    expect(await outboxCount(p.orderId, 'payment.succeeded')).toBe(1);
  });

  it('unknown provider order → 503 and the event id is not kept (so a retry works)', async () => {
    const res = await webhook('payment.succeeded', 'fake_nope').expect(503);
    expect(res.body.code).toBe('PAYMENT_NOT_FOUND_YET');
    const [{ n }] = await ds.query<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM webhook_events',
    );
    expect(n).toBe(0);
  });

  // ---------- timeout + late success ----------
  it('timeout → EXPIRED + payment.failed; a late success → refunded', async () => {
    const p = await seedPayment({ expired: true });
    expect(await sweeper.expireDue()).toBe(1);
    expect((await payment(p.orderId)).status).toBe('EXPIRED');
    expect(await outboxCount(p.orderId, 'payment.failed')).toBe(1);
    expect(await sweeper.expireDue()).toBe(0); // only PENDING rows expire

    const res = await webhook('payment.succeeded', p.providerOrderId).expect(
      200,
    );
    expect(res.body.outcome).toBe('late-success-refund');
    // The fast path refunds it right after the commit.
    await eventually(async () =>
      expect((await payment(p.orderId)).status).toBe('REFUNDED'),
    );
    expect(fake.refunds).toEqual([
      { providerPaymentId: expect.any(String), amountPaise: 50_000 },
    ]);
    expect(await outboxCount(p.orderId, 'payment.refunded')).toBe(1);
    expect(await outboxCount(p.orderId, 'payment.succeeded')).toBe(0);
  });

  it('refund provider down → stays REFUND_PENDING; retried only after the lease', async () => {
    const p = await seedPayment({ status: 'REFUND_PENDING' });
    fake.mode = 'fail';
    expect(await refunds.processPending()).toBe(0);
    const first = await payment(p.orderId);
    expect(first.status).toBe('REFUND_PENDING');
    expect(first.refund_attempted_at).not.toBeNull();

    // Within the lease another run doesn't even claim it.
    fake.mode = 'ok';
    expect(await refunds.processPending()).toBe(0);
    expect((await payment(p.orderId)).refund_attempted_at).toEqual(
      first.refund_attempted_at,
    );
    expect(fake.refunds).toHaveLength(0);

    // Lease over → refunded.
    await ds.query(
      `UPDATE payments SET refund_attempted_at = now() - interval '3 minutes' WHERE order_id = $1`,
      [p.orderId],
    );
    expect(await refunds.processPending()).toBe(1);
    expect((await payment(p.orderId)).status).toBe('REFUNDED');
    expect(fake.refunds).toHaveLength(1);
  });

  // ---------- THE RACE ----------
  it('webhook vs timeout, 20 times → exactly one final outcome, one refund per lost race', async () => {
    const tally = { succeeded: 0, refunded: 0 };

    for (let i = 0; i < 20; i++) {
      const p = await seedPayment({ expired: true });
      // Both at the same moment, on purpose. A small random head start for
      // the sweeper gives a mix of winners instead of always the same one.
      await Promise.all([
        webhook('payment.succeeded', p.providerOrderId).expect(200),
        sleep(Math.random() * 15).then(() => sweeper.expireDue()),
      ]);
      await refunds.processPending(); // may race the webhook's fast path: the lease decides

      const s = await outboxCount(p.orderId, 'payment.succeeded');
      const f = await outboxCount(p.orderId, 'payment.failed');
      expect(s + f).toBe(1); // never both, never neither

      if (s === 1) {
        expect((await payment(p.orderId)).status).toBe('SUCCEEDED');
        tally.succeeded++;
      } else {
        await eventually(async () =>
          expect((await payment(p.orderId)).status).toBe('REFUNDED'),
        );
        expect(await outboxCount(p.orderId, 'payment.refunded')).toBe(1);
        tally.refunded++;
      }
    }

    expect(fake.refunds).toHaveLength(tally.refunded); // never a double refund
    console.log('race outcomes', tally); // the split changes; the invariant never does
  });

  // ---------- compensation from Order ----------
  it('order.cancelled: SUCCEEDED → refunded; PENDING → EXPIRED (no event)', async () => {
    const paid = await seedPayment({ status: 'SUCCEEDED' });
    const open = await seedPayment();

    await sendOrderEvent(orderCancelled(paid.orderId, paid.userId));
    await sendOrderEvent(orderCancelled(open.orderId, open.userId));

    await eventually(async () =>
      expect((await payment(paid.orderId)).status).toBe('REFUND_PENDING'),
    );
    await eventually(async () =>
      expect(await payment(open.orderId)).toMatchObject({
        status: 'EXPIRED',
        last_error: 'ORDER_CANCELLED:USER_CANCELLED',
      }),
    );
    // Order already knows: no payment.failed back to it.
    expect(await outboxCount(open.orderId, 'payment.failed')).toBe(0);

    expect(await refunds.processPending()).toBe(1);
    expect((await payment(paid.orderId)).status).toBe('REFUNDED');
    expect(await outboxCount(paid.orderId, 'payment.refunded')).toBe(1);

    // A success webhook after the cancel is a late success → refund too.
    const res = await webhook('payment.succeeded', open.providerOrderId).expect(
      200,
    );
    expect(res.body.outcome).toBe('late-success-refund');
  });

  // ---------- circuit breaker ----------
  it('provider down → circuit opens → the next checkout fails fast', async () => {
    fake.mode = 'fail';
    // 2 checkouts × 3 attempts = 6 failures ≥ volumeThreshold (5) at 100%.
    for (let i = 0; i < 2; i++) {
      const p = await seedPayment({ checkedOut: false });
      const res = await checkout(p.orderId, p.userId).expect(503);
      expect(res.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    expect(registry.states()['payment-provider:fake']).toBe('OPEN');

    const createCheckout = jest.spyOn(fake, 'createCheckout');
    const p = await seedPayment({ checkedOut: false });
    const t0 = Date.now();
    await checkout(p.orderId, p.userId).expect(503);
    expect(Date.now() - t0).toBeLessThan(300); // no retries, no backoff
    expect(createCheckout).not.toHaveBeenCalled(); // the provider wasn't called
    createCheckout.mockRestore();
  });

  it('a slow provider is cut off by the timeout (not left hanging)', async () => {
    fake.mode = 'slow';
    fake.slowMs = 10_000;
    const p = await seedPayment({ checkedOut: false });
    const t0 = Date.now();
    const res = await checkout(p.orderId, p.userId).expect(503);
    expect(res.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    // 3 × 2 s timeout + backoff, well under the 10 s the provider would take.
    expect(Date.now() - t0).toBeLessThan(9_000);
    fake.slowMs = 5_000;
  });
});
