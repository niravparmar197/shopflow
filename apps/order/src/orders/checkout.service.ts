import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource, EntityManager } from 'typeorm';
import { OrderEvents, type OrderCreatedV1 } from '@app/events';
import { OutboxService } from '@app/kafka';
import { CartRepository } from '../cart/cart.repository';
import type { CartLine } from '../cart/cart.service';
import { CatalogClient } from '../catalog/catalog.client';
import { CouponsService } from '../coupons/coupons.service';
import { FlashGateClient } from '../flash/flash-gate.client';
import { OrderItem } from './order-item.entity';
import { Order } from './order.entity';
import { OrderStatus } from './order-status';

export interface PlaceOrderInput {
  /** The total the user saw. If prices moved since, we stop and say so. */
  expectedTotalPaise?: number;
}

/** Runs inside the checkout transaction, just before it commits. */
export type BeforeCommit = (m: EntityManager, order: Order) => Promise<void>;

export interface PlaceOrderOptions {
  cid?: string;
  /** Snapshot of the buyer's email, for notifications. */
  customerEmail?: string;
  /**
   * Lets the caller save its own rows in the same commit as the order (the
   * idempotency result). Checkout itself knows nothing about idempotency.
   */
  beforeCommit?: BeforeCommit;
}

// The checkout lock outlives any normal checkout (gRPC 1 s + a short
// transaction); the TTL only matters if the process dies holding it.
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

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
    private readonly flash: FlashGateClient,
  ) {}

  /**
   * One checkout per user at a time, from reading the cart until it is
   * cleared. Without this, a second checkout (another tab, another
   * Idempotency-Key) that read the cart before the first one cleared it
   * would order the same cart again. A second checkout waits its turn and
   * then sees the cart as the first one left it (usually empty).
   */
  async placeOrder(
    userId: string,
    input: PlaceOrderInput,
    options: PlaceOrderOptions = {},
  ): Promise<Order> {
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!(await this.cart.tryLockCheckout(userId, token, LOCK_TTL_MS))) {
      if (Date.now() > deadline) {
        throw new ConflictException({
          code: 'CHECKOUT_IN_PROGRESS',
          message: 'Another checkout is in progress. Try again in a moment.',
        });
      }
      await sleep(LOCK_POLL_MS);
    }
    try {
      return await this.checkoutLocked(userId, input, options);
    } finally {
      await this.cart
        .unlockCheckout(userId, token)
        .catch((err: unknown) =>
          this.logger.warn(
            { err, userId },
            'Releasing the checkout lock failed',
          ),
        );
    }
  }

  private async checkoutLocked(
    userId: string,
    input: PlaceOrderInput,
    { cid, customerEmail, beforeCommit }: PlaceOrderOptions,
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

    // 3. Flash-sale gate, for items on sale right now: a token per item
    //    from inventory, or a fast no (SOLD_OUT…) before any order exists.
    const taken = await this.acquireFlashTokens(userId, lines);

    // 4. One short transaction. Throwing anywhere inside rolls back all of
    //    it, including the coupon use.
    let order: Order;
    try {
      order = await this.dataSource.transaction(async (m) => {
        // Database-level guard for the coupon rules ("first order only"),
        // which doesn't depend on Redis. Released on COMMIT or ROLLBACK.
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);

        const coupon = couponCode
          ? await this.coupons.redeem(
              m,
              couponCode,
              userId,
              lines,
              subtotalPaise,
            )
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
            customerEmail: customerEmail ?? null,
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
        await this.outbox.add<OrderCreatedV1>(m, {
          aggregateType: 'order',
          aggregateId: saved.id,
          eventType: OrderEvents.CREATED,
          correlationId: cid,
          data: {
            orderId: saved.id,
            userId,
            items: lines.map((l) => ({
              productId: l.productId,
              quantity: l.qty,
            })),
            totalPaise,
            currency: 'INR',
            customerEmail,
          },
        });
        await beforeCommit?.(m, saved);
        return saved;
      });
    } catch (err) {
      // No order (PRICE_CHANGED, coupon used up, DB error…): the tokens go
      // back on sale.
      await this.releaseFlashTokens(userId, taken);
      throw err;
    }

    // 5. After the commit; Redis isn't part of the transaction. If this
    //    fails the order still stands, so only log it.
    await this.cart
      .clear(userId)
      .catch((err: unknown) =>
        this.logger.warn({ err, userId }, 'Clearing the cart failed'),
      );
    return order;
  }

  /** Tokens for the cart's flash-sale items; all or none. */
  private async acquireFlashTokens(userId: string, lines: PricedLine[]) {
    const onSale = await this.flash.activeIds();
    const taken: { productId: string; qty: number }[] = [];
    try {
      for (const l of lines.filter((x) => onSale.has(x.productId))) {
        if (await this.flash.acquire(l.productId, userId, l.qty)) {
          taken.push({ productId: l.productId, qty: l.qty });
        }
      }
    } catch (err) {
      // A later item said no: give back the ones already taken.
      await this.releaseFlashTokens(userId, taken);
      throw err;
    }
    return taken;
  }

  private releaseFlashTokens(
    userId: string,
    taken: { productId: string; qty: number }[],
  ) {
    return Promise.all(
      taken.map((t) => this.flash.release(t.productId, userId, t.qty)),
    );
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
