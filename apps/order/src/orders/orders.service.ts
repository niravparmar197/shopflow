import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderView } from '../read-model/order-view.entity';
import { Order } from './order.entity';
import { OrderStatus } from './order-status';

const MAX_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where the previous page ended. The timestamp is Postgres' own text with
// microseconds: a JS Date keeps only milliseconds, and rounding would skip
// orders created in the same millisecond.
interface Cursor {
  t: string; // placed_at (the order's created_at)
  id: string; // tie-breaker for equal timestamps
}

// One row of the "My orders" query (raw SQL, snake_case).
interface ListRow {
  id: string;
  status: string;
  payment_status: string | null;
  title: string | null;
  item_count: number | null;
  total_paise: number;
  currency: string;
  placed_at: Date;
  syncing: boolean;
  cursor_t: string;
}

// One row of the admin "all orders" query (raw SQL, snake_case).
interface AdminListRow {
  id: string;
  user_id: string;
  customer_email: string | null;
  status: string;
  payment_status: string | null;
  title: string | null;
  item_count: number | null;
  total_paise: number;
  currency: string;
  created_at: Date;
  cursor_t: string;
}

const STEP_LABELS: Record<string, string> = {
  PLACED: 'Order placed',
  CONFIRMED: 'Items reserved for you',
  PAYMENT_RECEIVED: 'Payment received',
  PAID: 'Order confirmed',
  FAILED: 'Order could not be placed',
  CANCELLED: 'Order cancelled',
  REFUNDED: 'Refund issued',
};

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
    @InjectRepository(OrderView) private readonly views: Repository<OrderView>,
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

  /**
   * "My orders" from the READ MODEL (order_views): title, payment status…
   * with no join and no call to the payment service.
   *
   * READ-YOUR-WRITES: the view is ~100 ms – 1 s behind, so orders placed in
   * the last 30 s that it hasn't caught up with come from the write model
   * (syncing: true, fewer details). Both sources are paged together with
   * one cursor on (placed_at, id), so the limit and the cursor stay right.
   */
  async listMine(userId: string, limit: number, cursor?: string) {
    const take = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const after = cursor ? decodeCursor(cursor) : null;

    const rows: ListRow[] = await this.orders.query(
      `SELECT x.*, to_char(x.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t
         FROM (
           SELECT v.order_id AS id, v.status, v.payment_status, v.title, v.item_count,
                  v.total_paise, v.currency, v.placed_at, false AS syncing
             FROM order_views v
            WHERE v.user_id = $1 AND v.placed_at IS NOT NULL
           UNION ALL
           SELECT o.id, o.status, NULL::varchar, NULL::varchar, NULL::int,
                  o.total_paise, o.currency, o.created_at, true
             FROM orders o
            WHERE o.user_id = $1 AND o.created_at > now() - interval '30 seconds'
              AND NOT EXISTS (SELECT 1 FROM order_views v
                               WHERE v.order_id = o.id AND v.placed_at IS NOT NULL)
         ) x
        WHERE $2::timestamptz IS NULL OR (x.placed_at, x.id) < ($2::timestamptz, $3::uuid)
        ORDER BY x.placed_at DESC, x.id DESC
        LIMIT $4`,
      [userId, after?.t ?? null, after?.id ?? null, take + 1], // one extra: is there a next page?
    );
    const hasMore = rows.length > take;
    const page = rows.slice(0, take);

    return {
      items: page.map((r) => ({
        id: r.id,
        status: r.status,
        paymentStatus: r.payment_status,
        title: r.title,
        itemCount: r.item_count,
        totalPaise: r.total_paise,
        currency: r.currency,
        createdAt: r.placed_at,
        syncing: r.syncing, // the UI can show "updating…"
      })),
      nextCursor: hasMore
        ? encodeCursor({ t: page[take - 1].cursor_t, id: page[take - 1].id })
        : null,
    };
  }

  /**
   * ADMIN: every customer's orders, newest first, optionally one status.
   * The status comes from the write model (always current: an admin acts on
   * it); title / payment status / item count come from the read model when it
   * has caught up. Same (created_at, id) cursor as "My orders".
   */
  async listAll(limit: number, cursor?: string, status?: OrderStatus) {
    const take = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const after = cursor ? decodeCursor(cursor) : null;

    const rows: AdminListRow[] = await this.orders.query(
      `SELECT o.id, o.user_id, o.customer_email, o.status, v.payment_status, v.title,
              COALESCE(v.item_count,
                       (SELECT SUM(i.quantity)::int FROM order_items i WHERE i.order_id = o.id)) AS item_count,
              o.total_paise, o.currency, o.created_at,
              to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t
         FROM orders o
         LEFT JOIN order_views v ON v.order_id = o.id
        WHERE ($1::varchar IS NULL OR o.status = $1)
          AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid))
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $4`,
      [status ?? null, after?.t ?? null, after?.id ?? null, take + 1],
    );
    const hasMore = rows.length > take;
    const page = rows.slice(0, take);

    return {
      items: page.map((r) => ({
        id: r.id,
        userId: r.user_id,
        customerEmail: r.customer_email,
        status: r.status,
        paymentStatus: r.payment_status,
        title: r.title,
        itemCount: r.item_count,
        totalPaise: r.total_paise,
        currency: r.currency,
        createdAt: r.created_at,
      })),
      nextCursor: hasMore
        ? encodeCursor({ t: page[take - 1].cursor_t, id: page[take - 1].id })
        : null,
    };
  }

  /** ADMIN: any order with its items (write model). */
  async findAny(id: string): Promise<Order> {
    const order = await this.orders.findOne({
      where: { id },
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

  /** The order's timeline, built from events of order AND payment. */
  async tracking(userId: string, orderId: string) {
    // user_id in the query: someone else's order is "not found" (IDOR).
    const v = await this.views.findOneBy({ orderId, userId });
    if (!v?.placedAt) {
      // Not projected yet: the write model is strongly consistent, with
      // less detail. findMine throws the 404 for others' orders.
      const o = await this.findMine(userId, orderId);
      return {
        orderId,
        status: o.status,
        paymentStatus: null,
        failureReason: o.failureReason,
        title: null,
        totalPaise: o.totalPaise,
        currency: o.currency,
        syncing: true,
        timeline: [
          {
            step: 'PLACED',
            label: STEP_LABELS.PLACED,
            at: o.createdAt.toISOString(),
            reason: null,
          },
        ],
      };
    }
    // Sorted by event time: events from two topics are stored in arrival order.
    const timeline = [...v.timeline]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((t) => ({
        step: t.step,
        label: STEP_LABELS[t.step] ?? t.step,
        at: t.at,
        reason: t.reason ?? null,
      }));
    return {
      orderId,
      status: v.status,
      paymentStatus: v.paymentStatus,
      failureReason: v.failureReason,
      title: v.title,
      totalPaise: v.totalPaise,
      currency: v.currency,
      syncing: false,
      timeline,
    };
  }
}
