import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '@app/common';

export const MAX_ITEMS = 20; // different products per cart
export const MAX_QTY = 10; // per product
const TTL_SEC = 7 * 24 * 60 * 60;

// Lua scripts run inside Redis as one step, so two tabs adding at once can't
// both pass the "cart is full" check (check-then-act race).

// KEYS[1] cart, ARGV: productId, qty, maxItems, maxQty, ttl.
// Returns the new qty, or -1 if the cart is full.
const ADD_ITEM = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0
  and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
  return -1
end
local qty = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
if qty > tonumber(ARGV[4]) then
  qty = tonumber(ARGV[4])
  redis.call('HSET', KEYS[1], ARGV[1], qty)
end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return qty
`;

// KEYS[1] cart, ARGV: productId, qty, ttl. Only updates an existing line, so
// a concurrent remove can't be undone (or push the cart past the limit).
// Returns 1 if updated, 0 if the item is not in the cart.
const SET_QTY = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

// KEYS[1] lock, ARGV[1] owner token. Deletes the lock only if we still own
// it, so a lock that expired and was taken by someone else isn't removed.
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** The cart lives in a Redis hash cart:{userId} → { productId: qty }. */
@Injectable()
export class CartRepository {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Returns the new qty (capped at MAX_QTY), or -1 if the cart is full. */
  async addItem(userId: string, productId: string, qty: number) {
    const res = await this.redis.eval(
      ADD_ITEM,
      1,
      cartKey(userId),
      productId,
      qty,
      MAX_ITEMS,
      MAX_QTY,
      TTL_SEC,
    );
    return Number(res);
  }

  /** Returns false if the item is not in the cart. */
  async setQty(userId: string, productId: string, qty: number) {
    const res = await this.redis.eval(
      SET_QTY,
      1,
      cartKey(userId),
      productId,
      qty,
      TTL_SEC,
    );
    return Number(res) === 1;
  }

  async removeItem(userId: string, productId: string) {
    await this.redis.hdel(cartKey(userId), productId);
  }

  async getItems(userId: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(cartKey(userId));
    return Object.fromEntries(
      Object.entries(raw).map(([id, qty]) => [id, Number(qty)]),
    );
  }

  async clear(userId: string) {
    await this.redis.del(cartKey(userId), couponKey(userId));
  }

  // The applied coupon code is kept next to the cart, with the same TTL.
  async setCoupon(userId: string, code: string | null) {
    if (code) await this.redis.set(couponKey(userId), code, 'EX', TTL_SEC);
    else await this.redis.del(couponKey(userId));
  }

  getCoupon(userId: string) {
    return this.redis.get(couponKey(userId));
  }

  /** One checkout per cart at a time. Returns false if someone holds it. */
  async tryLockCheckout(userId: string, token: string, ttlMs: number) {
    const res = await this.redis.set(lockKey(userId), token, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async unlockCheckout(userId: string, token: string) {
    await this.redis.eval(RELEASE_LOCK, 1, lockKey(userId), token);
  }
}

const cartKey = (userId: string) => `cart:${userId}`;
const couponKey = (userId: string) => `cart:${userId}:coupon`;
const lockKey = (userId: string) => `cart:${userId}:checkout-lock`;
