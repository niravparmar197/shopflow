import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  type EventEnvelope,
  type OrderCancelledV1,
  type OrderConfirmedV1,
  type OrderCreatedV1,
  OrderEvents,
  type OrderFailedV1,
  type OrderPaidV1,
  PaymentEvents,
  type PaymentFailedV1,
  type PaymentRefundedV1,
  type PaymentSucceededV1,
} from '@app/events';

const RANK: Record<string, number> = {
  PENDING: 1,
  CONFIRMED: 2,
  PAID: 3,
  FAILED: 3,
  CANCELLED: 3,
};

/**
 * Events → order_views. Three rules make it safe:
 *  1. Idempotent: BaseConsumer's processed_events skips duplicates, so a
 *     step never lands in the timeline twice.
 *  2. Order-independent: every event UPSERTS. A payment.succeeded that
 *     arrives before order.created makes a placeholder row; order.created
 *     fills it in later. Nothing to retry, nothing for the DLQ.
 *  3. Monotonic: the status only moves forward (status_rank), and a
 *     refund is the payment's last word.
 * Every parameter has an explicit ::type: Postgres refuses a parameter
 * used as two different types (varchar column vs ::text in the JSON).
 */
@Injectable()
export class OrderViewProjector {
  async apply(m: EntityManager, e: EventEnvelope) {
    const at = e.occurredAt;
    switch (e.type) {
      case OrderEvents.CREATED:
        return this.created(m, at, e.data as OrderCreatedV1);
      case OrderEvents.CONFIRMED: {
        const d = e.data as OrderConfirmedV1;
        return this.status(m, at, d.orderId, d.userId, 'CONFIRMED');
      }
      case OrderEvents.PAID: {
        const d = e.data as OrderPaidV1;
        return this.status(m, at, d.orderId, d.userId, 'PAID');
      }
      case OrderEvents.FAILED: {
        const d = e.data as OrderFailedV1;
        return this.status(m, at, d.orderId, d.userId, 'FAILED', d.reason);
      }
      case OrderEvents.CANCELLED: {
        const d = e.data as OrderCancelledV1;
        return this.status(m, at, d.orderId, d.userId, 'CANCELLED', d.reason);
      }
      case PaymentEvents.SUCCEEDED: {
        const d = e.data as PaymentSucceededV1;
        return this.payment(m, at, d, 'SUCCEEDED', 'PAYMENT_RECEIVED');
      }
      case PaymentEvents.FAILED: {
        // The order's own order.failed/cancelled carries the step.
        const d = e.data as PaymentFailedV1;
        return this.payment(m, at, d, 'EXPIRED', null);
      }
      case PaymentEvents.REFUNDED: {
        const d = e.data as PaymentRefundedV1;
        return this.payment(m, at, d, 'REFUNDED', 'REFUNDED');
      }
    }
  }

  private async created(m: EntityManager, at: string, o: OrderCreatedV1) {
    const names = o.items.map((i) => i.name).filter((n): n is string => !!n);
    const title =
      names.length === 0
        ? null
        : names.length === 1
          ? names[0]
          : `${names[0]} + ${names.length - 1} more`;
    const itemCount = o.items.reduce((n, i) => n + i.quantity, 0);

    // A placeholder from an earlier-arriving event gets the details filled in.
    await m.query(
      `INSERT INTO order_views (order_id, user_id, status, status_rank, total_paise, currency,
                                item_count, title, placed_at, timeline)
       VALUES ($1::uuid, $2::uuid, 'PENDING', 1, $3::int, $4::varchar, $5::int, $6::varchar,
               $7::timestamptz, jsonb_build_array(jsonb_build_object('step', 'PLACED', 'at', $8::text)))
       ON CONFLICT (order_id) DO UPDATE SET
         user_id     = EXCLUDED.user_id,
         total_paise = EXCLUDED.total_paise,
         currency    = EXCLUDED.currency,
         item_count  = EXCLUDED.item_count,
         title       = EXCLUDED.title,
         placed_at   = EXCLUDED.placed_at,
         status      = CASE WHEN EXCLUDED.status_rank > order_views.status_rank
                            THEN EXCLUDED.status ELSE order_views.status END,
         status_rank = GREATEST(order_views.status_rank, EXCLUDED.status_rank),
         timeline    = order_views.timeline || EXCLUDED.timeline,
         updated_at  = now()`,
      [o.orderId, o.userId, o.totalPaise, o.currency, itemCount, title, at, at],
    );
  }

  private async status(
    m: EntityManager,
    at: string,
    orderId: string,
    userId: string,
    status: keyof typeof RANK,
    reason: string | null = null,
  ) {
    await m.query(
      `INSERT INTO order_views (order_id, user_id, status, status_rank, failure_reason, timeline)
       VALUES ($1::uuid, $2::uuid, $3::varchar, $4::int, $5::varchar,
               jsonb_build_array(jsonb_build_object('step', $3::text, 'at', $6::text, 'reason', $5::text)))
       ON CONFLICT (order_id) DO UPDATE SET
         status         = CASE WHEN EXCLUDED.status_rank >= order_views.status_rank
                               THEN EXCLUDED.status ELSE order_views.status END,
         status_rank    = GREATEST(order_views.status_rank, EXCLUDED.status_rank),
         failure_reason = COALESCE(EXCLUDED.failure_reason, order_views.failure_reason),
         timeline       = order_views.timeline || EXCLUDED.timeline,
         updated_at     = now()`,
      [orderId, userId, status, RANK[status], reason, at],
    );
  }

  private async payment(
    m: EntityManager,
    at: string,
    d: { orderId: string; userId: string },
    paymentStatus: string,
    step: string | null,
  ) {
    // Rank 0 + no placed_at: a placeholder, hidden from the list until
    // order.created arrives.
    await m.query(
      `INSERT INTO order_views (order_id, user_id, status, status_rank, payment_status, timeline)
       VALUES ($1::uuid, $2::uuid, 'PENDING', 0, $3::varchar,
               CASE WHEN $4::text IS NULL THEN '[]'::jsonb
                    ELSE jsonb_build_array(jsonb_build_object('step', $4::text, 'at', $5::text)) END)
       ON CONFLICT (order_id) DO UPDATE SET
         payment_status = CASE WHEN order_views.payment_status = 'REFUNDED'
                               THEN order_views.payment_status ELSE EXCLUDED.payment_status END,
         timeline       = order_views.timeline || EXCLUDED.timeline,
         updated_at     = now()`,
      [d.orderId, d.userId, paymentStatus, step, at],
    );
  }
}
