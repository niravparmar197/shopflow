import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { IdempotencyKey, IdemStatus } from './idempotency-key.entity';

export type Claim =
  { kind: 'new' } | { kind: 'replay'; status: number; body: unknown };

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
// An IN_PROGRESS key older than this belongs to a request that crashed.
const LEASE = '2 minutes';

const inProgress = () =>
  new ConflictException({
    code: 'IDEMPOTENCY_IN_PROGRESS',
    message: 'This request is still being processed. Try again in a moment.',
  });

// JSON with object keys sorted at every level, so equal bodies hash equally
// whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Idempotency-Key handling: a request runs once per (user, key); retries get
 * the saved response back.
 *
 *   claim()    before the work: new, replay, 409 in progress or 422 reused
 *   complete() inside the work's transaction: the result is saved in the
 *              same commit as the order, so "order exists but the key isn't
 *              done" can't happen
 *   release()  after a failure: the key is freed for a retry
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(IdempotencyKey)
    private readonly keys: Repository<IdempotencyKey>,
  ) {}

  validateKey(key: string | undefined): string {
    if (!key) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required',
      });
    }
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-100 letters, digits, - or _',
      });
    }
    return key;
  }

  hash(body: unknown): string {
    return createHash('sha256')
      .update(canonical(body ?? {}))
      .digest('hex');
  }

  async claim(
    userId: string,
    key: string,
    requestHash: string,
    retried = false,
  ): Promise<Claim> {
    // 1. Try to own the key. The (user_id, key) primary key lets exactly one
    //    of several concurrent inserts win; no lock needed.
    const inserted = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(IdempotencyKey)
      .values({ userId, key, requestHash, status: IdemStatus.IN_PROGRESS })
      .orIgnore() // ON CONFLICT DO NOTHING
      .returning(['key'])
      .execute();
    if ((inserted.raw as unknown[]).length === 1) return { kind: 'new' };

    // 2. Someone has it.
    const row = await this.keys.findOneBy({ userId, key });
    if (!row) {
      // Released between our two queries: try once more.
      if (!retried) return this.claim(userId, key, requestHash, true);
      throw inProgress();
    }
    if (row.requestHash !== requestHash) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was used with a different request body',
      });
    }
    if (row.status === IdemStatus.COMPLETED) {
      return {
        kind: 'replay',
        status: row.responseStatus ?? 200,
        body: row.responseBody,
      };
    }

    // 3. IN_PROGRESS for too long: the first request crashed. Take the
    //    lease over; the conditional UPDATE lets only one taker win.
    const takeover = await this.dataSource
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({ createdAt: () => 'now()' })
      .where('user_id = :userId AND key = :key', { userId, key })
      .andWhere('status = :status', { status: IdemStatus.IN_PROGRESS })
      .andWhere(`created_at < now() - interval '${LEASE}'`)
      .execute();
    if (takeover.affected === 1) return { kind: 'new' };
    throw inProgress();
  }

  /**
   * Inside the checkout transaction. Only succeeds while the key is still
   * IN_PROGRESS: if a slow request and the one that took over its lease both
   * get here, the second one fails and its order rolls back. So a key never
   * produces two orders.
   */
  async complete(
    manager: EntityManager,
    userId: string,
    key: string,
    status: number,
    body: object,
  ) {
    const res = await manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({
        status: IdemStatus.COMPLETED,
        responseStatus: status,
        responseBody: body,
      })
      .where('user_id = :userId AND key = :key', { userId, key })
      .andWhere('status = :inProgress', { inProgress: IdemStatus.IN_PROGRESS })
      .execute();
    if (res.affected !== 1) throw inProgress();
  }

  /**
   * After a failed attempt (nothing was committed): free the key so the
   * client can fix the cart and retry with it. Only successes are kept.
   */
  async release(userId: string, key: string) {
    await this.keys.delete({ userId, key, status: IdemStatus.IN_PROGRESS });
  }
}
