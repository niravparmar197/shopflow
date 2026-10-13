import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CartRepository } from '../cart/cart.repository';
import type { CartLine } from '../cart/cart.service';
import { CatalogClient } from '../catalog/catalog.client';
import { CouponsService } from '../coupons/coupons.service';
import { OutboxService } from '../outbox/outbox.service';
import { OrderItem } from './order-item.entity';
import { Order } from './order.entity';
import { OrderStatus } from './order-status';

export interface PlaceOrderInput {
  /** The total the user saw. If prices moved since, we stop and say so. */
  expectedTotalPaise?: number;
}

type PricedLine = Required<Omit<CartLine, 'available'>> & { available: true };

/**
 * Facade: the controller calls placeOrder(); behind it are the cart (Redis),
 * live prices (gRPC), coupons (rules + strategy) and orders + outbox
 * (PostgreSQL).
 *
 * Slow network calls happen before the transaction, so it stays short: a
 * transaction holds a connection and its locks for as long as it runs.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cart: CartRepository,
    private readonly catalog: CatalogClient,
    private readonly coupons: CouponsService,
    private readonly outbox: OutboxService,
  ) {}

  async placeOrder(
    userId: string,
    input: PlaceOrderInput,
    cid?: string,
  ): Promise<Order> {
    // 1. The cart, from Redis.
    const [items, couponCode] = await Promise.all([
      this.cart.getItems(userId),
      this.cart.getCoupon(userId),
    ]);
    if (Object.keys(items).length === 0) {
      throw new UnprocessableEntityException({
        code: 'CART_EMPTY',
        message: 'Your cart is empty',
      });
    }

    // 2. Live prices. No fallback: we never sell at a stale price, so if the
    //    product service is down this fails with 503 (the cart view, in
    //    contrast, degrades).
    const lines = await this.priceLines(items, cid);
    const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

    // 3. One short transaction. Throwing anywhere inside rolls back all of
    //    it, including the coupon use.
    const order = await this.dataSource.transaction(async (m) => {
      // One checkout per user at a time, so two parallel orders can't both
      // pass "first order only". Released on COMMIT or ROLLBACK.
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);

      const coupon = couponCode
        ? await this.coupons.redeem(m, couponCode, userId, lines, subtotalPaise)
        : null;
      const discountPaise = coupon?.discountPaise ?? 0;
      const totalPaise = subtotalPaise - discountPaise;

      if (
        input.expectedTotalPaise !== undefined &&
        input.expectedTotalPaise !== totalPaise
      ) {
        throw new ConflictException({
          code: 'PRICE_CHANGED',
          message: 'Prices changed. Please review your cart.',
          details: { totalPaise },
        });
      }

      const orders = m.getRepository(Order);
      const orderItems = m.getRepository(OrderItem);
      const saved = await orders.save(
        orders.create({
          userId,
          status: OrderStatus.PENDING,
          subtotalPaise,
          discountPaise,
          totalPaise,
          couponCode: coupon?.code ?? null,
          currency: 'INR',
          // Snapshot of name and price as charged.
          items: lines.map((l) =>
            orderItems.create({
              productId: l.productId,
              name: l.name,
              unitPricePaise: l.unitPricePaise,
              quantity: l.qty,
              lineTotalPaise: l.lineTotalPaise,
            }),
          ),
        }),
      );

      // Same commit as the order: both are saved, or neither.
      await this.outbox.add(m, {
        aggregateType: 'order',
        aggregateId: saved.id,
        eventType: 'order.created',
        payload: {
          orderId: saved.id,
          userId,
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: l.qty,
          })),
          totalPaise,
          currency: 'INR',
        },
      });
      return saved;
    });

    // 4. After the commit; Redis isn't part of the transaction. If this
    //    fails the order still stands, so only log it.
    await this.cart
      .clear(userId)
      .catch((err: unknown) =>
        this.logger.warn({ err, userId }, 'Clearing the cart failed'),
      );
    return order;
  }

  private async priceLines(
    items: Record<string, number>,
    cid?: string,
  ): Promise<PricedLine[]> {
    const ids = Object.keys(items);
    const products = await this.catalog.getByIds(ids, cid);

    // Removed or deactivated since they were added to the cart.
    const missing = ids.filter((id) => !products.has(id));
    if (missing.length > 0) {
      throw new ConflictException({
        code: 'CART_ITEM_UNAVAILABLE',
        message: 'Some items are no longer available',
        details: { productIds: missing },
      });
    }

    return ids.map((id) => {
      const p = products.get(id)!;
      const qty = items[id];
      return {
        productId: id,
        qty,
        name: p.name,
        category: p.category,
        unitPricePaise: p.pricePaise,
        lineTotalPaise: p.pricePaise * qty,
        available: true,
      };
    });
  }
}
