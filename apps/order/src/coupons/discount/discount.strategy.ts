import { Coupon, CouponType } from '../coupon.entity';

/**
 * Strategy: one class per way of computing a discount. A new coupon type is
 * a new class plus one entry in STRATEGIES; no if/else grows.
 */
export interface DiscountStrategy {
  /** eligiblePaise is what the coupon applies to. Returns paise, never more than that. */
  calculate(eligiblePaise: number, coupon: Coupon): number;
}

export class PercentDiscount implements DiscountStrategy {
  calculate(eligiblePaise: number, coupon: Coupon) {
    // Round down so we never give away a fraction of a paisa extra.
    const raw = Math.floor((eligiblePaise * coupon.value) / 100);
    return coupon.maxDiscountPaise === null
      ? raw
      : Math.min(raw, coupon.maxDiscountPaise);
  }
}

export class FlatDiscount implements DiscountStrategy {
  calculate(eligiblePaise: number, coupon: Coupon) {
    return Math.min(coupon.value, eligiblePaise); // total never goes below zero
  }
}

const STRATEGIES: Record<CouponType, DiscountStrategy> = {
  [CouponType.PERCENT]: new PercentDiscount(),
  [CouponType.FLAT]: new FlatDiscount(),
};

/** Small factory: the strategy for a coupon type. */
export const discountFor = (type: CouponType): DiscountStrategy =>
  STRATEGIES[type];
