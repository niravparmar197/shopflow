import { setTimeout as sleep } from 'node:timers/promises';
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
 * Fault injection for resilience tests:
 *   ok    → works
 *   fail  → 503 every time (opens the circuit); refunds fail too
 *   slow  → answers after 5 s (longer than our 2 s timeout)
 *   flaky → each payment fails twice with a 502, then works (retry wins)
 */
export type FakeMode = 'ok' | 'fail' | 'slow' | 'flaky';
export const FAKE_MODES: readonly FakeMode[] = ['ok', 'fail', 'slow', 'flaky'];

/**
 * For local dev and tests: no keys, no network. Webhooks are signed like the
 * real ones (HMAC-SHA256 of the raw body, in the x-fake-signature header).
 * The factory refuses it in production.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  /** Every refund asked for; tests check this. */
  readonly refunds: { providerPaymentId: string; amountPaise: number }[] = [];
  mode: FakeMode = 'ok';
  slowMs = 5_000;
  private readonly flakyCalls = new Map<string, number>();

  constructor(private readonly webhookSecret: string) {}

  /** Builds a correctly signed webhook (dev scripts and tests). */
  static sign(secret: string, body: FakeWebhookBody) {
    const raw = JSON.stringify(body);
    return { raw, signature: hmacSha256Hex(secret, raw) };
  }

  async createCheckout(i: CreateCheckoutInput): Promise<CheckoutSession> {
    // ref: false: an abandoned slow call must not keep the process alive.
    if (this.mode === 'slow') {
      await sleep(this.slowMs, undefined, { ref: false });
    }
    if (this.mode === 'fail') {
      throw Object.assign(new Error('Fake provider down'), { statusCode: 503 });
    }
    if (this.mode === 'flaky') {
      const n = (this.flakyCalls.get(i.paymentId) ?? 0) + 1;
      this.flakyCalls.set(i.paymentId, n);
      if (n <= 2) {
        throw Object.assign(new Error(`Fake flaky failure #${n}`), {
          statusCode: 502,
        });
      }
    }
    return {
      provider: this.name,
      providerOrderId: `fake_${i.paymentId}`,
      amountPaise: i.amountPaise,
      currency: i.currency,
    };
  }

  resumeCheckout(
    providerOrderId: string,
    amountPaise: number,
    currency: string,
  ): Promise<CheckoutSession> {
    return Promise.resolve({
      provider: this.name,
      providerOrderId,
      amountPaise,
      currency,
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
    if (this.mode === 'fail') {
      return Promise.reject(
        Object.assign(new Error('Fake refund down'), { statusCode: 503 }),
      );
    }
    this.refunds.push({ providerPaymentId, amountPaise });
    return Promise.resolve();
  }
}
