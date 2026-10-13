import { InvalidSignatureError } from './errors';
import { hmacSha256Hex, safeEqualHex } from './hmac';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentProvider,
  WebhookHeaders,
  WebhookResult,
} from './payment-provider';

export interface FakeWebhookBody {
  id: string;
  type: 'payment.succeeded' | 'payment.failed';
  providerOrderId: string;
  reason?: string;
}

/**
 * For local dev and tests: no keys, no network. Webhooks are signed like the
 * real ones (HMAC-SHA256 of the raw body, in the x-fake-signature header).
 * The factory refuses it in production.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  /** Every refund asked for; tests check this. */
  readonly refunds: { providerPaymentId: string; amountPaise: number }[] = [];

  constructor(private readonly webhookSecret: string) {}

  /** Builds a correctly signed webhook (dev scripts and tests). */
  static sign(secret: string, body: FakeWebhookBody) {
    const raw = JSON.stringify(body);
    return { raw, signature: hmacSha256Hex(secret, raw) };
  }

  createCheckout(i: CreateCheckoutInput): Promise<CheckoutSession> {
    return Promise.resolve({
      provider: this.name,
      providerOrderId: `fake_${i.paymentId}`,
      amountPaise: i.amountPaise,
      currency: i.currency,
    });
  }

  parseWebhook(raw: Buffer, headers: WebhookHeaders): WebhookResult {
    const sig = headers['x-fake-signature'];
    if (!sig || !safeEqualHex(sig, hmacSha256Hex(this.webhookSecret, raw))) {
      throw new InvalidSignatureError();
    }
    const body = JSON.parse(raw.toString()) as FakeWebhookBody;
    return body.type === 'payment.succeeded'
      ? {
          kind: 'SUCCEEDED',
          providerEventId: body.id,
          providerOrderId: body.providerOrderId,
          // From the event id, so a redelivered webhook names the same payment.
          providerPaymentId: `fakepay_${body.id}`,
        }
      : {
          kind: 'ATTEMPT_FAILED',
          providerEventId: body.id,
          providerOrderId: body.providerOrderId,
          reason: body.reason ?? 'CARD_DECLINED',
        };
  }

  refund(providerPaymentId: string, amountPaise: number): Promise<void> {
    this.refunds.push({ providerPaymentId, amountPaise });
    return Promise.resolve();
  }
}
