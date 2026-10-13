import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/common';
import { assertTransition, PaymentStatus } from '../payments/payment-status';
import { InvalidSignatureError } from './errors';
import { FakePaymentProvider, type FakeWebhookBody } from './fake.provider';
import { RazorpayAdapter } from './razorpay.adapter';
import { hmacSha256Hex } from './hmac';
import { PaymentProviderFactory } from './provider.factory';

const SECRET = 'test-secret';

const factoryWith = (env: Partial<Record<keyof Env, unknown>>) =>
  new PaymentProviderFactory(
    new ConfigService(env) as unknown as ConfigService<Env, true>,
  );

describe('FakePaymentProvider', () => {
  const fake = new FakePaymentProvider(SECRET);
  const body: FakeWebhookBody = {
    id: 'evt_1',
    type: 'payment.succeeded',
    providerOrderId: 'fake_p1',
  };

  it('accepts a correctly signed webhook', () => {
    const { raw, signature } = FakePaymentProvider.sign(SECRET, body);
    expect(
      fake.parseWebhook(Buffer.from(raw), { 'x-fake-signature': signature }),
    ).toEqual({
      kind: 'SUCCEEDED',
      providerEventId: 'evt_1',
      providerOrderId: 'fake_p1',
      providerPaymentId: 'fakepay_evt_1',
    });
  });

  it('a failed attempt is reported as ATTEMPT_FAILED, not final', () => {
    const { raw, signature } = FakePaymentProvider.sign(SECRET, {
      ...body,
      type: 'payment.failed',
    });
    expect(
      fake.parseWebhook(Buffer.from(raw), { 'x-fake-signature': signature }),
    ).toMatchObject({ kind: 'ATTEMPT_FAILED', reason: 'CARD_DECLINED' });
  });

  it.each([
    ['missing', undefined],
    ['wrong secret', FakePaymentProvider.sign('other', body).signature],
    ['short', 'abc'],
  ])('rejects a %s signature', (_name, signature) => {
    const { raw } = FakePaymentProvider.sign(SECRET, body);
    expect(() =>
      fake.parseWebhook(Buffer.from(raw), { 'x-fake-signature': signature }),
    ).toThrow(InvalidSignatureError);
  });

  it('rejects a body changed after signing', () => {
    const { signature } = FakePaymentProvider.sign(SECRET, body);
    const tampered = JSON.stringify({ ...body, providerOrderId: 'fake_p2' });
    expect(() =>
      fake.parseWebhook(Buffer.from(tampered), {
        'x-fake-signature': signature,
      }),
    ).toThrow(InvalidSignatureError);
  });
});

describe('RazorpayAdapter webhooks', () => {
  const razorpay = new RazorpayAdapter({
    keyId: 'rzp_test_x',
    keySecret: 'x',
    webhookSecret: SECRET,
  });
  const signed = (body: object) => {
    const raw = Buffer.from(JSON.stringify(body));
    return {
      raw,
      headers: {
        'x-razorpay-signature': hmacSha256Hex(SECRET, raw),
        'x-razorpay-event-id': 'evt_rzp',
      },
    };
  };
  const payment = (extra = {}) => ({
    payment: { entity: { id: 'pay_1', order_id: 'order_1', ...extra } },
  });

  it('maps payment.captured to SUCCEEDED', () => {
    const { raw, headers } = signed({
      event: 'payment.captured',
      created_at: 1,
      payload: payment(),
    });
    expect(razorpay.parseWebhook(raw, headers)).toEqual({
      kind: 'SUCCEEDED',
      providerEventId: 'evt_rzp',
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_1',
    });
  });

  it('maps payment.failed to ATTEMPT_FAILED with the reason', () => {
    const { raw, headers } = signed({
      event: 'payment.failed',
      created_at: 1,
      payload: payment({ error_description: 'Card expired' }),
    });
    expect(razorpay.parseWebhook(raw, headers)).toMatchObject({
      kind: 'ATTEMPT_FAILED',
      reason: 'Card expired',
    });
  });

  it('ignores other events', () => {
    const { raw, headers } = signed({ event: 'order.paid', created_at: 1 });
    expect(razorpay.parseWebhook(raw, headers)).toMatchObject({
      kind: 'IGNORED',
      type: 'order.paid',
    });
  });

  it('rejects a bad signature', () => {
    const { raw } = signed({ event: 'payment.captured', created_at: 1 });
    expect(() =>
      razorpay.parseWebhook(raw, { 'x-razorpay-signature': 'f'.repeat(64) }),
    ).toThrow(InvalidSignatureError);
  });
});

describe('PaymentProviderFactory', () => {
  it('builds the configured provider once and reuses it', () => {
    const factory = factoryWith({
      PAYMENT_PROVIDER: 'fake',
      FAKE_WEBHOOK_SECRET: SECRET,
    });
    expect(factory.default()).toBeInstanceOf(FakePaymentProvider);
    expect(factory.default()).toBe(factory.get('fake'));
  });

  it('is lazy: missing keys only fail when that provider is used', () => {
    const factory = factoryWith({ PAYMENT_PROVIDER: 'razorpay' });
    expect(() => factory.default()).toThrow('RAZORPAY_KEY_ID is not set');
  });

  it('refuses the fake provider in production', () => {
    const factory = factoryWith({
      NODE_ENV: 'production',
      FAKE_WEBHOOK_SECRET: SECRET,
    });
    expect(() => factory.get('fake')).toThrow('not allowed in production');
  });

  it('rejects an unknown provider name', () => {
    expect(() => factoryWith({}).get('paypal')).toThrow(BadRequestException);
  });
});

describe('payment status transitions', () => {
  it.each([
    [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED],
    [PaymentStatus.PENDING, PaymentStatus.EXPIRED],
    [PaymentStatus.EXPIRED, PaymentStatus.REFUND_PENDING],
    [PaymentStatus.REFUND_PENDING, PaymentStatus.REFUNDED],
    [PaymentStatus.SUCCEEDED, PaymentStatus.REFUND_PENDING], // order cancelled after payment
  ])('allows %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [PaymentStatus.SUCCEEDED, PaymentStatus.EXPIRED],
    [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED],
    [PaymentStatus.EXPIRED, PaymentStatus.SUCCEEDED],
    // A refund always goes through REFUND_PENDING (the lease), never directly.
    [PaymentStatus.EXPIRED, PaymentStatus.REFUNDED],
    [PaymentStatus.REFUND_PENDING, PaymentStatus.SUCCEEDED],
    [PaymentStatus.REFUNDED, PaymentStatus.PENDING],
  ])('rejects %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(ConflictException);
  });
});
