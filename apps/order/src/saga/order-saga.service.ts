import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  type OrderConfirmedV1,
  OrderEvents,
  type OrderFailedV1,
  type StockFailedV1,
  type StockReservedV1,
} from '@app/events';
import { OutboxService, PoisonMessageError } from '@app/kafka';
import { Order } from '../orders/order.entity';
import type { OrderAction } from '../orders/order-status';

/**
 * The order's side of the saga (choreography: each service reacts to the
 * others' events; nobody coordinates). Runs inside the consumer's
 * transaction.
 */
@Injectable()
export class OrderSagaService {
  private readonly logger = new Logger(OrderSagaService.name);

  constructor(private readonly outbox: OutboxService) {}

  async onStockReserved(
    m: EntityManager,
    data: StockReservedV1,
    correlationId?: string,
  ) {
    const order = await this.lockOrder(m, data.orderId);
    if (!this.tryApply(order, 'confirm')) return;

    await m.getRepository(Order).save(order);
    await this.outbox.add<OrderConfirmedV1>(m, {
      aggregateType: 'order',
      aggregateId: order.id,
      eventType: OrderEvents.CONFIRMED,
      correlationId,
      data: {
        orderId: order.id,
        userId: order.userId,
        totalPaise: order.totalPaise,
        currency: order.currency,
      },
    });
    this.logger.log(`Order ${order.id} → CONFIRMED`);
  }

  async onStockFailed(
    m: EntityManager,
    data: StockFailedV1,
    correlationId?: string,
  ) {
    const order = await this.lockOrder(m, data.orderId);
    if (!this.tryApply(order, 'fail')) return;

    order.failureReason = data.reason;
    await m.getRepository(Order).save(order);
    await this.outbox.add<OrderFailedV1>(m, {
      aggregateType: 'order',
      aggregateId: order.id,
      eventType: OrderEvents.FAILED,
      correlationId,
      data: { orderId: order.id, userId: order.userId, reason: data.reason },
    });
    this.logger.warn(`Order ${order.id} → FAILED (${data.reason})`);
  }

  // Row lock: other writers (the expiry job in F8) may change the same order
  // at the same moment.
  private async lockOrder(m: EntityManager, id: string): Promise<Order> {
    const order = await m
      .getRepository(Order)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    // The order commits before its event is even written to the outbox, so
    // "not found" means bad data, not "too early": retrying won't help.
    if (!order) throw new PoisonMessageError(`Order ${id} not found`);
    return order;
  }

  /**
   * An impossible move means a late or out-of-order event (say the order
   * was already cancelled). Throwing would only retry it into the DLQ, so
   * log it and move on.
   * Known gap (F8): stock.reserved for an already-cancelled order leaves the
   * stock held until the expiry job releases it.
   */
  private tryApply(order: Order, action: OrderAction): boolean {
    try {
      order.apply(action);
      return true;
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
      this.logger.warn(
        `Order ${order.id}: cannot ${action} from ${order.status}, event ignored`,
      );
      return false;
    }
  }
}
