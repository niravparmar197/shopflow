import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '@app/common';
import { flashGate } from '../metrics';

export type AcquireResult =
  'OK' | 'NOT_FLASH' | 'SOLD_OUT' | 'ALREADY_BOUGHT' | 'LIMIT';

// ONE atomic step: sale on? within the per-user limit? bought already?
// enough left? → take it + remember the buyer. The buyer set expires with
// the sale.
const ACQUIRE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NOT_FLASH', -1} end
local qty = tonumber(ARGV[2])
if qty > tonumber(redis.call('HGET', KEYS[1], 'max')) then return {'LIMIT', -1} end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return {'ALREADY_BOUGHT', -1} end
local left = tonumber(redis.call('HGET', KEYS[1], 'left'))
if left < qty then return {'SOLD_OUT', left} end
left = redis.call('HINCRBY', KEYS[1], 'left', -qty)
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], redis.call('PTTL', KEYS[1]))
return {'OK', left}
`;

// Back on sale ONLY if this user really holds a token (SREM == 1), so a
// second release (redelivery, retry) changes nothing. -1 = no sale (ended),
// -2 = this user holds no token.
const RELEASE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('SREM', KEYS[2], ARGV[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], 'left', tonumber(ARGV[2]))
end
return -2
`;

// Create the sale in one step (an acquire never sees it half-made). 0 = one
// is already running: restarting would forget who bought, so they could
// buy again.
const START_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('DEL', KEYS[2])
redis.call('HSET', KEYS[1], 'left', ARGV[1], 'total', ARGV[1], 'max', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[4])
return 1
`;

const ACTIVE = 'inv:flash:active';

/**
 * The flash-sale GATE: a Redis counter that says no to the losers in ~1 ms,
 * before any order exists. Inventory owns it (stock is its data); order
 * only asks. It's a fast PRE-check: if it drifts (a lost release, a crash),
 * it undersells a little. The DB's atomic reserve stays the final judge, so
 * it never oversells.
 */
@Injectable()
export class FlashSaleService {
  private readonly logger = new Logger(FlashSaleService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly ds: DataSource,
  ) {}

  private keys(productId: string) {
    return {
      sale: `inv:flash:${productId}`,
      buyers: `inv:flash:${productId}:buyers`,
    };
  }

  async start(
    productId: string,
    quantity: number,
    durationMinutes: number,
    maxPerUser = 1,
  ) {
    const [row] = await this.ds.query<{ available: number }[]>(
      'SELECT available FROM stock WHERE product_id = $1',
      [productId],
    );
    if (!row || row.available < quantity) {
      throw new BadRequestException({
        code: 'NOT_ENOUGH_STOCK',
        message: 'The sale quantity must be ≤ the available stock',
        details: { available: row?.available ?? 0 },
      });
    }
    const k = this.keys(productId);
    const created = await this.redis.eval(
      START_LUA,
      3,
      k.sale,
      k.buyers,
      ACTIVE,
      String(quantity),
      String(maxPerUser),
      String(durationMinutes * 60), // the sale ends by itself
      productId,
    );
    if (created !== 1) {
      throw new ConflictException({
        code: 'SALE_ACTIVE',
        message:
          'A flash sale is already running for this product. End it first.',
      });
    }
    this.logger.warn(
      `Flash sale started: ${productId}, ${quantity} unit(s), ${durationMinutes} min`,
    );
    return this.status(productId);
  }

  async end(productId: string) {
    const k = this.keys(productId);
    await this.redis
      .multi()
      .del(k.sale, k.buyers)
      .srem(ACTIVE, productId)
      .exec();
    this.logger.warn(`Flash sale ended: ${productId}`);
  }

  async status(productId: string) {
    const k = this.keys(productId);
    const [sale, buyers, ttl] = await Promise.all([
      this.redis.hgetall(k.sale),
      this.redis.scard(k.buyers),
      this.redis.ttl(k.sale),
    ]);
    if (sale.left === undefined) return { productId, active: false };
    return {
      productId,
      active: true,
      left: Number(sale.left),
      total: Number(sale.total),
      maxPerUser: Number(sale.max),
      buyers,
      endsInSec: ttl,
    };
  }

  /** Every live sale with units left and time left (public page, P5). */
  async activeSales() {
    const ids = await this.activeProductIds();
    const all = await Promise.all(ids.map((id) => this.status(id)));
    return all
      .filter((s) => s.active)
      .map((s) => ({
        productId: s.productId,
        left: s.left!,
        total: s.total!,
        maxPerUser: s.maxPerUser!,
        endsInSec: s.endsInSec!,
      }))
      .sort((a, b) => a.endsInSec - b.endsInSec); // ending soonest first
  }

  /** Products on sale right now (also drops sales that expired). */
  async activeProductIds(): Promise<string[]> {
    const ids = await this.redis.smembers(ACTIVE);
    const alive = await Promise.all(
      ids.map((id) => this.redis.exists(this.keys(id).sale)),
    );
    const dead = ids.filter((_, i) => !alive[i]);
    if (dead.length) await this.redis.srem(ACTIVE, ...dead);
    return ids.filter((_, i) => alive[i]);
  }

  async acquire(productId: string, userId: string, quantity: number) {
    const k = this.keys(productId);
    const [result, left] = (await this.redis.eval(
      ACQUIRE_LUA,
      2,
      k.sale,
      k.buyers,
      userId,
      String(quantity),
    )) as [AcquireResult, number];
    flashGate.inc({ result });
    return { result, left };
  }

  /** Idempotent: gives a unit back only if this user holds a token. */
  async release(productId: string, userId: string, quantity: number) {
    const k = this.keys(productId);
    const left = (await this.redis.eval(
      RELEASE_LUA,
      2,
      k.sale,
      k.buyers,
      userId,
      String(quantity),
    )) as number;
    if (left >= 0) {
      this.logger.log(`Flash token returned: ${productId} (${left} left)`);
    }
    return left >= 0;
  }
}
