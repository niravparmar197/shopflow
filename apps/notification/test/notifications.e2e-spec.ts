import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { envelope, eventually, readTopic } from '../../../test/helpers/kafka';
import { startNotificationApp } from './helpers';

const EMAIL = 'buyer@test.dev';

// Real notification service + MongoDB + Redis (BullMQ) + Kafka; only SMTP
// is faked. The test plays the order and payment services.
describe('Notifications (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof startNotificationApp>>;
  let producer: Producer;

  // ---------- helpers ----------
  // Key = orderId, the same as the real relay.
  const send = (topic: string, ev: object, key: string) =>
    producer.send({ topic, messages: [{ key, value: JSON.stringify(ev) }] });

  const orderCreated = (orderId: string, email: string | null = EMAIL) =>
    envelope('order.created', {
      orderId,
      userId: randomUUID(),
      totalPaise: 123_450,
      currency: 'INR',
      items: [{ productId: 'a'.repeat(24), quantity: 2 }],
      ...(email ? { customerEmail: email } : {}),
    });

  const paid = (orderId: string) =>
    envelope('order.paid', {
      orderId,
      userId: randomUUID(),
      totalPaise: 123_450,
    });

  /**
   * An order in the projection. null = no email, like orders placed before
   * the snapshot. (Not undefined: that would pick the default.)
   */
  async function placedOrder(email: string | null = EMAIL) {
    const orderId = randomUUID();
    await send('order-events', orderCreated(orderId, email), orderId);
    await eventually(async () =>
      expect(await ctx.views.findById(orderId).lean()).toBeTruthy(),
    );
    return orderId;
  }

  /** Waits until the fake SMTP server has received n emails. */
  const emailsSent = (n: number) =>
    eventually(() => {
      expect(ctx.fakeEmail.sent).toHaveLength(n);
      return Promise.resolve();
    });

  const logsFor = (orderId: string) => ctx.logs.find({ orderId }).lean();
  const shortNo = (id: string) => id.slice(0, 8).toUpperCase();

  /**
   * fromBeginning = false: a NEW group starts at "now" and skips anything
   * sent before it joined (right in production: no replayed emails). So
   * send warm-up orders until one shows up in the projection.
   */
  async function waitUntilConsuming() {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const id = randomUUID();
      await send('order-events', orderCreated(id), id);
      await sleep(1_000);
      if (await ctx.views.findById(id).lean()) return;
    }
    throw new Error('The notification consumer never started consuming');
  }

  // ---------- lifecycle ----------
  beforeAll(async () => {
    ctx = await startNotificationApp();
    producer = new Kafka({
      clientId: 'test',
      brokers: ctx.brokers,
      logLevel: logLevel.NOTHING,
    }).producer();
    await producer.connect();
    await waitUntilConsuming();
  });

  afterAll(async () => {
    await producer?.disconnect();
    await ctx?.app.close();
  });

  beforeEach(() => ctx.reset());

  // ---------- projection ----------
  it('order.created → projection (email, item count, total)', async () => {
    const orderId = await placedOrder();
    expect(await ctx.views.findById(orderId).lean()).toMatchObject({
      email: EMAIL,
      totalPaise: 123_450,
      currency: 'INR',
      itemCount: 2,
    });
  });

  // ---------- happy path ----------
  it('order.paid → one confirmation email, log SENT', async () => {
    const orderId = await placedOrder();
    await send('order-events', paid(orderId), orderId);

    await emailsSent(1);
    const mail = ctx.fakeEmail.sent[0];
    expect(mail).toMatchObject({
      to: EMAIL,
      subject: `Order ${shortNo(orderId)} is confirmed`,
    });
    expect(mail.text).toContain('INR 1234.50');
    expect(mail.html).toContain('Thank you for your order!');
    expect(mail.headers?.['X-Notification-Key']).toMatch(/-email-order-paid$/);

    await eventually(async () =>
      expect(await logsFor(orderId)).toEqual([
        expect.objectContaining({
          template: 'order-paid',
          status: 'SENT',
          attempts: 1,
          to: EMAIL,
        }),
      ]),
    );
  });

  // ---------- dedupe ----------
  it('the same order.paid 3 times → still one email', async () => {
    const orderId = await placedOrder();
    const ev = paid(orderId);
    await send('order-events', ev, orderId);
    await send('order-events', ev, orderId);
    await send('order-events', ev, orderId);
    // Marker on the same key → same partition → handled after the 3 copies.
    await send(
      'order-events',
      envelope('order.cancelled', {
        orderId,
        userId: randomUUID(),
        reason: 'USER_CANCELLED',
      }),
      orderId,
    );

    await emailsSent(2);
    expect(await logsFor(orderId)).toHaveLength(2); // paid + cancelled
    expect(
      ctx.fakeEmail.sent.filter((m) => m.subject.includes('confirmed')),
    ).toHaveLength(1);
  });

  // ---------- templates ----------
  it.each([
    [
      'order-events',
      'order.cancelled',
      { reason: 'PAYMENT_TIMEOUT' },
      'was cancelled',
      'the payment was not completed in time',
    ],
    [
      'order-events',
      'order.failed',
      { reason: 'OUT_OF_STOCK' },
      'could not place',
      'went out of stock',
    ],
    [
      'payment-events',
      'payment.refunded',
      { paymentId: randomUUID(), amountPaise: 123_450 },
      'Refund for order',
      'INR 1234.50',
    ],
  ])(
    '%s %s → the right template',
    async (topic, type, extra, subject, text) => {
      const orderId = await placedOrder();
      await send(
        topic,
        envelope(type, { orderId, userId: randomUUID(), ...extra }),
        orderId,
      );

      await emailsSent(1);
      expect(ctx.fakeEmail.sent[0].subject).toContain(subject);
      expect(ctx.fakeEmail.sent[0].text).toContain(text);
    },
  );

  it('HTML escapes the values it is given', async () => {
    const orderId = await placedOrder();
    await send(
      'order-events',
      envelope('order.failed', {
        orderId,
        userId: randomUUID(),
        reason: '<script>alert(1)</script>',
      }),
      orderId,
    );
    await emailsSent(1);
    // An unknown reason gets a generic text, and nothing raw reaches the HTML.
    expect(ctx.fakeEmail.sent[0].html).not.toContain('<script>');
  });

  // ---------- retries ----------
  it('SMTP down → 4 attempts → FAILED; fixed + retry → SENT', async () => {
    ctx.fakeEmail.mode = 'down';
    const orderId = await placedOrder();
    await send('order-events', paid(orderId), orderId);

    await eventually(async () =>
      expect((await logsFor(orderId))[0]).toMatchObject({
        status: 'FAILED',
        attempts: 4,
      }),
    );
    expect(ctx.fakeEmail.calls).toBe(4);
    expect((await logsFor(orderId))[0].lastError).toContain('ECONNREFUSED');

    // Ops fixes SMTP and presses "Retry" (what Bull Board does).
    ctx.fakeEmail.mode = 'ok';
    const job = await ctx.queue.getJob((await logsFor(orderId))[0].key);
    expect(await job!.getState()).toBe('failed');
    await job!.retry();

    await eventually(async () =>
      expect((await logsFor(orderId))[0].status).toBe('SENT'),
    );
    expect(ctx.fakeEmail.sent).toHaveLength(1);
    expect((await logsFor(orderId))[0].lastError).toBeUndefined();
  });

  it('fails twice, then works → SENT with attempts 3', async () => {
    ctx.fakeEmail.failNext = 2;
    const orderId = await placedOrder();
    await send('order-events', paid(orderId), orderId);

    await eventually(async () =>
      expect((await logsFor(orderId))[0]).toMatchObject({
        status: 'SENT',
        attempts: 3,
      }),
    );
    expect(ctx.fakeEmail.sent).toHaveLength(1);
  });

  it('SMTP 550 (permanent) → FAILED after 1 attempt, no retries', async () => {
    ctx.fakeEmail.mode = 'reject';
    const orderId = await placedOrder();
    await send('order-events', paid(orderId), orderId);

    await eventually(async () =>
      expect((await logsFor(orderId))[0]).toMatchObject({
        status: 'FAILED',
        attempts: 1,
      }),
    );
    expect((await logsFor(orderId))[0].lastError).toContain('SMTP 550');
    await sleep(1_500); // time for a (wrong) retry: backoff is 100 ms here
    expect(ctx.fakeEmail.calls).toBe(1);
  });

  // ---------- nothing to send ----------
  it('an order without an email → nothing sent, nothing logged', async () => {
    const orderId = await placedOrder(null);
    await send('order-events', paid(orderId), orderId);

    // Marker: another order's order.paid on the SAME key, so it is handled
    // after the one above.
    const marker = await placedOrder();
    await send('order-events', paid(marker), orderId);
    await emailsSent(1);
    expect(ctx.fakeEmail.sent[0].subject).toContain(shortNo(marker));
    expect(await logsFor(orderId)).toHaveLength(0);
  });

  it('an event for an unknown order → retry topic → DLQ, no email', async () => {
    const ghost = randomUUID();
    await send('order-events', paid(ghost), ghost);

    const [dead] = await readTopic(ctx.brokers, 'notification-svc.dlq', {
      key: ghost,
      timeoutMs: 60_000,
    });
    expect(dead.headers?.['x-error']?.toString()).toContain(
      'not in projection yet',
    );
    expect(dead.headers?.['x-dlq-reason']?.toString()).toBe(
      'retries-exhausted',
    );
    expect(ctx.fakeEmail.sent).toHaveLength(0);
  });

  // ---------- support endpoint ----------
  it('GET /v1/notifications?orderId= is for admins only', async () => {
    const orderId = await placedOrder();
    await send('order-events', paid(orderId), orderId);
    await eventually(async () =>
      expect((await logsFor(orderId))[0]?.status).toBe('SENT'),
    );

    const res = await ctx
      .http()
      .get(`/v1/notifications?orderId=${orderId}`)
      .set('Authorization', ctx.bearer(randomUUID(), 'admin'))
      .expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({ template: 'order-paid', status: 'SENT' }),
    ]);
    expect(res.body[0]._id).toBeUndefined(); // no internal ids

    await ctx
      .http()
      .get(`/v1/notifications?orderId=${orderId}`)
      .set('Authorization', ctx.bearer(randomUUID()))
      .expect(403);
  });
});
