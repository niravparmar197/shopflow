import type { CartLine } from '../../cart/cart.service';
import type { Coupon } from '../coupon.entity';

/**
 * What the rules need to know about past orders. They depend on this
 * interface, not on the orders table (Dependency Inversion).
 */
export interface OrderHistory {
  countPlacedOrders(userId: string): Promise<number>;
}

export interface CouponContext {
  coupon: Coupon;
  userId: string;
  lines: CartLine[]; // only available, priced lines
  subtotalPaise: number;
  now: Date;
  // Per call, not per rule: at checkout it must read through the transaction.
  history: OrderHistory;
}

/** A rule said no. The message is safe to show to the customer. */
export class CouponRejected extends Error {}

/**
 * Chain of Responsibility: each rule runs its own check, then hands over to
 * the next one. A new rule is a new class plus one line where the chain is
 * built; no existing rule changes.
 */
export abstract class CouponRule {
  private next?: CouponRule;

  /** Returns the rule passed in, so calls chain: a.setNext(b).setNext(c). */
  setNext(rule: CouponRule): CouponRule {
    this.next = rule;
    return rule;
  }

  async validate(ctx: CouponContext): Promise<void> {
    await this.check(ctx); // throws CouponRejected to stop the chain
    await this.next?.validate(ctx);
  }

  protected abstract check(ctx: CouponContext): Promise<void> | void;
}
