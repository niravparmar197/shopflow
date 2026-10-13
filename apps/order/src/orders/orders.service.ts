import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './order.entity';

const MAX_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where the previous page ended. The timestamp is Postgres' own text with
// microseconds: a JS Date keeps only milliseconds, and rounding would skip
// orders created in the same millisecond.
interface Cursor {
  t: string; // created_at
  id: string; // tie-breaker for equal timestamps
}

const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (typeof c.t === 'string' && !isNaN(Date.parse(c.t)) && UUID.test(c.id)) {
      return c;
    }
  } catch {
    // fall through
  }
  throw new BadRequestException({
    code: 'INVALID_CURSOR',
    message: 'Invalid cursor',
  });
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  /**
   * Filters by id AND owner. Someone else's order is a 404, not a 403, so
   * we don't reveal that it exists (IDOR protection).
   */
  async findMine(userId: string, id: string): Promise<Order> {
    const order = await this.orders.findOne({
      where: { id, userId },
      relations: { items: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });
    }
    return order;
  }

  /** Newest first, cursor on (created_at, id). Uses idx_orders_user_created. */
  async listMine(userId: string, limit: number, cursor?: string) {
    const take = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const qb = this.orders
      .createQueryBuilder('o')
      .addSelect(
        `to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        'cursor_t',
      )
      .where('o.user_id = :userId', { userId })
      .orderBy('o.created_at', 'DESC')
      .addOrderBy('o.id', 'DESC')
      .limit(take + 1); // one extra tells us whether there's a next page

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(o.created_at, o.id) < (:t::timestamptz, :id::uuid)', {
        t,
        id,
      });
    }

    const { entities, raw } = await qb.getRawAndEntities<{
      cursor_t: string;
    }>();
    const hasMore = entities.length > take;
    const page = entities.slice(0, take);

    return {
      items: page.map((o) => ({
        id: o.id,
        status: o.status,
        totalPaise: o.totalPaise,
        currency: o.currency,
        createdAt: o.createdAt,
      })),
      nextCursor: hasMore
        ? encodeCursor({ t: raw[take - 1].cursor_t, id: page[take - 1].id })
        : null,
    };
  }
}
