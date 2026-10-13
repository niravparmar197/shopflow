import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Product } from '@app/proto';
import { CatalogClient } from '../catalog/catalog.client';
import { CartRepository, MAX_ITEMS } from './cart.repository';

export interface CartLine {
  productId: string;
  qty: number;
  name?: string;
  unitPricePaise?: number;
  lineTotalPaise?: number;
  /** false when the product was removed or deactivated since it was added. */
  available: boolean;
}

export interface CartView {
  items: CartLine[];
  itemCount: number;
  subtotalPaise: number | null; // null when prices could not be loaded
  pricingAvailable: boolean;
}

// The cart stores only productId → qty. Prices always come live from the
// product service, which owns them.
@Injectable()
export class CartService {
  constructor(
    private readonly repo: CartRepository,
    private readonly catalog: CatalogClient,
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

  async getCart(userId: string, cid?: string): Promise<CartView> {
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
