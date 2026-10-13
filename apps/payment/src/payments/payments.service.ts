import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { Env } from '@app/common';
import {
  type OrderCancelledV1,
  type OrderConfirmedV1,
  PaymentEvents,
  type PaymentSucceededV1,
} from '@app/events';
import { OutboxService } from '@app/kafka';
import { Payment } from './payment.entity';
import { assertTransition, PaymentStatus } from './payment-status';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly ttlMinutes: number;

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly outbox: OutboxService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMinutes = config.get('PAYMENT_TTL_MINUTES', { infer: true });
  }

  /**
   * order.confirmed → a payment waiting for the user. Runs inside the
   * consumer's transaction.
   */
  async createForOrder(
    m: EntityManager,
    o: OrderConfirmedV1,
    correlationId?: string,
  ) {
    const free = o.totalPaise === 0; // e.g. a 100% coupon: nothing to charge
    // ON CONFLICT: the second guard after processed_events.
    const rows = await m.query<{ id: string }[]>(
      `INSERT INTO payments (order_id, user_id, amount_paise, currency, status, expires_at, version)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int), 1)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [
        o.orderId,
        o.userId,
        o.totalPaise,
        o.currency,
        free ? PaymentStatus.SUCCEEDED : PaymentStatus.PENDING,
        this.ttlMinutes,
      ],
    );
    if (rows.length === 0) {
      this.logger.warn(`Payment for order ${o.orderId} already exists`);
      return;
    }
    const paymentId = rows[0].id;

    if (free) {
      await this.outbox.add<PaymentSucceededV1>(m, {
        aggregateType: 'order',
        aggregateId: o.orderId, // key = orderId: in order with the order's events
        eventType: PaymentEvents.SUCCEEDED,
        correlationId,
        data: {
          paymentId,
          orderId: o.orderId,
          userId: o.userId,
          amountPaise: 0,
          provider: 'none',
        },
      });
    }
    this.logger.log(
      `Payment ${paymentId} for order ${o.orderId}: ${free ? 'free, SUCCEEDED' : 'PENDING'}`,
    );
  }

  /**
   * order.cancelled → stop taking money, or give it back. Runs inside the
   * consumer's transaction; the row lock orders it against webhooks and
   * the sweeper.
   */
  async onOrderCancelled(m: EntityManager, o: OrderCancelledV1) {
    const repo = m.getRepository(Payment);
    const p = await repo.findOne({
      where: { orderId: o.orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!p) return; // cancelled before a payment existed

    switch (p.status) {
      case PaymentStatus.PENDING:
        // No more money for this order. A success webhook after this is a
        // late success → refund (WebhookService).
        assertTransition(p.status, PaymentStatus.EXPIRED);
        p.status = PaymentStatus.EXPIRED;
        p.lastError = `ORDER_CANCELLED:${o.reason}`.slice(0, 300);
        await repo.save(p);
        this.logger.log(
          `Order ${o.orderId} cancelled → payment ${p.id} EXPIRED`,
        );
        return;

      case PaymentStatus.SUCCEEDED:
        // Paid, but the order was cancelled anyway (e.g. the F8 auto-cancel
        // won the race) → refund. The sweeper's refund pass picks it up.
        assertTransition(p.status, PaymentStatus.REFUND_PENDING);
        p.status = PaymentStatus.REFUND_PENDING;
        await repo.save(p);
        this.logger.warn(
          `Order ${o.orderId} cancelled after payment → refund queued`,
        );
        return;

      default:
        return; // EXPIRED / REFUND_PENDING / REFUNDED: nothing to do
    }
  }

  async findMine(userId: string, orderId: string) {
    // Filtered by owner: someone else's order is a 404, not a 403 (no IDOR,
    // and it doesn't reveal that the order exists).
    const p = await this.payments.findOneBy({ orderId, userId });
    if (!p) {
      throw new NotFoundException({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }
    return {
      paymentId: p.id,
      orderId: p.orderId,
      status: p.status,
      amountPaise: p.amountPaise,
      currency: p.currency,
      provider: p.provider,
      lastError: p.lastError,
      expiresAt: p.expiresAt,
    };
  }
}
