import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  type OrderCancelledV1,
  type OrderDeliveredV1,
  OrderEvents,
  type OrderShippedV1,
} from '@app/events';
import { OutboxService } from '@app/kafka';
import { orderTransitions } from '../metrics';
import type { ShipOrderDto } from './dto/ship-order.dto';
import { OrderItem } from './order-item.entity';
import { Order } from './order.entity';

export type CancelReason = 'USER_CANCELLED' | 'ADMIN_CANCELLED';

/**
 * Phase 2: the moves people make (the saga makes the others).
 *   customer: cancel (PENDING / CONFIRMED / PAID)
 *   admin:    ship (PAID), deliver (SHIPPED), cancel (like the customer)
 *
 * Same shape as the expiry job: lock the row, let the state machine allow or
 * refuse the move (409 INVALID_ORDER_TRANSITION), save, and write the event
 * to the outbox in the SAME transaction. The saga does the rest of a cancel:
 * inventory puts the stock back, payment refunds a paid order, notification
 * emails the customer.
 *
 * The row lock also orders us against the saga consumer: if the payment
 * lands first the order is PAID when we cancel (→ refund); if we cancel
 * first, the saga's "pay" is refused and payment refunds the late money.
 */
@Injectable()
export class OrderActionsService {
  constructor(
    private readonly ds: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /** `userId` set = the customer's own order only (someone else's is a 404). */
  cancel(orderId: string, reason: CancelReason, userId?: string) {
    return this.change(orderId, userId, async (m, order) => {
      order.apply('cancel');
      order.failureReason = reason;
      await this.outbox.add<OrderCancelledV1>(m, {
        aggregateType: 'order',
        aggregateId: order.id,
        eventType: OrderEvents.CANCELLED,
        data: { orderId: order.id, userId: order.userId, reason },
      });
      return { to: 'CANCELLED', reason };
    });
  }

  ship(orderId: string, dto: ShipOrderDto) {
    return this.change(orderId, undefined, async (m, order) => {
      order.apply('ship');
      order.carrier = dto.carrier ?? null;
      order.trackingNumber = dto.trackingNumber ?? null;
      await this.outbox.add<OrderShippedV1>(m, {
        aggregateType: 'order',
        aggregateId: order.id,
        eventType: OrderEvents.SHIPPED,
        data: {
          orderId: order.id,
          userId: order.userId,
          carrier: order.carrier,
          trackingNumber: order.trackingNumber,
        },
      });
      return { to: 'SHIPPED', reason: 'ADMIN' };
    });
  }

  deliver(orderId: string) {
    return this.change(orderId, undefined, async (m, order) => {
      order.apply('deliver');
      await this.outbox.add<OrderDeliveredV1>(m, {
        aggregateType: 'order',
        aggregateId: order.id,
        eventType: OrderEvents.DELIVERED,
        data: { orderId: order.id, userId: order.userId },
      });
      return { to: 'DELIVERED', reason: 'ADMIN' };
    });
  }

  private async change(
    orderId: string,
    userId: string | undefined,
    move: (
      m: EntityManager,
      order: Order,
    ) => Promise<{ to: string; reason: string }>,
  ): Promise<Order> {
    let metric!: { to: string; reason: string };
    const saved = await this.ds.transaction(async (m) => {
      const repo = m.getRepository(Order);
      const order = await repo.findOne({
        where: userId ? { id: orderId, userId } : { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) {
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'Order not found',
        });
      }
      metric = await move(m, order);
      return repo.save(order);
    });
    orderTransitions.inc(metric); // after the commit
    // With its items, for the response (the lock query didn't load them).
    saved.items = await this.ds
      .getRepository(OrderItem)
      .findBy({ orderId: saved.id });
    return saved;
  }
}
