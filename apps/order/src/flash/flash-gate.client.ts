import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/common';
import { Bulkhead, BulkheadFullError } from '@app/resilience';

type AcquireResult =
  'OK' | 'NOT_FLASH' | 'SOLD_OUT' | 'ALREADY_BOUGHT' | 'LIMIT';

const TIMEOUT_MS = 500;
const ACTIVE_CACHE_MS = 2_000;

/*
 * The flash-sale gate, seen from order: asks inventory for a token BEFORE
 * an order exists, so the losers get an answer in ~1 ms and cost nothing.
 *
 *   bulkhead (≤ 50 in flight, ≤ 200 waiting) → more: 429 SERVER_BUSY
 *   500 ms timeout on every call
 *   gate down → FAIL OPEN: the DB's atomic reserve still prevents overselling
 */
@Injectable()
export class FlashGateClient {
  private readonly logger = new Logger(FlashGateClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly bulkhead: Bulkhead;
  private cache: { ids: Set<string>; at: number } | null = null;
  private loading?: Promise<Set<string>>;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.getOrThrow('INVENTORY_SERVICE_URL', { infer: true });
    this.token = config.getOrThrow('INTERNAL_API_TOKEN', { infer: true });
    this.bulkhead = new Bulkhead(
      'inventory-flash',
      config.get('FLASH_BULKHEAD_MAX', { infer: true }),
      config.get('FLASH_BULKHEAD_QUEUE', { infer: true }),
    );
  }

  /**
   * Products on sale now, cached 2 s. SINGLE-FLIGHT: 1,000 checkouts at
   * once share one fetch. A failed fetch is cached too (as the last known
   * list), so an inventory outage doesn't add a timeout to every checkout.
   */
  activeIds(): Promise<Set<string>> {
    if (this.cache && Date.now() - this.cache.at < ACTIVE_CACHE_MS) {
      return Promise.resolve(this.cache.ids);
    }
    this.loading ??= this.call<{ productIds: string[] }>(
      'GET',
      '/v1/internal/flash-sales/active',
    )
      .then((r) => new Set(r.productIds))
      .catch((err: Error) => {
        this.logger.warn(
          `Flash-sale list unavailable, using the last known one: ${err.message}`,
        );
        return this.cache?.ids ?? new Set<string>();
      })
      .then((ids) => {
        this.cache = { ids, at: Date.now() };
        return ids;
      })
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  /**
   * true = a token was taken (give it back if the order isn't created);
   * false = nothing taken (not on sale, or the gate is down). Throws for
   * the answers the buyer must see.
   */
  async acquire(
    productId: string,
    userId: string,
    quantity: number,
  ): Promise<boolean> {
    let r: { result: AcquireResult; left: number };
    try {
      r = await this.bulkhead.run(() =>
        this.call<{ result: AcquireResult; left: number }>(
          'POST',
          '/v1/internal/flash-sales/acquire',
          { productId, userId, quantity },
        ),
      );
    } catch (err) {
      if (err instanceof BulkheadFullError) {
        // LOAD SHEDDING: 429, not 5xx. "We're fine, you're early, retry."
        throw new HttpException(
          {
            code: 'SERVER_BUSY',
            message: 'Many shoppers right now. Please try again in a second.',
            details: { retryAfterSec: 1 },
          },
          429,
        );
      }
      this.logger.warn(
        `Flash gate unavailable, failing open: ${(err as Error).message}`,
      );
      return false;
    }

    switch (r.result) {
      case 'OK':
        return true;
      case 'NOT_FLASH':
        return false; // the sale just ended: the normal path
      case 'SOLD_OUT':
        throw new ConflictException({
          code: 'SOLD_OUT',
          message: 'Sold out',
          details: { productId },
        });
      case 'ALREADY_BOUGHT':
        throw new ConflictException({
          code: 'ALREADY_BOUGHT_IN_SALE',
          message: 'Only one per customer in this sale',
          details: { productId },
        });
      case 'LIMIT':
        throw new UnprocessableEntityException({
          code: 'FLASH_LIMIT',
          message: 'Too many units of a sale item in one order',
          details: { productId },
        });
    }
  }

  /** Best effort, never throws: a lost release undersells, never oversells. */
  async release(productId: string, userId: string, quantity: number) {
    await this.call('POST', '/v1/internal/flash-sales/release', {
      productId,
      userId,
      quantity,
    }).catch((err: Error) =>
      this.logger.error(
        `Flash release failed for ${productId}/${userId}: ${err.message}`,
      ),
    );
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-internal-token': this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS), // every outgoing call has one
    });
    if (!res.ok) throw new Error(`inventory ${path} → HTTP ${res.status}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}
