import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WishlistItem } from '../entities';

export const MAX_WISHLIST = 100;

/** Saved products. The product details come from the catalog (by ids). */
@Injectable()
export class WishlistService {
  constructor(private readonly ds: DataSource) {}

  /** Newest first. */
  list(userId: string) {
    return this.ds.getRepository(WishlistItem).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: MAX_WISHLIST,
    });
  }

  /** Idempotent: saving a saved product changes nothing. */
  async add(userId: string, productId: string) {
    await this.ds.transaction(async (m) => {
      // One user's adds in a row, so the limit holds under races.
      await m.query(
        `SELECT pg_advisory_xact_lock(hashtext('wishlist:' || $1::text))`,
        [userId],
      );
      const repo = m.getRepository(WishlistItem);
      if (await repo.existsBy({ userId, productId })) return;
      if ((await repo.countBy({ userId })) >= MAX_WISHLIST) {
        throw new ConflictException({
          code: 'WISHLIST_FULL',
          message: `You can save up to ${MAX_WISHLIST} products`,
        });
      }
      await repo.insert({ userId, productId });
    });
  }

  /** Idempotent too: removing a product that isn't there is fine. */
  async remove(userId: string, productId: string) {
    await this.ds.getRepository(WishlistItem).delete({ userId, productId });
  }
}
