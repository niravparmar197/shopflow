import { Injectable } from '@nestjs/common';
import {
  type EventEnvelope,
  type OrderCancelledV1,
  OrderEvents,
  type OrderFailedV1,
  type OrderShippedV1,
  PaymentEvents,
  type PaymentRefundedV1,
} from '@app/events';
import type { OrderView } from '../projection/order-view.schema';
import type { NotificationCommand } from './notification-command';
import { type EmailTemplate, SendEmailCommand } from './send-email.command';

const rupees = (paise: number) => (paise / 100).toFixed(2);
const shortId = (id: string) => id.slice(0, 8).toUpperCase();

/** Event → zero or more commands. SMS later = one more command here. */
@Injectable()
export class NotificationPlanner {
  commandsFor(e: EventEnvelope, view: OrderView): NotificationCommand[] {
    const to = view.email;
    if (!to) return []; // orders placed before the email snapshot
    const base = {
      orderNo: shortId(view._id),
      total: rupees(view.totalPaise),
      currency: view.currency,
    };
    const email = (
      template: EmailTemplate,
      vars: Record<string, string | number>,
    ) => [
      new SendEmailCommand(
        e.eventId,
        { orderId: view._id },
        { to, template, vars },
      ),
    ];

    switch (e.type) {
      case OrderEvents.PAID:
        return email('order-paid', base);
      case OrderEvents.CANCELLED:
        return email('order-cancelled', {
          ...base,
          reason: (e.data as OrderCancelledV1).reason,
        });
      case OrderEvents.FAILED:
        return email('order-failed', {
          ...base,
          reason: (e.data as OrderFailedV1).reason,
        });
      case OrderEvents.SHIPPED: {
        const d = e.data as OrderShippedV1;
        return email('order-shipped', {
          ...base,
          carrier: d.carrier ?? '',
          trackingNumber: d.trackingNumber ?? '',
        });
      }
      case OrderEvents.DELIVERED:
        return email('order-delivered', base);
      case PaymentEvents.REFUNDED:
        return email('payment-refunded', {
          ...base,
          amount: rupees((e.data as PaymentRefundedV1).amountPaise),
        });
      default:
        return [];
    }
  }
}
