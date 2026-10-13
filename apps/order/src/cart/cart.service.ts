import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Product } from '@app/proto';
import { CatalogClient } from '../catalog/catalog.client';
import { CouponResult, CouponsService } from '../coupons/coupons.service';
import { CartRepository, MAX_ITEMS } from './cart.repository';

export interface CartLine {
  productId: string;
  qty: number;
  name?: string;
  category?: string;
  unitPricePaise?: number;
  lineTotalPaise?: number;
  /** false when the product was removed or deactivated since it was added. */
  available: boolean;
}

interface PricedCart {
  items: CartLine[];
  itemCount: number;
  subtotalPaise: number | null; // null when prices could not be loaded
  pricingAvailable: boolean;
}

export interface CartView extends PricedCart {
  coupon: CouponResult | null;
  discountPaise: number;
  totalPaise: number | null;
}

// The cart stores only productId → qty. Prices always come live from the
// product service, which owns them.
@Injectable()
export class CartService {
  constructor(
    private readonly repo: CartRepository,
    private readonly catalog: CatalogClient,
    private readonly coupons: CouponsService,
  ) {}

  async addItem(userId: string, productId: string, qty: number, cid?: string) {
    // Only add real, active products. Fails with 503 if we can't check.
    const found = await this.catalog.getByIds([productId], cid);
    if (!found.has(productId)) throw new NotFoundException('Product not found');

    const newQty = await this.repo.addItem(userId, productId, qty);
    if (newQty === -1) {
      throw new BadRequestException(
        `Cart can have at most ${MAX_ITEMS} different items`,
      );
    }
    return this.getCart(userId, cid);
  }

  async updateQty(
    userId: string,
    productId: string,
    qty: number,
    cid?: string,
  ) {
    if (!(await this.repo.setQty(userId, productId, qty))) {
      throw new NotFoundException('Item not in cart');
    }
    return this.getCart(userId, cid);
  }

  async removeItem(userId: string, productId: string, cid?: string) {
    await this.repo.removeItem(userId, productId);
    return this.getCart(userId, cid);
  }

  async applyCoupon(userId: string, code: string, cid?: string) {
    const cart = await this.getPricedCart(userId, cid);
    if (cart.subtotalPaise === null) {
      throw new ServiceUnavailableException('Cannot apply a coupon right now');
    }
    const { code: normalised } = await this.coupons.assertApplicable(
      code,
      userId,
      cart.items,
      cart.subtotalPaise,
    );
    await this.repo.setCoupon(userId, normalised);
    return this.getCart(userId, cid);
  }

  async removeCoupon(userId: string, cid?: string) {
    await this.repo.setCoupon(userId, null);
    return this.getCart(userId, cid);
  }

  /** Items with live prices, plus the applied coupon and the totals. */
  async getCart(userId: string, cid?: string): Promise<CartView> {
    const [cart, code] = await Promise.all([
      this.getPricedCart(userId, cid),
      this.repo.getCoupon(userId),
    ]);

    // The coupon is re-checked on every read: the cart may have changed
    // since it was applied. If it no longer qualifies, the cart still loads
    // and says why.
    let coupon: CouponResult | null = null;
    if (code && cart.subtotalPaise === null) {
      coupon = {
        code,
        applied: false,
        discountPaise: 0,
        reason: 'Prices are unavailable right now',
      };
    } else if (code && cart.subtotalPaise !== null) {
      coupon = await this.coupons.evaluate(
        code,
        userId,
        cart.items,
        cart.subtotalPaise,
      );
    }
    const discountPaise = coupon?.applied ? coupon.discountPaise : 0;

    return {
      ...cart,
      coupon,
      discountPaise,
      totalPaise:
        cart.subtotalPaise === null ? null : cart.subtotalPaise - discountPaise,
    };
  }

  private async getPricedCart(
    userId: string,
    cid?: string,
  ): Promise<PricedCart> {
    const items = await this.repo.getItems(userId);
    const ids = Object.keys(items);

    let products: Map<string, Product> | null = null;
    try {
      products = await this.catalog.getByIds(ids, cid);
    } catch (err) {
      if (!(err instanceof ServiceUnavailableException)) throw err;
      // Graceful degradation: still show the cart, just without prices.
    }

    const lines = ids.map((id): CartLine => {
      const qty = items[id];
      if (!products) return { productId: id, qty, available: true };
      const p = products.get(id);
      if (!p) return { productId: id, qty, available: false };
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

    return {
      items: lines,
      itemCount: lines.reduce((n, l) => n + l.qty, 0),
      subtotalPaise: products
        ? lines.reduce((sum, l) => sum + (l.lineTotalPaise ?? 0), 0)
        : null,
      pricingAvailable: products !== null,
    };
  }
}
