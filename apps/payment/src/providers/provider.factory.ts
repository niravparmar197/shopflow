import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/common';
import { FakePaymentProvider } from './fake.provider';
import {
  type PaymentProvider,
  PROVIDER_NAMES,
  type ProviderName,
} from './payment-provider';
import { RazorpayAdapter } from './razorpay.adapter';
import { StripeAdapter } from './stripe.adapter';

type SecretKey =
  | 'RAZORPAY_KEY_ID'
  | 'RAZORPAY_KEY_SECRET'
  | 'RAZORPAY_WEBHOOK_SECRET'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_PUBLISHABLE_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'FAKE_WEBHOOK_SECRET';

/**
 * FACTORY: the one place that knows how to build each provider. Everything
 * else only sees the PaymentProvider interface (Strategy).
 *
 * Lazy: a provider is built, and its keys checked, the first time it's
 * needed. The service starts without Stripe keys if nobody pays by Stripe.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly cache = new Map<ProviderName, PaymentProvider>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** The provider for new checkouts. */
  default(): PaymentProvider {
    return this.get(this.config.get('PAYMENT_PROVIDER', { infer: true }));
  }

  /** A provider by name: webhooks and refunds use the payment's own one. */
  get(name: string): PaymentProvider {
    if (!isProviderName(name)) {
      throw new BadRequestException({
        code: 'UNKNOWN_PROVIDER',
        message: `Unknown payment provider ${name}`,
      });
    }
    let provider = this.cache.get(name);
    if (!provider) {
      provider = this.create(name);
      this.cache.set(name, provider);
    }
    return provider;
  }

  private create(name: ProviderName): PaymentProvider {
    switch (name) {
      case 'razorpay':
        return new RazorpayAdapter({
          keyId: this.required('RAZORPAY_KEY_ID'),
          keySecret: this.required('RAZORPAY_KEY_SECRET'),
          webhookSecret: this.required('RAZORPAY_WEBHOOK_SECRET'),
        });
      case 'stripe':
        return new StripeAdapter({
          secretKey: this.required('STRIPE_SECRET_KEY'),
          publishableKey: this.required('STRIPE_PUBLISHABLE_KEY'),
          webhookSecret: this.required('STRIPE_WEBHOOK_SECRET'),
        });
      case 'fake':
        // Anyone who knows its secret could mark orders as paid.
        if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
          throw new Error(
            'The fake payment provider is not allowed in production',
          );
        }
        return new FakePaymentProvider(this.required('FAKE_WEBHOOK_SECRET'));
    }
  }

  private required(key: SecretKey): string {
    const value = this.config.get(key, { infer: true });
    if (!value) throw new Error(`${key} is not set`);
    return value;
  }
}

const isProviderName = (name: string): name is ProviderName =>
  (PROVIDER_NAMES as readonly string[]).includes(name);
