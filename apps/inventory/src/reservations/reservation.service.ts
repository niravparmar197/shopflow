import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import type { Env } from '@app/common';
import {
  InventoryEvents,
  type OrderCreatedV1,
  type StockFailedV1,
  type StockReleasedV1,
  type StockReservedV1,
} from '@app/events';
import { OutboxService } from '@app/kafka';
import { Stock } from '../stock/stock.entity';
import { Reservation, ReservationStatus } from './reservation.entity';

interface Line {
  productId: string;
  quantity: number;
}

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);
  private readonly holdMinutes: number;

  constructor(
    private readonly outbox: OutboxService,
    config: ConfigService<Env, true>,
  ) {
    // MUST be longer than an order's max life (10 + 30 min), or we could
    // release stock for an order that can still be paid, and oversell.
    // (It was 15 min before F8: that was exactly this bug.)
    this.holdMinutes = config.get('RESERVATION_HOLD_MINUTES', { infer: true });
  }

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

    const expiresAt = new Date(Date.now() + this.holdMinutes * 60_000);
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

  /** order.paid → the items are really sold: reserved goes down, available stays. */
  async commit(m: EntityManager, orderId: string) {
    const lines = await this.moveReservations(
      m,
      orderId,
      ReservationStatus.COMMITTED,
    );
    if (lines.length === 0) {
      // Never happens while the timing contract holds. If it does, the hold
      // ended before the payment and the stock may be sold twice: a human
      // must look. (F10 turns this into a metric + alert.)
      this.logger.error(
        `ALERT: order ${orderId} is PAID but has no RESERVED reservation (released early?). Check its stock by hand.`,
      );
      return;
    }
    for (const l of lines) {
      await m
        .createQueryBuilder()
        .update(Stock)
        .set({ reserved: () => 'reserved - :qty' })
        .where('product_id = :id', { id: l.productId, qty: l.quantity })
        .execute();
    }
    this.logger.log(
      `Order ${orderId}: committed ${lines.length} reservation(s)`,
    );
  }

  /** order.cancelled → COMPENSATION: the stock goes back on sale. */
  async release(m: EntityManager, orderId: string) {
    const lines = await this.moveReservations(
      m,
      orderId,
      ReservationStatus.RELEASED,
    );
    await this.putBack(m, lines);
    this.logger.log(
      `Order ${orderId}: released ${lines.length} reservation(s)`,
    );
  }

  /**
   * The SAFETY NET (ReservationExpiryJob): holds past expires_at that no
   * order.paid / order.cancelled ever settled go back on sale, with a
   * stock.released audit event per order. Returns how many holds.
   */
  async releaseExpired(m: EntityManager, batch: number): Promise<number> {
    // SKIP LOCKED: another pod's batch, or a consumer releasing the same
    // order right now, keeps its rows; we take others.
    const rows = await m.query<
      { id: string; orderId: string; productId: string; quantity: number }[]
    >(
      `SELECT id, order_id AS "orderId", product_id AS "productId", quantity
         FROM reservations
        WHERE status = $1 AND expires_at < now()
        ORDER BY expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [ReservationStatus.RESERVED, batch],
    );
    if (rows.length === 0) return 0;

    await m
      .createQueryBuilder()
      .update(Reservation)
      .set({ status: ReservationStatus.RELEASED })
      .whereInIds(rows.map((r) => r.id))
      .execute();
    await this.putBack(m, mergeAndSort(rows));

    const perOrder = new Map<string, Line[]>();
    for (const r of rows) {
      const lines = perOrder.get(r.orderId) ?? [];
      lines.push({ productId: r.productId, quantity: r.quantity });
      perOrder.set(r.orderId, lines);
    }
    for (const [orderId, items] of perOrder) {
      // An AUDIT event: no consumer yet. It records WHY stock moved; F10
      // counts "holds released by timeout": a jump means trouble upstream.
      await this.outbox.add<StockReleasedV1>(m, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: InventoryEvents.RELEASED,
        data: { orderId, reason: 'HOLD_EXPIRED', items },
      });
    }
    this.logger.warn(
      `Released ${rows.length} expired hold(s) for ${perOrder.size} order(s)`,
    );
    return rows.length;
  }

  /** Back on sale. `lines` must be sorted (the shared lock order). */
  private async putBack(m: EntityManager, lines: Line[]) {
    for (const l of lines) {
      await m
        .createQueryBuilder()
        .update(Stock)
        .set({
          available: () => 'available + :qty',
          reserved: () => 'reserved - :qty',
        })
        .where('product_id = :id', { id: l.productId, qty: l.quantity })
        .execute();
    }
  }

  /**
   * Only rows still RESERVED move, so even a DIFFERENT event (not just a
   * redelivery, which processed_events already skips) can't commit or
   * release the same reservation twice: it finds 0 rows.
   */
  private async moveReservations(
    m: EntityManager,
    orderId: string,
    to: ReservationStatus.COMMITTED | ReservationStatus.RELEASED,
  ): Promise<Line[]> {
    const res = await m
      .createQueryBuilder()
      .update(Reservation)
      .set({ status: to })
      .where('order_id = :orderId AND status = :s', {
        orderId,
        s: ReservationStatus.RESERVED,
      })
      // A string, not an array: array entries are matched to entity
      // properties, and an unknown one ('product_id') is silently dropped.
      .returning('product_id AS "productId", quantity')
      .execute();
    // Same lock order as reserveForOrder → no deadlocks between them.
    return sortLines(res.raw as Line[]);
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
  return sortLines(
    [...qty].map(([productId, quantity]) => ({ productId, quantity })),
  );
}

const sortLines = (lines: Line[]) =>
  lines.sort((a, b) => (a.productId < b.productId ? -1 : 1));
