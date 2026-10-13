import Stripe from 'stripe';
import { InvalidSignatureError } from './errors';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentProvider,
  WebhookHeaders,
  WebhookResult,
} from './payment-provider';

/** ADAPTER: Stripe's SDK and webhooks → our PaymentProvider shape. */
export class StripeAdapter implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly client: Stripe;

  constructor(
    private readonly opts: {
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
    },
  ) {
    this.client = new Stripe(opts.secretKey);
  }

  async createCheckout(i: CreateCheckoutInput): Promise<CheckoutSession> {
    const intent = await this.client.paymentIntents.create(
      {
        amount: i.amountPaise, // INR's smallest unit is the paisa
        currency: i.currency.toLowerCase(),
        metadata: { orderId: i.orderId, paymentId: i.paymentId },
        automatic_payment_methods: { enabled: true },
      },
      // A retried create returns the same PaymentIntent, not a second one.
      { idempotencyKey: `checkout-${i.paymentId}` },
    );
    return {
      provider: this.name,
      providerOrderId: intent.id,
      clientSecret: intent.client_secret ?? undefined,
      publicKey: this.opts.publishableKey,
      amountPaise: i.amountPaise,
      currency: i.currency,
    };
  }

  // We don't store the client_secret, so fetch it again.
  async resumeCheckout(
    providerOrderId: string,
    amountPaise: number,
    currency: string,
  ): Promise<CheckoutSession> {
    const intent = await this.client.paymentIntents.retrieve(providerOrderId);
    return {
      provider: this.name,
      providerOrderId,
      clientSecret: intent.client_secret ?? undefined,
      publicKey: this.opts.publishableKey,
      amountPaise,
      currency,
    };
  }

  parseWebhook(raw: Buffer, headers: WebhookHeaders): WebhookResult {
    let event: Stripe.Event;
    try {
      // Checks the HMAC and the timestamp (rejects replays older than 5 min).
      event = this.client.webhooks.constructEvent(
        raw,
        headers['stripe-signature'] ?? '',
        this.opts.webhookSecret,
      );
    } catch {
      throw new InvalidSignatureError();
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const charge = pi.latest_charge;
        return {
          kind: 'SUCCEEDED',
          providerEventId: event.id,
          providerOrderId: pi.id,
          // The charge is what gets refunded.
          providerPaymentId:
            (typeof charge === 'string' ? charge : charge?.id) ?? pi.id,
        };
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        return {
          kind: 'ATTEMPT_FAILED',
          providerEventId: event.id,
          providerOrderId: pi.id,
          reason: pi.last_payment_error?.message ?? 'PAYMENT_FAILED',
        };
      }
      default:
        return { kind: 'IGNORED', providerEventId: event.id, type: event.type };
    }
  }

  async refund(
    providerPaymentId: string,
    amountPaise: number,
    idempotencyKey: string,
  ): Promise<void> {
    await this.client.refunds.create(
      { charge: providerPaymentId, amount: amountPaise },
      { idempotencyKey: `refund-${idempotencyKey}` },
    );
  }
}
