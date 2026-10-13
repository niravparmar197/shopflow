import Razorpay from 'razorpay';
import { InvalidSignatureError } from './errors';
import { hmacSha256Hex, safeEqualHex } from './hmac';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentProvider,
  WebhookHeaders,
  WebhookResult,
} from './payment-provider';

// The parts of a Razorpay webhook body we read.
interface RazorpayWebhook {
  event: string;
  created_at: number;
  payload?: {
    payment?: {
      entity: { id: string; order_id: string; error_description?: string };
    };
  };
}

/** ADAPTER: Razorpay's SDK and webhooks → our PaymentProvider shape. */
export class RazorpayAdapter implements PaymentProvider {
  readonly name = 'razorpay' as const;
  private readonly client: Razorpay;

  constructor(
    private readonly opts: {
      keyId: string;
      keySecret: string;
      webhookSecret: string;
    },
  ) {
    this.client = new Razorpay({
      key_id: opts.keyId,
      key_secret: opts.keySecret,
    });
  }

  async createCheckout(i: CreateCheckoutInput): Promise<CheckoutSession> {
    // Razorpay orders have no idempotency key: our DB stops a second create
    // for the same payment (Part 2).
    const order = await this.client.orders.create({
      amount: i.amountPaise, // Razorpay also counts in paise
      currency: i.currency,
      receipt: i.paymentId, // max 40 chars; a UUID is 36
      notes: { orderId: i.orderId, paymentId: i.paymentId },
    });
    return {
      provider: this.name,
      providerOrderId: order.id,
      publicKey: this.opts.keyId,
      amountPaise: i.amountPaise,
      currency: i.currency,
    };
  }

  // A Razorpay order is all the frontend needs: no API call.
  resumeCheckout(
    providerOrderId: string,
    amountPaise: number,
    currency: string,
  ): Promise<CheckoutSession> {
    return Promise.resolve({
      provider: this.name,
      providerOrderId,
      publicKey: this.opts.keyId,
      amountPaise,
      currency,
    });
  }

  parseWebhook(raw: Buffer, headers: WebhookHeaders): WebhookResult {
    const signature = headers['x-razorpay-signature'];
    if (
      !signature ||
      !safeEqualHex(signature, hmacSha256Hex(this.opts.webhookSecret, raw))
    ) {
      throw new InvalidSignatureError();
    }
    const body = JSON.parse(raw.toString()) as RazorpayWebhook;
    const eventId =
      headers['x-razorpay-event-id'] ?? `${body.event}:${body.created_at}`;
    const p = body.payload?.payment?.entity;

    if (p && body.event === 'payment.captured') {
      return {
        kind: 'SUCCEEDED',
        providerEventId: eventId,
        providerOrderId: p.order_id,
        providerPaymentId: p.id,
      };
    }
    if (p && body.event === 'payment.failed') {
      return {
        kind: 'ATTEMPT_FAILED',
        providerEventId: eventId,
        providerOrderId: p.order_id,
        reason: p.error_description ?? 'PAYMENT_FAILED',
      };
    }
    return { kind: 'IGNORED', providerEventId: eventId, type: body.event };
  }

  async refund(
    providerPaymentId: string,
    amountPaise: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.client.payments.refund(providerPaymentId, {
      amount: amountPaise,
      notes: {
        reason: 'order cancelled before the payment completed',
        key: idempotencyKey,
      },
    });
  }
}
