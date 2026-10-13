import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  CircuitOpenError,
  isRetryable,
  ResilienceRegistry,
} from '@app/resilience';
import type { CheckoutSession } from '../providers/payment-provider';
import { PaymentProviderFactory } from '../providers/provider.factory';
import { Payment } from './payment.entity';
import { PaymentStatus } from './payment-status';

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly providers: PaymentProviderFactory,
    private readonly resilience: ResilienceRegistry,
  ) {}

  /**
   * Opens (or reopens) the provider's checkout for one of your orders.
   * Clicking "Pay" again returns the same provider order.
   */
  async checkout(userId: string, orderId: string): Promise<CheckoutSession> {
    // 1. Load and check. The owner filter stops IDOR.
    const p = await this.payments.findOneBy({ orderId, userId });
    if (!p) {
      throw new NotFoundException({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }
    if (p.status !== PaymentStatus.PENDING) {
      throw new ConflictException({
        code: 'PAYMENT_NOT_PAYABLE',
        message: `Payment is ${p.status}`,
        details: { status: p.status },
      });
    }
    if (p.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException({
        code: 'PAYMENT_EXPIRED',
        message: 'Payment time is over',
      });
    }

    // 2. Already has a provider order → reuse it, with the SAME provider.
    if (p.provider && p.providerOrderId) {
      return this.resume(p.provider, p.providerOrderId, p);
    }

    // 3. First time → create at the provider. Not inside a DB transaction:
    //    a slow network call must not hold a DB connection or a lock.
    const provider = this.providers.default();
    const session = await this.callProvider(provider.name, () =>
      provider.createCheckout({
        paymentId: p.id,
        orderId: p.orderId,
        amountPaise: p.amountPaise,
        currency: p.currency,
      }),
    );

    // 4. CONDITIONAL update: if two clicks raced, only the first save wins.
    const res = await this.payments.update(
      { id: p.id, providerOrderId: IsNull() },
      { provider: provider.name, providerOrderId: session.providerOrderId },
    );
    if (res.affected === 0) {
      // The other click won → return ITS session, so the user pays one
      // provider order. (Stripe: same PaymentIntent via the idempotency key.
      // Razorpay: our order is never paid and expires there.)
      const winner = await this.payments.findOneByOrFail({ id: p.id });
      this.logger.warn(
        `Checkout race on payment ${p.id}: reusing ${winner.providerOrderId}`,
      );
      return this.resume(winner.provider!, winner.providerOrderId!, winner);
    }

    this.logger.log(
      `Checkout created: payment ${p.id} → ${provider.name} ${session.providerOrderId}`,
    );
    return session;
  }

  private resume(providerName: string, providerOrderId: string, p: Payment) {
    const provider = this.providers.get(providerName);
    return this.callProvider(provider.name, () =>
      provider.resumeCheckout(providerOrderId, p.amountPaise, p.currency),
    );
  }

  /** Every provider call goes through retry + circuit breaker + timeout. */
  private async callProvider<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.resilience.for(`payment-provider:${name}`).execute(fn);
    } catch (err) {
      if (err instanceof CircuitOpenError || isRetryable(err)) {
        throw new ServiceUnavailableException({
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          message:
            'Payment provider is not responding. Please try again in a minute.',
          details: { retryAfterSec: 30 },
        });
      }
      this.logger.error(
        `Provider ${name} rejected the request: ${(err as Error).message}`,
      );
      throw new BadGatewayException({
        code: 'PAYMENT_PROVIDER_ERROR',
        message: 'Payment provider rejected the request',
      });
    }
  }
}
