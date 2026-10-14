import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Env } from '@app/common';
import { PaymentEvents, type PaymentFailedV1 } from '@app/events';
import { OutboxService } from '@app/kafka';
import { payments } from '../metrics';
import { Payment } from './payment.entity';
import { assertTransition, PaymentStatus } from './payment-status';
import { RefundService } from './refund.service';

const BATCH = 50;

/**
 * The timeout job: PENDING past expires_at → EXPIRED (+ payment.failed),
 * then retries pending refunds.
 *
 * Every pod runs it. FOR UPDATE SKIP LOCKED gives each row to exactly one
 * pod, so there is no leader to elect, and if a pod dies the others go on.
 *
 * Webhook vs sweeper on the same payment: both lock the row first, so one
 * waits for the other and then sees the NEW status.
 *   webhook first → SUCCEEDED; the sweeper skips the row, then it's no
 *                   longer PENDING.
 *   sweeper first → EXPIRED; the webhook sees a late success → refund.
 */
@Injectable()
export class PaymentSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly ds: DataSource,
    private readonly outbox: OutboxService,
    private readonly refunds: RefundService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.get('PAYMENT_SWEEPER_ENABLED', { infer: true })) return;
    const every = this.config.get('PAYMENT_SWEEP_MS', { infer: true });
    this.timer = setInterval(() => void this.tick(), every);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * setInterval doesn't wait for async work, so a slow run could overlap
   * the next. `running` stops that inside one pod; SKIP LOCKED across pods.
   */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.expireDue();
      const refunded = await this.refunds.processPending();
      if (expired || refunded) {
        this.logger.log(`Sweep: expired ${expired}, refunded ${refunded}`);
      }
    } catch (err) {
      this.logger.error(`Sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async expireDue(): Promise<number> {
    const n = await this.ds.transaction(async (m) => {
      const repo = m.getRepository(Payment);
      const due = await repo
        .createQueryBuilder('p')
        .where('p.status = :s', { s: PaymentStatus.PENDING })
        .andWhere('p.expiresAt < now()')
        .orderBy('p.expiresAt', 'ASC')
        .limit(BATCH)
        .setLock('pessimistic_write')
        // A row a webhook holds RIGHT NOW is skipped, not waited on.
        .setOnLocked('skip_locked')
        .getMany();

      for (const p of due) {
        assertTransition(p.status, PaymentStatus.EXPIRED);
        p.status = PaymentStatus.EXPIRED;
        await repo.save(p);
        await this.outbox.add<PaymentFailedV1>(m, {
          aggregateType: 'order',
          aggregateId: p.orderId,
          eventType: PaymentEvents.FAILED,
          data: {
            paymentId: p.id,
            orderId: p.orderId,
            userId: p.userId,
            reason: p.lastError || 'PAYMENT_TIMEOUT',
          },
        });
      }
      return due.length;
    });
    if (n) payments.inc({ outcome: 'expired' }, n); // after the commit
    return n;
  }
}
