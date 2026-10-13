import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { type Env, REDIS } from '@app/common';
import { type OrderCancelledV1, OrderEvents } from '@app/events';
import { OutboxService } from '@app/kafka';
import { type JobContext, LeaderJob } from '@app/scheduler';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order-status';

const BATCH = 100;

export interface ExpiryRule {
  status: OrderStatus.PENDING | OrderStatus.CONFIRMED;
  column: 'createdAt' | 'confirmedAt';
  minutes: number;
  reason: 'STOCK_TIMEOUT' | 'PAYMENT_TIMEOUT';
}

/*
 * Cancels orders that got stuck:
 *   PENDING   > 10 min since created   → STOCK_TIMEOUT   (inventory down, DLQ)
 *   CONFIRMED > 30 min since confirmed → PAYMENT_TIMEOUT (backstop: payment
 *                                         normally expires it at 15 min)
 * It makes ONE decision (order.cancelled); the saga does the rest: inventory
 * releases the stock, payment closes or refunds, notification emails.
 *
 * Race with the saga consumer: both lock the order row.
 *   consumer first → CONFIRMED / PAID; we skip it (SKIP LOCKED) and look again
 *                    next run, against the new clock
 *   job first      → CANCELLED; the consumer's move is refused by the state
 *                    machine and ignored
 */
@Injectable()
export class OrderExpiryJob extends LeaderJob {
  protected readonly name = 'order-expiry';
  protected readonly cronEnvKey = 'ORDER_EXPIRY_CRON' as const;
  protected readonly defaultCron = '0 * * * * *'; // every minute at :00
  readonly rules: readonly ExpiryRule[];

  constructor(
    @Inject(REDIS) redis: Redis,
    scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
    private readonly ds: DataSource,
    private readonly outbox: OutboxService,
  ) {
    super(redis, scheduler, config);
    this.rules = [
      {
        status: OrderStatus.PENDING,
        column: 'createdAt',
        minutes: config.get('ORDER_PENDING_TIMEOUT_MIN', { infer: true }),
        reason: 'STOCK_TIMEOUT',
      },
      {
        status: OrderStatus.CONFIRMED,
        column: 'confirmedAt',
        minutes: config.get('ORDER_CONFIRMED_TIMEOUT_MIN', { infer: true }),
        reason: 'PAYMENT_TIMEOUT',
      },
    ];
  }

  protected async run(ctx: JobContext): Promise<number> {
    let total = 0;
    for (const rule of this.rules) {
      while (!ctx.lost) {
        const n = await this.expireBatch(rule);
        total += n;
        if (n < BATCH) break; // nothing more for this rule
      }
    }
    return total;
  }

  /** One batch in one short transaction. Public for tests. */
  async expireBatch(rule: ExpiryRule): Promise<number> {
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(Order);
      const due = await repo
        .createQueryBuilder('o')
        .where('o.status = :status', { status: rule.status })
        .andWhere(`o.${rule.column} < now() - make_interval(mins => :mins)`, {
          mins: rule.minutes,
        })
        .orderBy(`o.${rule.column}`, 'ASC')
        .limit(BATCH)
        // FENCING in the DB: even if two pods ran this at once (the Redis
        // lock was lost), each row is locked by ONE of them; the other
        // skips it. A row a saga consumer holds right now is skipped too.
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      for (const order of due) {
        order.apply('cancel'); // State pattern: PENDING/CONFIRMED → CANCELLED
        order.failureReason = rule.reason;
        await repo.save(order);
        await this.outbox.add<OrderCancelledV1>(m, {
          aggregateType: 'order',
          aggregateId: order.id,
          eventType: OrderEvents.CANCELLED,
          data: {
            orderId: order.id,
            userId: order.userId,
            reason: rule.reason,
          },
        });
      }
      if (due.length) {
        this.logger.warn(
          `Expired ${due.length} ${rule.status} order(s) → CANCELLED (${rule.reason})`,
        );
      }
      return due.length;
    });
  }
}
