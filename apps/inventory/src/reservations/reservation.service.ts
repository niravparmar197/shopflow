import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  InventoryEvents,
  type OrderCreatedV1,
  type StockFailedV1,
  type StockReservedV1,
} from '@app/events';
import { OutboxService } from '@app/kafka';
import { Stock } from '../stock/stock.entity';
import { Reservation, ReservationStatus } from './reservation.entity';

const HOLD_MINUTES = 15; // F8 releases holds older than this

interface Line {
  productId: string;
  quantity: number;
}

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(private readonly outbox: OutboxService) {}

  /**
   * All or nothing: reserves every line of the order, or none and reports
   * stock.failed. Runs inside the consumer's transaction.
   */
  async reserveForOrder(
    m: EntityManager,
    order: OrderCreatedV1,
    correlationId?: string,
  ) {
    const lines = mergeAndSort(order.items);

    // If a product is short, undo only the stock changes made so far; the
    // processed_events row and the stock.failed event still commit.
    await m.query('SAVEPOINT reserve');
    let short: Line | undefined;
    for (const line of lines) {
      // Check and subtract in one statement, under the row lock. A separate
      // SELECT then UPDATE would let two orders both see the last item.
      const res = await m
        .createQueryBuilder()
        .update(Stock)
        .set({
          available: () => 'available - :qty',
          reserved: () => 'reserved + :qty',
        })
        .where('product_id = :id AND available >= :qty', {
          id: line.productId,
          qty: line.quantity,
        })
        .execute();
      if (res.affected !== 1) {
        short = line;
        break;
      }
    }

    if (short) {
      await m.query('ROLLBACK TO SAVEPOINT reserve');
      // No stock row means never stocked: 0 available.
      const stock = await m
        .getRepository(Stock)
        .findOneBy({ productId: short.productId });
      await this.outbox.add<StockFailedV1>(m, {
        aggregateType: 'order',
        aggregateId: order.orderId,
        eventType: InventoryEvents.FAILED,
        correlationId,
        data: {
          orderId: order.orderId,
          reason: 'OUT_OF_STOCK',
          items: [
            {
              productId: short.productId,
              requested: short.quantity,
              available: stock?.available ?? 0,
            },
          ],
        },
      });
      this.logger.warn(
        `Order ${order.orderId}: out of stock for ${short.productId}`,
      );
      return;
    }
    await m.query('RELEASE SAVEPOINT reserve');

    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
    await m.getRepository(Reservation).insert(
      lines.map((l) => ({
        orderId: order.orderId,
        productId: l.productId,
        quantity: l.quantity,
        status: ReservationStatus.RESERVED,
        expiresAt,
      })),
    );
    await this.outbox.add<StockReservedV1>(m, {
      aggregateType: 'order',
      aggregateId: order.orderId, // same key, same partition as the order's other events
      eventType: InventoryEvents.RESERVED,
      correlationId,
      data: { orderId: order.orderId, items: lines },
    });
    this.logger.log(
      `Order ${order.orderId}: reserved ${lines.length} product(s)`,
    );
  }
}

/**
 * Adds up repeated products, then sorts by id. Every transaction locks stock
 * rows in the same order, so two orders can't each hold one row the other
 * needs (deadlock).
 */
function mergeAndSort(items: Line[]): Line[] {
  const qty = new Map<string, number>();
  for (const i of items) {
    qty.set(i.productId, (qty.get(i.productId) ?? 0) + i.quantity);
  }
  return [...qty]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => (a.productId < b.productId ? -1 : 1));
}
