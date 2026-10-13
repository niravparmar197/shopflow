// STRATEGY: the one interface the rest of the payment service sees. Each
// provider (Razorpay, Stripe, Fake) is an interchangeable implementation.

export type ProviderName = 'razorpay' | 'stripe' | 'fake';
export const PROVIDER_NAMES: readonly ProviderName[] = [
  'razorpay',
  'stripe',
  'fake',
];

export interface CreateCheckoutInput {
  paymentId: string; // also our idempotency key at the provider
  orderId: string;
  amountPaise: number;
  currency: string;
}

/** What the frontend needs to open the provider's checkout. */
export interface CheckoutSession {
  provider: ProviderName;
  providerOrderId: string; // Razorpay order id / Stripe PaymentIntent id
  publicKey?: string; // Razorpay key_id / Stripe publishable key
  clientSecret?: string; // Stripe only
  amountPaise: number;
  currency: string;
}

/**
 * Any provider's webhook, in our own shape. A failed attempt is not final:
 * the user can retry in the same checkout. Only expiry fails a payment.
 */
export type WebhookResult =
  | {
      kind: 'SUCCEEDED';
      providerEventId: string;
      providerOrderId: string;
      providerPaymentId: string;
    }
  | {
      kind: 'ATTEMPT_FAILED';
      providerEventId: string;
      providerOrderId: string;
      reason: string;
    }
  | { kind: 'IGNORED'; providerEventId: string; type: string };

export type WebhookHeaders = Record<string, string | undefined>;

export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  /** Rebuilds the session for an existing provider order (creates nothing). */
  resumeCheckout(
    providerOrderId: string,
    amountPaise: number,
    currency: string,
  ): Promise<CheckoutSession>;
  /** Throws InvalidSignatureError if the signature is wrong. */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookResult;
  refund(
    providerPaymentId: string,
    amountPaise: number,
    idempotencyKey: string,
  ): Promise<void>;
}
