import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentEvents, type PaymentRefundedV1 } from '@app/events';
import { OutboxService } from '@app/kafka';
import { ResilienceRegistry } from '@app/resilience';
import { PaymentProviderFactory } from '../providers/provider.factory';
import { Payment } from './payment.entity';
import { PaymentStatus } from './payment-status';

const LEASE = `interval '2 minutes'`;
const BATCH = 20;

/**
 * Refunds late successes: LEASE → call the provider → FINISH.
 *
 * Why a lease and not a row lock? The refund is a slow network call; holding
 * a lock (and a DB connection) through it would block other work. We mark
 * the row "mine for 2 minutes", commit, call the provider, then finish. The
 * provider idempotency key (the payment id) stops a double refund if two
 * pods ever overlap (e.g. a call that outlives its lease).
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly providers: PaymentProviderFactory,
    private readonly resilience: ResilienceRegistry,
    private readonly outbox: OutboxService,
  ) {}

  /** Refunds what is due; returns how many were refunded. */
  async processPending(): Promise<number> {
    // 1. CLAIM with a lease (short tx). SKIP LOCKED: another pod claiming
    //    right now gets different rows instead of waiting.
    const claimed = await this.ds.transaction(async (m) => {
      const rows = await m
        .getRepository(Payment)
        .createQueryBuilder('p')
        .where('p.status = :s', { s: PaymentStatus.REFUND_PENDING })
        .andWhere(
          `(p.refundAttemptedAt IS NULL OR p.refundAttemptedAt < now() - ${LEASE})`,
        )
        .orderBy('p.updatedAt', 'ASC')
        .limit(BATCH)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      if (rows.length) {
        await m
          .createQueryBuilder()
          .update(Payment)
          .set({ refundAttemptedAt: () => 'now()' })
          .whereInIds(rows.map((r) => r.id))
          .execute();
      }
      return rows;
    });

    // 2. CALL the provider outside any transaction.
    let done = 0;
    for (const p of claimed) {
      try {
        await this.refundOne(p);
        done++;
      } catch (err) {
        // The lease ends in 2 minutes; the next sweep tries again.
        this.logger.error(
          `Refund failed for payment ${p.id}, will retry: ${(err as Error).message}`,
        );
      }
    }
    return done;
  }

  private async refundOne(p: Payment) {
    if (!p.provider || !p.providerPaymentId) {
      throw new Error('payment has no provider payment id to refund');
    }
    const provider = this.providers.get(p.provider);
    await this.resilience
      .for(`payment-provider:${provider.name}`)
      .execute(() =>
        provider.refund(p.providerPaymentId!, p.amountPaise, p.id),
      );

    // 3. FINISH: conditional update + event in one transaction.
    await this.ds.transaction(async (m) => {
      const res = await m
        .createQueryBuilder()
        .update(Payment)
        .set({ status: PaymentStatus.REFUNDED })
        .where('id = :id AND status = :s', {
          id: p.id,
          s: PaymentStatus.REFUND_PENDING,
        })
        .execute();
      if (res.affected !== 1) return; // another pod finished it first
      await this.outbox.add<PaymentRefundedV1>(m, {
        aggregateType: 'order',
        aggregateId: p.orderId, // key = orderId: in order with the order's events
        eventType: PaymentEvents.REFUNDED,
        data: {
          paymentId: p.id,
          orderId: p.orderId,
          userId: p.userId,
          amountPaise: p.amountPaise,
        },
      });
    });
    this.logger.warn(`Refunded payment ${p.id} (${p.amountPaise} paise)`);
  }
}
