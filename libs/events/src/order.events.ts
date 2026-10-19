import { z } from 'zod';

export const OrderEvents = {
  CREATED: 'order.created',
  CONFIRMED: 'order.confirmed', // stock reserved; Payment listens to this (F6)
  FAILED: 'order.failed',
  PAID: 'order.paid', // Inventory commits the reservation (reserved → sold)
  CANCELLED: 'order.cancelled', // Inventory releases stock; Payment refunds if paid
  SHIPPED: 'order.shipped', // admin handed it to the courier (Phase 2)
  DELIVERED: 'order.delivered', // the customer has it (Phase 2)
} as const;

const OrderItem = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  // Added later, so optional (still v1): the order read model shows
  // "Phone + 2 more" without asking the product service.
  name: z.string().optional(),
});

export const OrderCreatedV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  items: z.array(OrderItem).min(1),
  totalPaise: z.number().int().nonnegative(),
  currency: z.string().length(3),
  // Added later. OPTIONAL, so it's still version 1: old events still parse
  // and old consumers ignore it. (A required, renamed or removed field
  // would need version 2, with consumers accepting [1, 2] for a while.)
  customerEmail: z.email().optional(),
});
export type OrderCreatedV1 = z.infer<typeof OrderCreatedV1Schema>;

// Order owns the order status, so downstream services follow these rather
// than stock.* (e.g. never charge for an order that was already cancelled).
export const OrderConfirmedV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  totalPaise: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type OrderConfirmedV1 = z.infer<typeof OrderConfirmedV1Schema>;

export const OrderFailedV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  reason: z.string().min(1),
});
export type OrderFailedV1 = z.infer<typeof OrderFailedV1Schema>;

export const OrderPaidV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  totalPaise: z.number().int().nonnegative(),
});
export type OrderPaidV1 = z.infer<typeof OrderPaidV1Schema>;

export const OrderCancelledV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  reason: z.string().min(1), // PAYMENT_TIMEOUT, CARD_DECLINED, USER_CANCELLED, ADMIN_CANCELLED…
});
export type OrderCancelledV1 = z.infer<typeof OrderCancelledV1Schema>;

// Fulfilment (Phase 2). The read model adds the steps to the timeline and
// the notification service emails the customer. No compensation: a shipped
// order can't be cancelled (the state machine refuses).
export const OrderShippedV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
});
export type OrderShippedV1 = z.infer<typeof OrderShippedV1Schema>;

export const OrderDeliveredV1Schema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
});
export type OrderDeliveredV1 = z.infer<typeof OrderDeliveredV1Schema>;
