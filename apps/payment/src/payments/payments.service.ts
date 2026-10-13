import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { Env } from '@app/common';
import {
  type OrderConfirmedV1,
  PaymentEvents,
  type PaymentSucceededV1,
} from '@app/events';
import { OutboxService } from '@app/kafka';
import { Payment } from './payment.entity';
import { PaymentStatus } from './payment-status';

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
