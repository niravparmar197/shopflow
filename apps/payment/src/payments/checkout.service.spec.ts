import {
  BadGatewayException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import { ResilienceRegistry } from '@app/resilience';
import { FakePaymentProvider } from '../providers/fake.provider';
import type { PaymentProviderFactory } from '../providers/provider.factory';
import { CheckoutService } from './checkout.service';
import type { Payment } from './payment.entity';
import { PaymentStatus } from './payment-status';

const pending = (over: Partial<Payment> = {}): Payment =>
  ({
    id: 'pay-1',
    orderId: 'ord-1',
    userId: 'user-1',
    amountPaise: 49_900,
    currency: 'INR',
    status: PaymentStatus.PENDING,
    provider: null,
    providerOrderId: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  }) as Payment;

describe('CheckoutService', () => {
  let fake: FakePaymentProvider;
  let repo: {
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
  };
  let registry: ResilienceRegistry;
  let svc: CheckoutService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  beforeEach(() => {
    fake = new FakePaymentProvider('secret');
    fake.slowMs = 300;
    repo = {
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    registry = new ResilienceRegistry();
    // Short timings for tests; the registry keeps the first options given.
    registry.for('payment-provider:fake', {
      timeoutMs: 50,
      minDelayMs: 1,
      maxDelayMs: 5,
      volumeThreshold: 3,
    });
    const factory = {
      default: () => fake,
      get: () => fake,
    } as unknown as PaymentProviderFactory;
    svc = new CheckoutService(
      repo as unknown as Repository<Payment>,
      factory,
      registry,
    );
  });
  afterEach(() => registry.onApplicationShutdown());

  it('creates a provider order the first time and saves it conditionally', async () => {
    repo.findOneBy.mockResolvedValue(pending());
    const s = await svc.checkout('user-1', 'ord-1');
    expect(s.providerOrderId).toBe('fake_pay-1');
    expect(repo.findOneBy).toHaveBeenCalledWith({
      orderId: 'ord-1',
      userId: 'user-1',
    });
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pay-1' }),
      { provider: 'fake', providerOrderId: 'fake_pay-1' },
    );
  });

  it('resumes an existing provider order instead of creating one', async () => {
    repo.findOneBy.mockResolvedValue(
      pending({ provider: 'fake', providerOrderId: 'fake_old' }),
    );
    const create = jest.spyOn(fake, 'createCheckout');
    const s = await svc.checkout('user-1', 'ord-1');
    expect(s.providerOrderId).toBe('fake_old');
    expect(create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('a lost double-click race returns the winner’s provider order', async () => {
    repo.findOneBy.mockResolvedValue(pending());
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOneByOrFail.mockResolvedValue(
      pending({ provider: 'fake', providerOrderId: 'fake_winner' }),
    );
    const s = await svc.checkout('user-1', 'ord-1');
    expect(s.providerOrderId).toBe('fake_winner');
  });

  it('404 for a payment that is not yours (or does not exist)', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await expect(svc.checkout('user-2', 'ord-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409 PAYMENT_NOT_PAYABLE when not pending', async () => {
    repo.findOneBy.mockResolvedValue(
      pending({ status: PaymentStatus.SUCCEEDED }),
    );
    await expect(svc.checkout('user-1', 'ord-1')).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_PAYABLE' },
    });
  });

  it('409 PAYMENT_EXPIRED when the time is over', async () => {
    repo.findOneBy.mockResolvedValue(
      pending({ expiresAt: new Date(Date.now() - 1) }),
    );
    const result = svc.checkout('user-1', 'ord-1');
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'PAYMENT_EXPIRED' },
    });
  });

  it('flaky provider: retries win, the user never notices', async () => {
    fake.mode = 'flaky';
    repo.findOneBy.mockResolvedValue(pending());
    await expect(svc.checkout('user-1', 'ord-1')).resolves.toMatchObject({
      providerOrderId: 'fake_pay-1',
    });
  });

  it('slow provider: 503 PAYMENT_PROVIDER_UNAVAILABLE after the timeouts', async () => {
    fake.mode = 'slow';
    repo.findOneBy.mockResolvedValue(pending());
    const result = svc.checkout('user-1', 'ord-1');
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
    });
  });

  it('down provider: circuit opens and later calls fail fast with 503', async () => {
    fake.mode = 'fail';
    repo.findOneBy.mockResolvedValue(pending());
    await svc.checkout('user-1', 'ord-1').catch(() => undefined);
    expect(registry.states()).toEqual({ 'payment-provider:fake': 'OPEN' });

    const create = jest.spyOn(fake, 'createCheckout');
    await expect(svc.checkout('user-1', 'ord-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('a 4xx from the provider is a 502, not retried', async () => {
    repo.findOneBy.mockResolvedValue(pending());
    const create = jest
      .spyOn(fake, 'createCheckout')
      .mockRejectedValue(
        Object.assign(new Error('bad amount'), { statusCode: 400 }),
      );
    await expect(svc.checkout('user-1', 'ord-1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});
