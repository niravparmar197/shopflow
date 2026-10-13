import { OutboxEvent } from '@app/kafka';
import { Coupon } from '../coupons/coupon.entity';
import { IdempotencyKey } from '../idempotency/idempotency-key.entity';
import { OrderItem } from '../orders/order-item.entity';
import { Order } from '../orders/order.entity';

// Used by both the running service (order.module.ts) and the migration CLI.
export const ORDER_ENTITIES = [
  Coupon,
  Order,
  OrderItem,
  OutboxEvent,
  IdempotencyKey,
];
