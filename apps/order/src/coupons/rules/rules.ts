import { CouponContext, CouponRejected, CouponRule } from './coupon-rule';

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export class ActiveRule extends CouponRule {
  protected check({ coupon }: CouponContext) {
    if (!coupon.isActive) throw new CouponRejected('Coupon is not active');
  }
}

export class DateWindowRule extends CouponRule {
  protected check({ coupon, now }: CouponContext) {
    if (now < coupon.validFrom) {
      throw new CouponRejected('Coupon is not valid yet');
    }
    if (now > coupon.validTo) throw new CouponRejected('Coupon has expired');
  }
}

export class UsageLimitRule extends CouponRule {
  protected check({ coupon }: CouponContext) {
    // Soft check for a friendly message. Two orders could both pass it, so
    // the real, atomic check happens when the order is placed (F4).
    if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
      throw new CouponRejected('Coupon usage limit reached');
    }
  }
}

export class MinCartRule extends CouponRule {
  protected check({ coupon, subtotalPaise }: CouponContext) {
    if (subtotalPaise < coupon.minCartPaise) {
      throw new CouponRejected(
        `Add items worth ${rupees(coupon.minCartPaise - subtotalPaise)} more to use this coupon`,
      );
    }
  }
}

export class CategoryRule extends CouponRule {
  protected check({ coupon, lines }: CouponContext) {
    if (coupon.category && !lines.some((l) => l.category === coupon.category)) {
      throw new CouponRejected(`Coupon is only for ${coupon.category}`);
    }
  }
}

export class FirstOrderRule extends CouponRule {
  protected async check({ coupon, userId, history }: CouponContext) {
    if (
      coupon.firstOrderOnly &&
      (await history.countPlacedOrders(userId)) > 0
    ) {
      throw new CouponRejected('Coupon is only for your first order');
    }
  }
}
